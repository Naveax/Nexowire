import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
 installNativeAgentLifecycle, startNativeAgentLifecycle,
 stopNativeAgentLifecycle, restartNativeAgentLifecycle,
 uninstallNativeAgentLifecycle, nativeAgentLifecycleStatus,
 type NativeAgentLifecycleOptions,
} from '../../src/agent/native-agent-lifecycle.js';

/** CLEAN-15: real Scheduler + actual Agent/guardian on a disposable Windows VM.
 * NEVER invoke on NAVEAX, Work-PC, or a self-hosted runner.
 */
const wanted=150, milestones=new Set([1,127,128,129,130,150]);
const psExe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function gate():string {
 assert.equal(process.platform,'win32','NOT_RUN: Windows-only');
 assert.equal(process.env.GITHUB_ACTIONS,'true','NOT_RUN: Actions-only');
 assert.equal(process.env.RUNNER_OS,'Windows','NOT_RUN: Windows runner required');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','NOT_RUN: disposable hosted VM required');
 assert.equal(process.env.NEXOWIRE_CLEAN15_ISOLATED_VM,'1','NOT_RUN: QA gate required');
 const root=process.env.RUNNER_TEMP;
 assert.ok(root&&path.win32.isAbsolute(root),'NOT_RUN: RUNNER_TEMP unavailable');
 return root;
}
type Started={state:string;pid:number|null;installed:boolean};
type Snapshot={scheduler:string;pid:number;birth:string;marker:string;
 guardianPid:number;guardianBirth:string;receipts:number;jobEvidence:string};
type StopSnapshot={scheduler:string;nodeSameBirth:boolean;guardianSameBirth:boolean;receipts:number};
function ps<T>(source:string, vars:Record<string,string>):T {
 const stdout=execFileSync(psExe,['-NoLogo','-NoProfile','-NonInteractive',
 '-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{
 encoding:'utf8',timeout:30000,windowsHide:true,cwd:'C:\\Windows\\System32',
 maxBuffer:256*1024,env:{...process.env,...vars}});
 return JSON.parse(stdout.trim()) as T;
}
const proofScript=String.raw`
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$env:NW_PID) -ErrorAction Stop
if($null -eq $p){throw 'CLEAN15_ROOT_ABSENT'}
$birth=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
if([IO.Path]::GetFullPath([string]$p.ExecutablePath) -ine [IO.Path]::GetFullPath($env:NW_NODE)){
 throw 'CLEAN15_NODE_EXE_MISMATCH'
}
$receipts=@(Get-ChildItem -LiteralPath $env:NW_DIR -Filter 'agent-job-*.status' -File -ErrorAction Stop)
$matching=@($receipts | Where-Object {
 ((Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop).Trim() -ceq
 ('NWJOB3 '+[int]$env:NW_PID+' '+$birth))
})
if($matching.Count -ne 1){throw ('CLEAN15_RECEIPT_COUNT_'+$matching.Count)}
$id=[regex]::Match($matching[0].Name,'[0-9a-f]{32}').Value
$all=@(Get-CimInstance Win32_Process -Filter "Name='windows-job-owner.exe'" -ErrorAction Stop)
$guard=@($all | Where-Object {
 $_.ExecutablePath -and $_.CommandLine -and
 [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq
 [IO.Path]::GetFullPath($env:NW_HELPER) -and $_.CommandLine.Contains($id)
})
if($guard.Count -ne 1){throw ('CLEAN15_GUARDIAN_COUNT_'+$guard.Count)}
$task=Get-ScheduledTask -TaskName $env:NW_TASK -ErrorAction Stop
if([string]$task.State -ne 'Running'){throw 'CLEAN15_NOT_RUNNING'}
$g=$guard[0]
[pscustomobject]@{
 scheduler=[string]$task.State;pid=[int]$p.ProcessId;birth=$birth;
 marker=[string]$matching[0].Name;guardianPid=[int]$g.ProcessId;
 guardianBirth=$g.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();
 receipts=$receipts.Count;
 jobEvidence='guardian_NWJOB3_published_after_native_AssignProcessToJobObject'
} | ConvertTo-Json -Compress
`;
const stopScript=String.raw`
$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName $env:NW_TASK -ErrorAction Stop
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$env:NW_PID) -ErrorAction Stop
$g=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$env:NW_GPID) -ErrorAction Stop
$nodeSame=($null -ne $p -and
 $p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $env:NW_BIRTH)
$guardianSame=($null -ne $g -and
 $g.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $env:NW_GBIRTH)
$receipts=@(Get-ChildItem -LiteralPath $env:NW_DIR -Filter 'agent-job-*.status' -File -ErrorAction Stop)
[pscustomobject]@{scheduler=[string]$task.State;nodeSameBirth=[bool]$nodeSame;
 guardianSameBirth=[bool]$guardianSame;receipts=$receipts.Count} | ConvertTo-Json -Compress
`;
async function run():Promise<void>{
 const temp=gate(),id=randomUUID().replaceAll('-','');
 const root=path.win32.join(temp,'clean15-agent-'+id);
 const evidence=path.win32.join(temp,'clean15-evidence-'+id);
 await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
 const task='Nexowire CLEAN15 QA '+id;
 const cli=path.win32.resolve('dist/src/cli.js');
 const helper=path.win32.resolve('dist/native/windows-job-owner.exe');
 const env:NodeJS.ProcessEnv={
  NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:65081/agent',
  NEXOWIRE_DEVICE_NAME:'CLEAN15-DISPOSABLE-'+id,
  NEXOWIRE_ALLOWED_ROOTS:root,NEXOWIRE_STATE_DIR:root,
  NEXOWIRE_PROCESS_STATE_FILE:path.win32.join(root,'processes.json'),
  NEXOWIRE_TASK_GRAPH_STATE_FILE:path.win32.join(root,'graphs.json'),
  NEXOWIRE_RUNBOOK_STATE_FILE:path.win32.join(root,'runbooks.json'),
  NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:path.win32.join(root,'journal.sqlite'),
  NEXOWIRE_PRIVILEGE_MODE:'direct',
 };
 const options:NativeAgentLifecycleOptions={
  platform:'win32',windowsTaskName:task,rootDir:root,
  execPath:process.execPath,execArgv:[],cliEntrypoint:cli,env,
 };
 const common={NW_DIR:root,NW_TASK:task,NW_NODE:process.execPath,NW_HELPER:helper};
 const report={status:'NOT_RUN',requested:wanted,completed:0,checkpoints:[] as unknown[],
  failure:'',cleanup:'',claim:'real task and child processes; unnamed Job handle NOT externally attested'};
 let installed=false;
 try{
  assert.equal((await nativeAgentLifecycleStatus(options)).installed,false,
    'CLEAN15_TASK_NAME_COLLISION');
  const initial=await installNativeAgentLifecycle(options);
  installed=true;
  assert.equal(initial.installed,true);
  for(let i=1;i<=wanted;i++){
   const opened=i===1?initial:await startNativeAgentLifecycle(options);
   assert.equal(opened.state,'running','CLEAN15_START_FAILED_'+i);
   assert.ok(opened.pid&&opened.pid>0,'CLEAN15_PID_MISSING_'+i);
   const running=ps<Snapshot>(proofScript,{...common,NW_PID:String(opened.pid)});
   let restarted:Snapshot|null=null;
   if(milestones.has(i)){
    const again=await restartNativeAgentLifecycle(options);
    assert.equal(again.state,'running','CLEAN15_RESTART_FAILED_'+i);
    assert.ok(again.pid&&again.pid>0);
    restarted=ps<Snapshot>(proofScript,{...common,NW_PID:String(again.pid)});
   }
   const current=restarted??running;
   const stopped=await stopNativeAgentLifecycle(options);
   assert.ok(['ready','disabled'].includes(stopped.state),'CLEAN15_STOP_FAILED_'+i);
   const proof=ps<StopSnapshot>(stopScript,{...common,
    NW_PID:String(current.pid),NW_GPID:String(current.guardianPid),
    NW_BIRTH:current.birth,NW_GBIRTH:current.guardianBirth});
   assert.equal(proof.nodeSameBirth,false,'CLEAN15_ORPHAN_NODE_'+i);
   assert.equal(proof.guardianSameBirth,false,'CLEAN15_ORPHAN_GUARDIAN_'+i);
   assert.ok(proof.receipts>=1,'CLEAN15_RECEIPT_MISSING_'+i);
   await appendFile(path.win32.join(evidence,'cycles.ndjson'),
     JSON.stringify({cycle:i,started:running,restarted,stopped:proof,at:new Date().toISOString()})+'\\n');
   report.completed=i;
   if(milestones.has(i)){
    const entry={cycle:i,rootPid:current.pid,birth:current.birth,
      guardianPid:current.guardianPid,receipts:proof.receipts,
      restartPassed:restarted!==null};
    report.checkpoints.push(entry);
    console.log('CLEAN15_CHECKPOINT '+JSON.stringify(entry));
   }
   if(i%25===0)console.log('CLEAN15_COMPLETED '+i+'/150');
  }
  report.status='PASS';console.log('CLEAN15_REAL_150_PASS');
 }catch(e){
  report.status=report.completed===0?'FAIL_BEFORE_CYCLE_1':'FAIL';
  report.failure=String(e);throw e;
 }finally{
  try{
   // A failed install might have registered the uniquely named task already.
   const present=await nativeAgentLifecycleStatus(options);
   if(present.installed){
    if(present.state==='running')await stopNativeAgentLifecycle(options);
    await uninstallNativeAgentLifecycle(options);
    report.cleanup='UNINSTALLED';
   }else{report.cleanup=installed?'TASK_ABSENT':'NO_TASK_CREATED';}
  }catch(e){
   // No unsafe force-removal or taskkill on an unknown owner.
   report.cleanup='FAIL_CLOSED '+String(e);
  }
  await writeFile(path.win32.join(evidence,'summary.json'),JSON.stringify(report,null,2)+'\\n');
  console.log('CLEAN15_EVIDENCE_PATH '+evidence);
 }
}
void run().catch(e=>{console.error('CLEAN15_FAILURE',e);process.exitCode=1;});
