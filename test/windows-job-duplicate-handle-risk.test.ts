import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

interface Proc { ProcessId:number;Name:string;CreationDate:string;CommandLine:string|null }
function exact(pid:number):Proc|undefined {
  const cmd="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+
    "';if($p){$p|Select-Object ProcessId,Name,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}";
  const txt=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],
    {windowsHide:true,encoding:'utf8',timeout:8000}).trim();
  return txt?JSON.parse(txt) as Proc:undefined;
}
async function ready(proc:ChildProcessWithoutNullStreams):Promise<void> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('query fixture timeout')),12000);
    let out='',settled=false;
    const settle=(e?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve()};
    proc.once('error',settle);
    proc.once('exit',code=>settle(new Error('query holder exited '+code)));
    proc.stdout.on('data',(b:Buffer)=>{out+=b.toString('utf8');if(out.includes('NX_DUPLICATED_JOB_QUERY_READY'))settle()});
  });
}

test('synthetic same-user PROCESS_DUP_HANDLE can retain unnamed Job across guardian crash', {
  skip:process.platform!=='win32',timeout:50000,
},async()=>{
  const marker='NX_HANDLE_P0_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const started=await manager.start({shell:'powershell',
    command:'node -e "const marker=\''+marker+'\';setInterval(()=>{},1000)"'},new PathPolicy(['*']));
  let holder:ChildProcessWithoutNullStreams|undefined;
  try {
    assert.equal(started.treeOwnership,'windows_job');
    assert.ok(started.jobGuardianPid && started.pid);
    const guard=exact(started.jobGuardianPid);
    assert.ok(guard?.Name.toLowerCase()==='windows-job-owner.exe' &&
      guard.CommandLine?.includes(marker),'only synthetic guardian may be targeted');
    const statusPath=/--status\s+(?:"([^"]+)"|([^\s]+))\s+--cwd/.exec(guard.CommandLine!);
    assert.ok(statusPath,'guardian status marker path must be present');
    const text=(await readFile(statusPath[1]??statusPath[2]!,'utf8')).trim();
    const nw=/^NWJOB5 (\d+) (\d+) (\d+)$/.exec(text);
    assert.ok(nw && Number(nw[1])===started.pid);
    const root=exact(started.pid);
    assert.ok(root && root.Name.toLowerCase()==='powershell.exe');
    holder=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',
      path.resolve('test/fixtures/windows-job-hold-duplicated-query.ps1'),
      String(guard.ProcessId),nw[3]!],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    await ready(holder);
    assert.equal(exact(guard.ProcessId)?.CreationDate,guard.CreationDate);
    const killed=spawnSync('taskkill.exe',['/PID',String(guard.ProcessId),'/F'],
      {windowsHide:true,timeout:6000,stdio:'ignore'});
    assert.equal(killed.status,0,'exact marker-bound synthetic guardian is only force-killed PID');
    // Security finding: a second query-only kernel Job handle suppresses
    // KILL_ON_JOB_CLOSE even for unnamed jobs. Never call it production PASS.
    const remaining=exact(started.pid);
    assert.equal(remaining?.CreationDate,root.CreationDate,
      'retained read-only Job handle keeps exact synthetic root alive');
    for(let i=0;i<40;i++) {
      if(manager.list().find(x=>x.sessionId===started.sessionId)?.status==='orphaned')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const uncertain=manager.list().find(x=>x.sessionId===started.sessionId);
    assert.equal(uncertain?.status,'orphaned',
      'lost guardian cannot be mistaken for verified completed root');
    assert.equal(uncertain?.treeOwnership,'unconfirmed');
    await assert.rejects(()=>manager.stop({session_id:started.sessionId}),
      (error:unknown)=>error instanceof Error && 'code' in error &&
        error.code==='PROCESS_TREE_TERMINATION_UNCONFIRMED');
    holder.stdin.end('\n');
    await new Promise<void>(resolve=>holder!.once('close',()=>resolve()));
    for(let i=0;i<25;i++) {
      if(!exact(started.pid))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(exact(started.pid),undefined,'closing final query Job handle must reap root');
  } finally {
    if(holder) {
      holder.stdin.end();
      if(holder.exitCode===null)holder.kill(); // only newly spawned fixture process
    }
    await manager.stop({session_id:started.sessionId}).catch(()=>undefined);
  }
});
