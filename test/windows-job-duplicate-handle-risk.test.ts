import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {launchWindowsJob,requestWindowsJobStop} from '../src/agent/windows-job-owner.js';

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

test('native guardian does not advertise token/DACL isolation without actual OS proof', {
  skip:process.platform!=='win32',timeout:10000,
},()=>{
  const probe=spawnSync(path.resolve('native/windows-job-owner.exe'),
    ['--probe-isolation'],
    {windowsHide:true,encoding:'utf8',timeout:7000,maxBuffer:8192});
  const text=(probe.stderr??'')+' '+(probe.stdout??'');
  const groups=execFileSync('whoami.exe',['/groups'],
    {windowsHide:true,encoding:'utf8',timeout:8000});
  const isHigh=/S-1-16-12288\b/.test(groups);
  const elevated=execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command','([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    {encoding:'utf8',windowsHide:true,timeout:8000}).trim()==='True';
  if(!isHigh || !elevated) {
    assert.equal(probe.status,79,'non-elevated token may not get trusted guardian');
    assert.match(text,/guardian_high_token_or_acl_unverified/);
  } else {
    assert.equal(probe.status,0,'verified HIGH guardian denied: '+text);
    assert.match(probe.stdout,/NX_GUARDIAN_HIGH_DACL_PROVISIONAL/);
  }
});

test('same-tier high token remains privileged against high Job guardian; medium cannot launch', {
  skip:process.platform!=='win32',timeout:50000,
},async(t)=>{
  // Independently report the *actual* token tier. A CI runner might run as
  // administrator; never claim its same-user test proves low-privilege access.
  const groups=execFileSync('whoami.exe',['/groups'],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  const isMedium=/S-1-16-8192\b/.test(groups);
  const isHigh=/S-1-16-12288\b/.test(groups);
  const elevated=execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command','([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    {encoding:'utf8',windowsHide:true,timeout:8000}).trim()==='True';
  const lowprivVerified=isMedium && !isHigh && !elevated;
  if (lowprivVerified) {
    // A medium-integrity Agent no longer gets a Job owner or a root at all.
    // Separate real medium attacker -> high guardian evidence is required.
    const manager=new ProcessManager();
    await assert.rejects(
      ()=>manager.start({shell:'powershell', command:'exit 0'},
        new PathPolicy(['*'])),
      /WINDOWS_JOB_LAUNCH_UNCONFIRMED|guardian_high_token_or_acl_unverified|WINDOWS_JOB/,
      'medium-integrity guardian must fail closed before any root can run');
    console.log('NX_GUARD_MEDIUM_FAIL_CLOSED; cross-integrity physical acceptance BLOCKED');
    return;
  }
  if (!isHigh || !elevated) {
    t.skip('caller token is neither verified medium nor elevated high');
    return;
  }
  // This same-HIGH fixture deliberately remains a negative production
  // finding: equal-privilege attackers can still retain Job handles.
  // Never relabel this test as a Medium->High attack or production PASS.
  console.log('NX_JOB_CALLER_TOKEN lowprivVerified='+lowprivVerified+
    ' integrity='+ (isMedium?'medium':isHigh?'high':'unknown')+
    ' elevated='+elevated);
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
    // Known residual high-to-high risk: second query-only handle suppresses
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

test('real UAC-linked medium attacker cannot duplicate HIGH guardian Job handle', {
  skip:process.platform!=='win32',timeout:28000,
},async(t)=>{
  // Hosted runner fixture only. It does NOT verify an installed Broker's
  // token, process ACL, code signing, or physical production acceptance.
  const groups=execFileSync('whoami.exe',['/groups'],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  const isHigh=/S-1-16-12288\b/.test(groups);
  const elevated=execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command','([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    {encoding:'utf8',windowsHide:true,timeout:8000}).trim()==='True';
  if (!isHigh || !elevated) {
    t.skip('BLOCKED: no elevated HIGH caller; cannot create paired real medium attacker');
    return;
  }
  const launch=await launchWindowsJob('powershell.exe',
    ['-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 45'],
    {guardOnParentExit:true});
  try {
    const probe=spawnSync(path.resolve('test/fixtures/windows-job-medium-dup-probe.exe'),
      ['--probe',String(launch.guardianPid)],
      {windowsHide:true,encoding:'utf8',timeout:16000,maxBuffer:8192});
    if (probe.status===77) {
      t.diagnostic('CROSS_INTEGRITY_BLOCKED: '+(probe.stdout??'')+' '+(probe.stderr??''));
      t.skip('BLOCKED: OS did not supply genuine UAC-linked same-user medium token');
      return;
    }
    assert.equal(probe.status,0,
      'real medium peer must never open PROCESS_DUP_HANDLE: '+
      (probe.stdout??'')+' '+(probe.stderr??'')+' status='+probe.status);
    assert.match(probe.stdout,
      /NX_REAL_MEDIUM_TO_HIGH_DUP_HANDLE_DENIED same_user=1 elevated_guardian=1/,
      'only a real medium token can produce the boundary proof marker');
    t.diagnostic('P0 hosted synthetic boundary PASS; installed Broker remains BLOCKED');
  } finally {
    // Only this just-created isolated test Job is stopped.
    requestWindowsJobStop(launch);
    if (launch.child.exitCode===null)launch.child.kill();
  }
});
