import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, utimes, writeFile, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildNativeAgentLauncher,
  nativeAgentTaskStartConfirmed,
  nativeAgentTaskStopConfirmed,
  WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,
  assertNoResidualWindowsTaskOwnerArtifacts,
  type WindowsAgentTaskOwnerReadback,
} from '../src/agent/native-agent-lifecycle.js';

const helper='C:\\Nexowire\\app\\dist\\native\\windows-job-owner.exe';
const input={
  platform: 'win32' as const,
  execPath: 'C:\\Nexowire\\runtime\\node.exe',
  execArgv: [] as string[],
  cliEntrypoint: 'C:\\Nexowire\\app\\dist\\src\\cli.js',
  windowsTaskJobOwnerPath: helper,
  env: {NEXOWIRE_DEVICE_NAME:'Isolated Job Test'},
};

const snapshot=(patch:Partial<WindowsAgentTaskOwnerReadback>={}):WindowsAgentTaskOwnerReadback=>({
  installed:true,state:'ready',guarded:true,receipts:1,liveRoots:0,
  liveGuardians:0,rootPid:null,unknownAgentNodes:0,...patch,
});

test('AI09 installed Agent task uses a parent-bound native Job guardian',()=>{
  const ps=buildNativeAgentLauncher(input);
  assert.ok(ps.startsWith('\uFEFF'), 'PowerShell 5.1 UTF-8 BOM preserved');
  assert.match(ps,/NEXOWIRE_AGENT_TASK_JOB_GUARD_V1/);
  assert.match(ps,/windows-job-owner\.exe/);
  assert.match(ps,/--status' \$jobMarker/);
  assert.match(ps,/--parent' \(\[string\]\$PID\)/);
  assert.match(ps,/--cwd' '-'/);
  assert.ok(ps.includes("'C:\\Nexowire\\runtime\\node.exe'"));
  assert.match(ps,/'agent' 'run'/);
  assert.ok(!ps.includes("& 'C:\\Nexowire\\runtime\\node.exe'"),
    'installed task must not spawn naked Node');
});

test('AI09 does not silently accept an unpinned/relative Job executable',()=>{
  assert.throws(
    ()=>buildNativeAgentLauncher({...input,windowsTaskJobOwnerPath:'windows-job-owner.exe'}),
    /NATIVE_AGENT_TASK_JOB_HELPER_PATH_UNCONFIRMED/,
  );
});

test('AI09 150 synthetic start/stop generation decisions do not lock out after 128 receipts',()=>{
  for(let generation=1;generation<=150;generation++){
    const running=snapshot({
      state:'running',receipts:generation,
      liveRoots:1,liveGuardians:1,rootPid:30000+generation,
    });
    assert.equal(nativeAgentTaskStartConfirmed(running),true,
      'synthetic start generation '+generation);
    const stopped=snapshot({receipts:generation});
    assert.equal(nativeAgentTaskStopConfirmed(stopped),true,
      'synthetic stop generation '+generation);
  }
  // Windows-specific on-disk retention is covered by separate mocked Win32
  // tests. This pure test intentionally does NOT claim real Task Scheduler PASS.
  assert.ok(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT.includes('NexowireAgentJobReceiptDelete]::DeleteVerified('));
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/SetFileInformationByHandle/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/GetFileInformationByHandle/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/Sort-Object -Property written -Descending/);
});

test('AI09 stop requires separate Scheduler, root and guardian absence',()=>{
  assert.equal(nativeAgentTaskStopConfirmed(snapshot()),true);
  for(const bad of [
    {guarded:false},{receipts:0},{state:'running'},
    {state:'queued'},{state:'unknown'},
    {liveRoots:1,rootPid:14184},{liveGuardians:1},
    {unknownAgentNodes:1},
  ]){
    assert.equal(nativeAgentTaskStopConfirmed(snapshot(bad)),false,JSON.stringify(bad));
  }
});

test('AI09 start requires one verified Job guardian and live Agent root',()=>{
  const good=snapshot({state:'running',liveRoots:1,liveGuardians:1,rootPid:23964});
  assert.equal(nativeAgentTaskStartConfirmed(good),true);
  for(const bad of [
    {guarded:false},{state:'ready'},{liveRoots:0},{liveRoots:2},
    {liveGuardians:0},{liveGuardians:2},{rootPid:null},{rootPid:0},
    {unknownAgentNodes:1},
  ]){
    assert.equal(nativeAgentTaskStartConfirmed({...good,...bad}),false,JSON.stringify(bad));
  }
});

test('AI09 Windows reader keeps PID birth, bounded readback, and denies unknown results',()=>{
  const source=readFileSync(new URL('../src/agent/native-agent-lifecycle.ts',import.meta.url),'utf8');
  assert.match(source,/CreationDate\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/);
  assert.match(source,/NATIVE_AGENT_TASK_RECEIPT_INVALID/);
  assert.match(source,/NATIVE_AGENT_TASK_GUARDIAN_IDENTITY_UNKNOWN/);
  assert.match(source,/NATIVE_AGENT_TASK_DESCENDANT_STOP_UNCONFIRMED/);
  assert.match(source,/NATIVE_AGENT_TASK_PREEXISTING_OWNER_UNCONFIRMED/);
  assert.match(source,/Get-CimInstance Win32_Process/);
  assert.match(source,/ErrorAction Stop/);
  assert.doesNotMatch(source,/taskkill\.exe/);
});


/**
 * These are disposable, hosted Windows mock OS readbacks. They never register,
 * stop or kill a real Scheduled Task or any physical-machine process.
 */
const psExe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const mockPrelude=String.raw`
$ErrorActionPreference='Stop'
$fixture=ConvertFrom-Json $env:AI09_MOCK_CIM
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  [pscustomobject]@{State=$env:AI09_MOCK_TASK_STATE}
}
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position=0)][string]$ClassName,[string]$Filter)
  if ($env:AI09_MOCK_ACCESS_DENIED -eq '1') { throw 'MOCK_CIM_ACCESS_DENIED' }
  $items=if($Filter -like '*windows-job-owner.exe*') { @($fixture.guardians) } else { @($fixture.nodes) }
  foreach ($p in $items) {
    if ($null -eq $p) { continue }
    [pscustomobject]@{
      ProcessId=[int]$p.ProcessId
      ExecutablePath=[string]$p.ExecutablePath
      CommandLine=[string]$p.CommandLine
      CreationDate=[DateTime]::Parse([string]$p.CreationDate).ToUniversalTime()
    }
  }
}
`;
interface FixtureProcess {
  ProcessId: number;
  ExecutablePath: string;
  CommandLine: string;
  CreationDate: string;
}
interface MockCim {guardians:FixtureProcess[];nodes:FixtureProcess[]}
async function withMockTask(
  fn:(fixture:{dir:string;node:string;cli:string;helper:string;
              launch:string;marker:(i:number,birth?:string)=>Promise<string>;
              run:(mock?:Partial<MockCim>,state?:string,deny?:boolean)=>WindowsAgentTaskOwnerReadback})=>Promise<void>,
):Promise<void>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-ai09-receipts-'));
  const node=path.join(dir,'node.exe');
  const cli=path.join(dir,'agent-cli.js');
  const helper=path.join(dir,'windows-job-owner.exe');
  const launch=path.join(dir,'launch.ps1');
  const script=path.join(dir,'readback.ps1');
  await writeFile(launch,'# NEXOWIRE_AGENT_TASK_JOB_GUARD_V1\n','utf8');
  // Verify the PowerShell fixture really intercepts CIM before executing the
  // production readback. Hosted Windows module/command resolution can differ from
  // local Windows; an ineffective mock must fail loudly, never give false green.
  const preflight=String.raw`
$resolved=Get-Command Get-CimInstance -ErrorAction Stop
if ($resolved.CommandType -ne 'Function') { throw 'AI09_MOCK_CIM_RESOLUTION_UNCONFIRMED' }
$expected=@($fixture.guardians | Where-Object { $null -ne $_ }).Count
$observed=@(Get-CimInstance Win32_Process -Filter "Name='windows-job-owner.exe'" -ErrorAction Stop).Count
if ($observed -ne $expected) { throw ('AI09_MOCK_GUARDIAN_COUNT_UNCONFIRMED expected=' + $expected + ' observed=' + $observed) }
`;
  const trace=path.join(dir,'mock-trace.json');
  const traceScript=String.raw`
  $mockTrace=[pscustomobject]@{
    guardianProcesses=@($guardianProcesses).Count
    ownedGuardians=@($ownedGuardians).Count
    receiptCount=@($markers).Count
    matchedReceipts=@($records | Where-Object { $_.guardianCount -gt 0 }).Count
    binaryMatches=@($guardianProcesses | ForEach-Object { [string]::Equals($_.ExecutablePath,$expectedHelper,[StringComparison]::OrdinalIgnoreCase) })
    directoryMatches=@($guardianProcesses | ForEach-Object { $_.CommandLine.IndexOf($dir,[StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  [IO.File]::WriteAllText($env:AI09_MOCK_TRACE,($mockTrace | ConvertTo-Json -Compress -Depth 4))
`;
  const markerText='  # Never compact during a running/queued task';
  assert.ok(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT.includes(markerText));
  const withTrace=WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT.replace(markerText,traceScript+markerText);
  await writeFile(script,mockPrelude+'\n'+preflight+'\n'+withTrace,'utf8');
  const old=new Date(Date.now()-180_000);
  const marker=async(i:number,birth='133000000000000000')=>{
    const name='agent-job-'+i.toString(16).padStart(32,'0')+'.status';
    const target=path.join(dir,name);
    await writeFile(target,'NWJOB3 '+String(i+1000)+' '+birth+'\n','utf8');
    await utimes(target,old,old);
    return target;
  };
  const run=(mock:Partial<MockCim>={},state='Ready',deny=false):WindowsAgentTaskOwnerReadback=>{
    const env={
      ...process.env,
      NEXOWIRE_AGENT_TASK_NAME:'NX-AI09-SYNTHETIC-NO-SCHEDULER',
      NEXOWIRE_AGENT_LAUNCHER:launch,
      NEXOWIRE_AGENT_JOB_HELPER:helper,
      NEXOWIRE_AGENT_EXECUTABLE:node,
      NEXOWIRE_AGENT_CLI:cli,
      AI09_MOCK_CIM:JSON.stringify({guardians:mock.guardians??[],nodes:mock.nodes??[]}),
      AI09_MOCK_TRACE:trace,
      AI09_MOCK_TASK_STATE:state,
      AI09_MOCK_ACCESS_DENIED:deny?'1':'0',
    };
    const result=execFileSync(psExe,[
      '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
    ],{env,encoding:'utf8',windowsHide:true,timeout:20000});
    const parsed=JSON.parse(result.trim()) as WindowsAgentTaskOwnerReadback;
    if ((mock.guardians?.length??0)>0 && parsed.liveGuardians===0) {
      // Pure test diagnostic; no identity, fixture outcome or security check is changed.
      console.error('AI09_MOCK_GUARDIAN_TRACE '+readFileSync(trace,'utf8'));
    }
    return parsed;
  };
  try{await fn({dir,node,cli,helper,launch,marker,run});}
  finally{await rm(dir,{recursive:true,force:true});}
}
function expectMockError(callback:()=>unknown,reason:string):void{
  assert.throws(callback,(error:unknown)=>{
    const e=error as Error & {stderr?:string|Buffer};
    const diagnostic=String(e.stderr??'')+' '+e.message;
    assert.ok(diagnostic.includes(reason), 'expected '+reason+' but got: '+diagnostic.slice(0,500));
    return true;
  });
}
const fakeProc=(pid:number,exe:string,cmd:string,iso='2026-11-02T06:00:00.000Z'):FixtureProcess=>
  ({ProcessId:pid,ExecutablePath:exe,CommandLine:cmd,CreationDate:iso});

test('AI09 150 sequential successful synthetic stops compact 129+ aged receipts without 128 lockout',{
  skip:process.platform!=='win32',timeout:120_000,
},async()=>{
  await withMockTask(async({dir,marker,run})=>{
    // Model 150 distinct prior start/stop generations, each with its own
    // CREATE_NEW NWJOB3 receipt and positively absent root + guardian.
    for(let i=1;i<=150;i++){
      await marker(i);
      assert.equal(nativeAgentTaskStopConfirmed(snapshot()),true);
    }
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,150);
    const result=run();
    assert.equal(result.state,'ready');
    assert.equal(result.liveRoots,0);
    assert.equal(result.liveGuardians,0);
    assert.equal(result.unknownAgentNodes,0);
    assert.equal(result.receipts,16);
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,16);
    assert.equal(nativeAgentTaskStopConfirmed(result),true);
    assert.equal(run().receipts,16,'idempotent compaction must be stable');
  });
});

test('AI09 live guardian blocks compaction and can never satisfy stop/uninstall',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,helper,run,dir})=>{
    const live=await marker(999);
    for(let i=1;i<=130;i++)await marker(i);
    const before=(await readdir(dir)).filter(x=>x.endsWith('.status')).length;
    const guardian=fakeProc(5999,helper,'"'+helper+'" --status "'+live+'" --cwd - --parent 42');
    const result=run({guardians:[guardian]});
    assert.equal(result.receipts,before,'preserve every receipt while guardian is live');
    assert.equal(result.liveGuardians,1);
    assert.equal(nativeAgentTaskStopConfirmed(result),false);
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,before);
  });
});

test('AI09 stale reused PID with DIFFERENT birth is never treated as original root',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,node,run,dir})=>{
    await marker(1,'133000000000000000');
    for(let i=2;i<=131;i++)await marker(i);
    const reused=fakeProc(1001,node,'"'+node+'" unrelated.js');
    const result=run({nodes:[reused]});
    assert.equal(result.liveRoots,0);
    assert.equal(result.receipts,16);
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,16);
  });
});

test('AI09 access denied preserves ALL receipts and fails closed',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,run,dir})=>{
    for(let i=1;i<=130;i++)await marker(i);
    expectMockError(()=>run({},'Ready',true),'MOCK_CIM_ACCESS_DENIED');
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,130);
  });
});

test('AI09 matched root without guardian is an orphan and blocks cleanup',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,node,cli,run,dir})=>{
    const iso='2026-11-02T06:00:00.000Z';
    const birth=(BigInt(Date.parse(iso)+11644473600000)*10000n).toString();
    await marker(1,birth);
    for(let i=2;i<=130;i++)await marker(i);
    const root=fakeProc(1001,node,'"'+node+'" "'+cli+'" agent run',iso);
    expectMockError(()=>run({nodes:[root]}),'NATIVE_AGENT_TASK_ORPHAN_ROOT_UNCONFIRMED');
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,130);
  });
});

test('AI09 unowned Node child with Agent CLI blocks stop/uninstall and cleanup',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,node,cli,run,dir})=>{
    for(let i=1;i<=130;i++)await marker(i);
    const orphan=fakeProc(50000,node,'"'+node+'" "'+cli+'" agent run');
    expectMockError(()=>run({nodes:[orphan]}),'NATIVE_AGENT_TASK_UNOWNED_AGENT_NODE_UNCONFIRMED');
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,130);
    const src=readFileSync(new URL('../src/agent/native-agent-lifecycle.ts',import.meta.url),'utf8');
    const uninstall=src.slice(src.indexOf('async function uninstallWindows('),src.indexOf('async function linuxStatus('));
    assert.ok(uninstall.indexOf("await controlWindows(\'stop\', options)")>=0);
    assert.ok(uninstall.indexOf("await controlWindows(\'stop\', options)")<uninstall.indexOf('Unregister-ScheduledTask'));
  });
});

test('AI09 source has exclusive readback lock, 30s race grace and no 128 hard stop',()=>{
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/agent-job-retention\.lock/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/FileShare\]::None/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/RECEIPT_RACE_UNCONFIRMED/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/TotalSeconds -ge 30/);
  assert.match(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/NATIVE_AGENT_TASK_ORPHAN_ROOT_UNCONFIRMED/);
  assert.doesNotMatch(WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,/RECEIPT_LIMIT_EXCEEDED/);
});


test('AI09 residual unregistered task receipts block cleanup on any platform',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-ai09-uninstall-contract-'));
  try{
    await assertNoResidualWindowsTaskOwnerArtifacts(root);
    const marker=path.join(root,'agent-job-abcdef.status');
    await writeFile(marker,'NWJOB3 1 133000000000000000');
    await assert.rejects(
      ()=>assertNoResidualWindowsTaskOwnerArtifacts(root),
      /NATIVE_AGENT_TASK_RESIDUAL_OWNER_UNCONFIRMED/,
    );
    await rm(marker,{force:true});
    await writeFile(path.join(root,'launch.ps1'),'# old launcher');
    await assert.rejects(
      ()=>assertNoResidualWindowsTaskOwnerArtifacts(root),
      /NATIVE_AGENT_TASK_RESIDUAL_OWNER_UNCONFIRMED/,
    );
  }finally{await rm(root,{recursive:true,force:true});}
});

test('AI09 live guardian with absent status receipt blocks readback',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,helper,run,dir})=>{
    for(let i=1;i<=130;i++)await marker(i);
    const vanished=path.join(dir,'agent-job-'+('f').repeat(32)+'.status');
    const guardian=fakeProc(64002,helper,'"'+helper+'" --status "'+vanished+'" --parent 42');
    expectMockError(()=>run({guardians:[guardian]}),'NATIVE_AGENT_TASK_GUARDIAN_RECEIPT_MISSING');
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,130);
  });
});

test('AI09 unknown and malformed receipts cannot be garbage collected',{
  skip:process.platform!=='win32',timeout:60000,
},async()=>{
  await withMockTask(async({marker,run,dir})=>{
    for(let i=1;i<=130;i++)await marker(i);
    const corrupt=path.join(dir,'agent-job-'+('e').repeat(32)+'.status');
    await writeFile(corrupt,'BROKEN\n','utf8');
    expectMockError(()=>run(),'NATIVE_AGENT_TASK_RECEIPT_INVALID');
    assert.equal((await readdir(dir)).filter(x=>x.endsWith('.status')).length,131);
  });
});
