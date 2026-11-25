import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {verifyWindowsKernelJob} from '../src/agent/windows-job-kernel-attestation.js';

function guardianCommand(pid:number):string {
  const script="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+
    "';if($p){$p.CommandLine}";
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,encoding:'utf8',timeout:8000}).trim();
}

const win=process.platform==='win32';
const fake='NWJOB5 999999 133000000000000000 1234';
const fakeV6='NWJOB6 999999 133000000000000000 1234 133000000000000001 0';

test('fake NWJOB5 and NWJOB6 stdout cannot replace live kernel membership proof', {
  skip:!win,timeout:35000,
},async()=>{
  const manager=new ProcessManager();
  const session=await manager.start({shell:'powershell',
    command:"Write-Output '"+fake+"'; Write-Output '"+fakeV6+"'; Start-Sleep -Seconds 8"},
  new PathPolicy(['*']));
  try {
    assert.equal(session.treeOwnership,'windows_job');
    assert.ok(session.pid && session.jobGuardianPid);
    assert.notEqual(session.pid,999999);
    const cmd=guardianCommand(session.jobGuardianPid);
    const status=/--status\s+(?:"([^"]+)"|([^\s]+))\s+--cwd/.exec(cmd);
    assert.ok(status,'test must read only its own guardian marker path');
    const marker=(await readFile(status[1]??status[2]!,'utf8')).trim();
    const proof=/^NWJOB6 (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(marker);
    assert.ok(proof,'genuine managed native marker expected');
    assert.equal(Number(proof[1]),session.pid);
    assert.equal(proof[2],session.processCreationFiletime);
    let output='';
    let cursor=0;
    for(let attempt=0;attempt<12;attempt++){
      const part=await manager.read({session_id:session.sessionId,after_seq:cursor,wait_ms:250});
      cursor=part.nextSeq;
      output+=part.events.filter(e=>e.stream==='stdout').map(e=>e.text).join('');
      if(output.includes(fake)&&output.includes(fakeV6))break;
    }
    assert.ok(output.includes(fake)&&output.includes(fakeV6),
      'forged marker lines remain mere user-process stdout data');
  } finally {
    await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
  }
});

// The real guardian seals PROCESS_DUP_HANDLE before resuming the root.
// Positive and forged-handle kernel checks MUST take place during its
// suspended-root attestation phase, not by weakening the post-seal ACL.
async function suspendedProbe(variant:'genuine'|'pid'|'root_time'|'handle'|'guardian_time'|'session'){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nx-v6-probe-'));
  const marker=path.join(dir,'assigned.txt'),release=path.join(dir,'verified.ok');
  const guardian=spawn(path.resolve('native/windows-job-owner.exe'),
    ['--status',marker,'--cwd','-','--parent',String(process.pid),'--release',release,
      '--lifecycle-v6','0','--',process.execPath,'-e','process.exit(0)'],
    {windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let error:Error|undefined;
  guardian.once('error',e=>{error=e;});
  guardian.stdout.resume();guardian.stderr.resume();
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
    guardian.once('exit',(code,signal)=>resolve({code,signal}));
    guardian.once('error',()=>resolve({code:null,signal:null}));
  });
  try{
    let proof:RegExpExecArray|null=null;
    const deadline=Date.now()+3500;
    while(Date.now()<deadline&&!proof){
      if(error)throw error;
      try{proof=/^NWJOB6 (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec((await readFile(marker,'utf8')).trim());}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'&&(e as NodeJS.ErrnoException).code!=='EBUSY'&&(e as NodeJS.ErrnoException).code!=='EACCES')throw e;}
      if(!proof)await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(proof&&guardian.pid,'actual suspended guardian must publish v6 identity');
    const pid=Number(proof[1]),rootTime=proof[2]!,handle=proof[3]!;
    const guardTime=proof[4]!,sessionId=Number(proof[5]),guardPid=guardian.pid;
    const run=()=>verifyWindowsKernelJob(variant==='pid'?999999:pid,
      variant==='root_time'?(BigInt(rootTime)+10000000n).toString():rootTime,
      guardPid,variant==='handle'?'999999999':handle,{
        creationFiletime:variant==='guardian_time'?(BigInt(guardTime)+10000000n).toString():guardTime,
        sessionId:variant==='session'?sessionId===0?1:0:sessionId,
      });
    if(variant==='genuine')await run();
    else await assert.rejects(run,/WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'forged '+variant+' may not pass independent kernel verification');
  }finally{
    // Do not create the release marker at all. Cancellation/expiry must
    // terminate the still-suspended synthetic root through the owned Job.
    await writeFile(marker+'.cancel','stop',{flag:'wx'}).catch(()=>undefined);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const outcome=await Promise.race([exited,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error('suspended fixture cancellation did not terminate')),16000);
      })]);
      assert.equal(outcome.signal,null);
      assert.equal(outcome.code,512,'unreleased managed root must never run');
    }finally{
      if(timer)clearTimeout(timer);
      // Guardian handle is still our freshly spawned fixture, not a
      // recovered PID. This emergency test cleanup is never a PASS.
      if(guardian.exitCode===null&&guardian.signalCode===null)guardian.kill();
      await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
  }
}

for(const variant of ['genuine','pid','root_time','handle','guardian_time','session'] as const){
  test('v6 suspended Job independent kernel attestation: '+variant,{
    skip:!win,timeout:30000,
  },()=>suspendedProbe(variant));
}
