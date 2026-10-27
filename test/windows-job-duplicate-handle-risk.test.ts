import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, execFileSync} from 'node:child_process';
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

test('after Job attestation, equal-HIGH same-logon PROCESS_DUP_HANDLE opens are denied', {
  skip:process.platform!=='win32',timeout:50000,
},async(t)=>{
  // Exactly this fixture guardian/root. This assertion is NOT a claim that
  // the earlier bootstrap window, SeDebug or a SYSTEM peer is contained.
  const groups=execFileSync('whoami.exe',['/groups'],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  const isHigh=/S-1-16-12288\b/.test(groups);
  const elevated=execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command','([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    {encoding:'utf8',windowsHide:true,timeout:8000}).trim()==='True';
  if(!isHigh || !elevated) {
    t.skip('BLOCKED: no real elevated HIGH identity');
    return;
  }
  const marker='NX_SEALED_JOB_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const started=await manager.start({shell:'powershell',
    command:`node -e \"const marker='${marker}';setInterval(()=>{},1000)\"`},
    new PathPolicy(['*']));
  try{
    assert.equal(started.treeOwnership,'windows_job');
    assert.ok(started.jobGuardianPid&&started.pid);
    const guard=exact(started.jobGuardianPid);
    assert.ok(guard?.Name.toLowerCase()==='windows-job-owner.exe' &&
      guard.CommandLine?.includes(marker),'must target a marked, owned guardian');
    const statusPath=/--status\s+(?:"([^"]+)"|([^\s]+))\s+--cwd/.exec(guard.CommandLine!);
    assert.ok(statusPath);
    const text=(await readFile(statusPath[1]??statusPath[2]!,'utf8')).trim();
    const nw=/^NWJOB5 (\d+) (\d+) (\d+)$/.exec(text);
    assert.ok(nw&&Number(nw[1])===started.pid);
    const root=exact(started.pid);
    assert.ok(root&&root.Name.toLowerCase()==='powershell.exe');

    let observedSeal=false;
    let bootstrapOpen=false;
    for(let attempt=0;attempt<100;attempt++) {
      const probe=spawnSync(path.resolve('test/fixtures/windows-job-medium-dup-probe.exe'),
        ['--probe-high',String(guard.ProcessId),nw[3]!],
        {windowsHide:true,encoding:'utf8',timeout:7000,maxBuffer:8192});
      if(probe.status===77) {
        t.skip('BLOCKED: kernel HIGH equal-token/LUID/SeDebug proof unavailable: '+
          (probe.stdout??'')+' '+(probe.stderr??''));
        return;
      }
      if(probe.status===0) {
        assert.match(probe.stdout,
          /NX_EQUAL_HIGH_PROCESS_DUP_HANDLE_DENIED sid_luid_session_verified=1 sedebug_enabled=0/);
        observedSeal=true;
        break;
      }
      assert.equal(probe.status,3,'native equal-HIGH proof must return DENIED or allowed');
      bootstrapOpen=true;
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.ok(observedSeal,'guardian must seal DACL before resuming root');
    if(bootstrapOpen)t.diagnostic('P0_BLOCKED: attacker observed pre-seal duplication window');
    assert.equal(exact(guard.ProcessId)?.CreationDate,guard.CreationDate);
    const killed=spawnSync('taskkill.exe',['/PID',String(guard.ProcessId),'/F'],
      {windowsHide:true,timeout:6000,stdio:'ignore'});
    assert.equal(killed.status,0);
    for(let i=0;i<40;i++){
      if(!exact(started.pid))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(exact(started.pid),undefined,
      'no already-stolen synthetic Job handle may keep this root alive');
    t.diagnostic('SOURCE_ONLY: equal-HIGH post-seal denial; pre-seal and SeDebug/SYSTEM remain BLOCKED');
  }finally{
    await manager.stop({session_id:started.sessionId}).catch(()=>undefined);
  }
});

test('real UAC-linked medium attacker cannot duplicate HIGH guardian Job handle', {
  skip:process.platform!=='win32',timeout:28000,
},async(t)=>{
  // Hosted runner fixture only. It does NOT verify an installed Broker's
  // token, process ACL, code signing, or physical production acceptance.
  const strictFixture = process.env.NEXOWIRE_REQUIRE_CROSS_INTEGRITY_FIXTURE === '1';
  const groups=execFileSync('whoami.exe',['/groups'],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  const isHigh=/S-1-16-12288\b/.test(groups);
  const elevated=execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-Command','([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    {encoding:'utf8',windowsHide:true,timeout:8000}).trim()==='True';
  if (!isHigh || !elevated) {
    const reason='BLOCKED: no elevated HIGH caller for paired medium fixture';
    if (strictFixture) assert.fail(reason);
    t.skip(reason);
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
      const reason='BLOCKED: OS-issued UAC-linked medium process or guardian token evidence unavailable: '+
        (probe.stdout??'')+' '+(probe.stderr??'');
      t.diagnostic('CROSS_INTEGRITY_BLOCKED: '+reason);
      if (strictFixture) assert.fail(reason);
      t.skip(reason);
      return;
    }
    assert.equal(probe.status,0,
      'real medium peer must never open PROCESS_DUP_HANDLE: '+
      (probe.stdout??'')+' '+(probe.stderr??'')+' status='+probe.status);
    assert.match(probe.stdout,
      /NX_FIXTURE_MEDIUM_TO_HIGH_PROCESS_DUP_HANDLE_DENIED same_logon_luid=1 guardian_token=high child_token=medium/,
      'only a real medium token can produce the boundary proof marker');
    t.diagnostic('SOURCE_FIXTURE_ONLY: kernel-token medium/high boundary observed; independently installed Broker, equal-HIGH attacker and full physical acceptance remain BLOCKED');
  } finally {
    // Only this just-created isolated test Job is stopped.
    requestWindowsJobStop(launch);
    if (launch.child.exitCode===null)launch.child.kill();
  }
});
