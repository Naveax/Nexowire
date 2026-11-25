/**
 * Explicit owner maintenance: arm an independent protected Windows rollback
 * task BEFORE disabling the legacy Hub. No UAC bypass or auto-elevation.
 * Never delete/overwrite the original user state, its launcher or secret.
 */
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants as fsConstants,promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isWindowsProcessElevated} from '../src/agent/privileged-broker.js';
import {
  hardenWindowsProgramDataAcl,protectedWindowsAclEnvironment,
  verifyWindowsPrivateAcl,verifyWindowsStackOuterAncestorAcl,windowsProgramDataAclArguments,
} from '../src/security/windows-programdata-acl.js';
import {assertWindowsPrivilegedRuntimeTrusted} from '../src/security/windows-privileged-runtime-trust.js';
import {
  hubBootLifecycleStatus,installHubBootLifecycle,
  parsePersistedHubLauncherEnvironment,
} from '../src/hub/hub-boot-lifecycle.js';
import {
  assertCanonicalHubStateSourcePath,assertNoSourceWriterReadOnly,
  SYSTEM_STATE_ROOT,SYSTEM_CUTOVER_RECEIPT,
} from '../src/hub/system-hub-state-cutover.js';
import {postHealthSystemHubDisposition,runRecoverableSystemHubCutover} from '../src/hub/system-cutover-orchestrator.js';
import {assertSystemCutoverDiskReserve} from '../src/hub/system-cutover-disk-reserve.js';
import {
  prepareProtectedOfflineSystemHubStateCopy,assertInteractiveHubTaskDisabledReadOnly,
} from './ai04-prepare-system-hub-state-copy.js';
import {issueOfflineSystemStateCutoverReceipt,assertLegacyHubPortNotListening}
  from './ai04-issue-system-state-receipt.js';

const PARENT='C:\\ProgramData\\Nexowire';
const ROOT=path.win32.join(PARENT,'hub-cutover-recovery');
const JOURNAL=path.win32.join(ROOT,'journal.json');
const RECOVERY=path.win32.join(ROOT,'rollback.ps1');
const CUTOVER_LOCK=path.win32.join(ROOT,'cutover.lock');
const TASK='Nexowire Hub Cutover Recovery';
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const LAUNCHER=path.win32.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
const SYSTEM_LAUNCHER='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1';

const RECOVERABLE_JOURNAL_PHASES=[
  'ARMED','QUIESCING','QUIESCED','COPIED','RECEIPT_ISSUED',
  'SYSTEM_INSTALLING','SYSTEM_STARTED','HEALTHY','AWAITING_PHYSICAL_ACCEPTANCE',
] as const;
type RecoverableJournalPhase=typeof RECOVERABLE_JOURNAL_PHASES[number];
type JournalPhase='NEW'|RecoverableJournalPhase|'COMPLETE'|'ROLLED_BACK';
interface Journal {
  version:1;
  host:string;
  phase:JournalPhase;
  marker:string;
  port:number;
  originalUserPrincipal:string;
  sourceRoot:string;
  launcherPath:string;
  launcherSha256:string;
  createdAt:string;
}
/** Match PowerShell Get-FileHash on the original bytes; reject lossy UTF-8 decoding. */
export function decodeCutoverLauncherProof(bytes:Buffer):{raw:string;digest:string}{
  const raw=bytes.toString('utf8');
  if(!Buffer.from(raw,'utf8').equals(bytes))
    throw new Error('AI04_LEGACY_LAUNCHER_ENCODING_UNTRUSTED');
  return {raw,digest:createHash('sha256').update(bytes).digest('hex')};
}
/** Re-read persisted launcher identity at each crossing of the old writer boundary. */
async function assertLegacyLauncherBoundToJournal(journal:Journal):Promise<void>{
  const {raw,digest}=decodeCutoverLauncherProof(await fs.readFile(LAUNCHER));
  const env=parsePersistedHubLauncherEnvironment(raw);
  const source=assertCanonicalHubStateSourcePath(env.NEXOWIRE_STATE_DIR);
  const port=Number(env.NEXOWIRE_HTTP_PORT??'43110');
  if(journal.launcherPath!==LAUNCHER||source!==journal.sourceRoot||
     port!==journal.port||digest!==journal.launcherSha256){
    throw new Error('AI04_LEGACY_LAUNCHER_CHANGED_DURING_CUTOVER');
  }
}
function psLiteral(value:string):string{return "'"+value.replaceAll("'","''")+"'";}
/**
 * Re-read the registered recovery task before stopping the legacy Hub.
 * A SYSTEM principal without matching executable, triggers and singleton
 * policy cannot establish durable rollback. This script is read-only.
 */
export function systemHubRecoveryTaskReadbackScript():string{
  const expectedArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+RECOVERY+'"';
  return [
    "$ErrorActionPreference='Stop'",
    "$t=Get-ScheduledTask -TaskName "+psLiteral(TASK)+" -TaskPath '\\' -ErrorAction Stop",
    "if(-not $t){throw 'AI04_RECOVERY_TASK_UNVERIFIED'}",
    "if([string]$t.TaskName -cne "+psLiteral(TASK)+" -or [string]$t.TaskPath -cne '\\'){throw 'AI04_RECOVERY_TASK_IDENTITY_CHANGED'}",
    "if([string]$t.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or [string]$t.Principal.RunLevel -cne 'Highest' -or [string]$t.Principal.LogonType -cne 'ServiceAccount'){throw 'AI04_RECOVERY_TASK_PRINCIPAL_UNTRUSTED'}",
    "$actions=@($t.Actions)",
    "if($actions.Count -ne 1 -or [string]$actions[0].Execute -cne "+psLiteral(POWERSHELL)+" -or [string]$actions[0].Arguments -cne "+psLiteral(expectedArgs)+"){throw 'AI04_RECOVERY_TASK_ACTION_UNTRUSTED'}",
    "$triggers=@($t.Triggers)",
    "$boot=@($triggers|Where-Object {$_.CimClass.CimClassName -ceq 'MSFT_TaskBootTrigger'})",
    "$timer=@($triggers|Where-Object {$_.CimClass.CimClassName -ceq 'MSFT_TaskTimeTrigger'})",
    "if($triggers.Count -ne 2 -or $boot.Count -ne 1 -or $timer.Count -ne 1 -or @($triggers|Where-Object {$_.Enabled -ne $true}).Count -ne 0){throw 'AI04_RECOVERY_TASK_TRIGGERS_UNTRUSTED'}",
    "if([string]$timer[0].Repetition.Interval -cne 'PT15M' -or [string]$timer[0].Repetition.Duration -cne 'P365D'){throw 'AI04_RECOVERY_TASK_RECURRENCE_UNTRUSTED'}",
    "if([string]$t.Settings.MultipleInstances -cne 'IgnoreNew'){throw 'AI04_RECOVERY_TASK_SINGLETON_UNTRUSTED'}",
    "if($t.Settings.StartWhenAvailable -ne $true){throw 'AI04_RECOVERY_TASK_SETTINGS_UNTRUSTED'}",
    "'OK'",
  ].join('\n');
}
/**
 * Fail closed on an existing or hidden recovery-task registration BEFORE
 * creating recovery artifacts. Task cmdlet absence/error alone is not proof;
 * only Task Scheduler COM GetTask 0x80070002 establishes nonexistence.
 */
export function systemHubRecoveryTaskAbsencePreflightScript():string{
  return [
    "$ErrorActionPreference='Stop'",
    "$existing=$null",
    "try{$existing=Get-ScheduledTask -TaskName "+psLiteral(TASK)+" -TaskPath '\\' -ErrorAction Stop}catch{$existing=$null}",
    "if($null -ne $existing){throw 'AI04_RECOVERY_TASK_ALREADY_EXISTS'}",
    "$service=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
    "$service.Connect()",
    "$folder=$service.GetFolder('\\')",
    "$registered=$null;$notFound=$false",
    "try{$registered=$folder.GetTask("+psLiteral(TASK)+")}catch{",
    "  $errorCode=$_.Exception",
    "  while($null -ne $errorCode.InnerException){$errorCode=$errorCode.InnerException}",
    "  if([int]$errorCode.HResult -eq -2147024894){$notFound=$true}",
    "  else{throw 'AI04_RECOVERY_TASK_VISIBILITY_UNVERIFIED'}",
    "}",
    "if(-not $notFound){throw 'AI04_RECOVERY_TASK_STILL_REGISTERED_OR_HIDDEN'}",
    "'OK'",
  ].join('\r\n');
}
const TASK_READBACK_TIMEOUT_MS=45_000;
// Match the independent recovery task's existing five-minute execution budget.
// The recovery script may spend 45s probing SYSTEM health, 20s waiting for
// shutdown, and 30s verifying legacy health, excluding filesystem hashing.
export const SYSTEM_HUB_ROLLBACK_TIMEOUT_MS=5*60_000;
function runPS(code:string,timeoutMs=TASK_READBACK_TIMEOUT_MS):string{
  const r=spawnSync(POWERSHELL,[
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',
    Buffer.from(code,'utf16le').toString('base64')],
    {cwd:'C:\\Windows\\System32',windowsHide:true,shell:false,
      env:protectedWindowsAclEnvironment(),encoding:'utf8',timeout:timeoutMs,maxBuffer:256*1024});
  if(r.status!==0||r.error)throw new Error('AI04_ELEVATED_TASK_OPERATION_FAILED');
  return (r.stdout??'').trim();
}
function icacls(args:string[]):void{
  const r=spawnSync('C:\\Windows\\System32\\icacls.exe',args,{
    cwd:'C:\\Windows\\System32',windowsHide:true,shell:false,
    env:protectedWindowsAclEnvironment(),encoding:'utf8',timeout:20000,maxBuffer:256*1024,
  });
  if(r.error||r.status!==0)throw new Error('AI04_RECOVERY_ACL_SETUP_FAILED');
}
function setProtectedOwner(file:string):void{
  icacls([file,'/setowner','*S-1-5-32-544']);
}
function privateFileAcl(file:string):void{
  setProtectedOwner(file);
  icacls(windowsProgramDataAclArguments(file,false));
  verifyWindowsPrivateAcl(file);
}
function ensureElevated():void{
  if(process.platform!=='win32'||!isWindowsProcessElevated())
    throw new Error('AI04_CUTOVER_REQUIRES_EXPLICIT_ELEVATED_OWNER_SESSION');
}
function trustedAncestors():void{
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(PARENT);
}
async function absent(file:string):Promise<void>{
  try{await fs.lstat(file);throw new Error('AI04_CUTOVER_EXISTING_ARTIFACT_DENIED')}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
async function privateWrite(file:string,data:string):Promise<void>{
  const handle=await fs.open(file,'wx',0o600);
  try{await handle.writeFile(data,'utf8');await handle.sync()}finally{await handle.close()}
  privateFileAcl(file);
}
async function advance(journal:Journal,phase:RecoverableJournalPhase):Promise<void>{
  journal.phase=phase;
  const temp=path.win32.join(ROOT,'journal-'+randomUUID()+'.tmp');
  await privateWrite(temp,JSON.stringify(journal,null,2)+'\n');
  await fs.rename(temp,JOURNAL);
  verifyWindowsPrivateAcl(JOURNAL);
}
/**
 * The recovery task runs as SYSTEM at next startup or after a 15-minute
 * timeout. It only unregisters the exact installer marker recorded BEFORE
 * cutover, and refuses to start a second Hub if port ownership is unknown.
 */
/** An absent boot task must be independently proven by Scheduler COM.
 * Get-ScheduledTask errors and null responses never imply nonexistence. */
export const SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS=[
  "$boot=$null",
  "try{$boot=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop}catch{$boot=$null}",
  "if($null -eq $boot){",
  "  $service=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
  "  $service.Connect()",
  "  $folder=$service.GetFolder('\\')",
  "  $registered=$null;$notFound=$false",
  "  try{$registered=$folder.GetTask('Nexowire Hub Boot')}catch{",
  "    $exception=$_.Exception",
  "    while($null -ne $exception.InnerException){$exception=$exception.InnerException}",
  "    if([int]$exception.HResult -eq -2147024894){$notFound=$true}",
  "    else{throw 'AI04_RECOVERY_BOOT_VISIBILITY_UNVERIFIED'}",
  "  }",
  "  if(-not $notFound){throw 'AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN'}",
  "}",
].join('\r\n');
/** After SYSTEM task removal, only an exact COM not-found proves fallback safe. */
export const SYSTEM_HUB_RECOVERY_FINAL_ABSENCE_PS=[
  "$check=$null",
  "try{$check=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop}catch{$check=$null}",
  "if($check){throw 'AI04_RECOVERY_BOOT_TASK_REAPPEARED'}",
  "$svc=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
  "$svc.Connect()",
  "$folder=$svc.GetFolder('\\')",
  "$registered=$null;$notFound=$false",
  "try{$registered=$folder.GetTask('Nexowire Hub Boot')}catch{",
  "  $exception=$_.Exception",
  "  while($null -ne $exception.InnerException){$exception=$exception.InnerException}",
  "  if([int]$exception.HResult -eq -2147024894){$notFound=$true}",
  "  else{throw 'AI04_RECOVERY_BOOT_VISIBILITY_UNVERIFIED'}",
  "}",
  "if(-not $notFound){throw 'AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN'}",
].join('\r\n');
export const SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS=[
  "$launcher=[string]$journal.launcherPath",
  "$launcherSha=[string]$journal.launcherSha256",
  "if(-not [IO.Path]::IsPathRooted($launcher) -or $launcherSha -cnotmatch '^[0-9a-f]{64}$'){throw 'AI04_RECOVERY_LAUNCHER_JOURNAL_UNTRUSTED'}",
  "$savedLauncher=Join-Path $root 'original-user-launcher.ps1'",
  "if(-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not (Test-Path -LiteralPath $savedLauncher -PathType Leaf)){throw 'AI04_RECOVERY_LEGACY_LAUNCHER_MISSING'}",
  "$onDiskHash=(Get-FileHash -LiteralPath $launcher -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
  "$savedHash=(Get-FileHash -LiteralPath $savedLauncher -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
  "if($onDiskHash -cne $launcherSha -or $savedHash -cne $launcherSha){throw 'AI04_RECOVERY_LEGACY_LAUNCHER_CHANGED'}",
].join('\r\n');
/** Re-read trusted task identity before ANY automatic SYSTEM resume. */
export const SYSTEM_HUB_RECOVERY_RESUME_TASK_PS=[
  "$resumeTask=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "if([string]$resumeTask.TaskName -cne 'Nexowire Hub Boot' -or [string]$resumeTask.TaskPath -cne '\\' -or [string]$resumeTask.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or [string]$resumeTask.Description -cne [string]$journal.marker){throw 'AI04_RECOVERY_RESUME_TASK_CHANGED'}",
  "$resumeActions=@($resumeTask.Actions)",
  "if($resumeActions.Count -ne 1 -or [string]$resumeActions[0].Execute -cne 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -or [string]$resumeActions[0].Arguments -cne $expected){throw 'AI04_RECOVERY_RESUME_ACTION_CHANGED'}",
].join('\r\n');
export const SYSTEM_HUB_RECOVERY_PS=[
  "$ErrorActionPreference='Stop'",
  "$root='C:\\ProgramData\\Nexowire\\hub-cutover-recovery'",
  // The Node cutover holds this protected file open for write. Win32 rejects
  // a FileShare.None open while such a handle exists; a second recovery is
  // also excluded. Process exit releases the OS handle, not the evidence file.
  "$lockPath=Join-Path $root 'cutover.lock'",
  "try{",
  "  $lockInfo=Get-Item -LiteralPath $lockPath -Force -ErrorAction Stop",
  "  if($lockInfo.PSIsContainer -or $lockInfo.Length -ne 0 -or (($lockInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'AI04_RECOVERY_LOCK_UNTRUSTED'}",
  "  $recoveryLock=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
  "}catch{throw 'AI04_RECOVERY_LOCK_UNAVAILABLE'}",
  "try{",
  "$journalPath=Join-Path $root 'journal.json'",
  "$journal=Get-Content -LiteralPath $journalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop",
  "if($journal.version -ne 1 -or [string]$journal.host -cne $env:COMPUTERNAME){throw 'AI04_RECOVERY_JOURNAL_FOREIGN'}",
  // Reject all noncanonical phase spellings before the terminal-state exit.
  // Keep the established AI-07 terminal-phase contract without accepting
  // case-insensitive aliases of COMPLETE or ROLLED_BACK.
  "if([string]$journal.phase -cnotin @("+[...RECOVERABLE_JOURNAL_PHASES,'COMPLETE','ROLLED_BACK'].map(psLiteral).join(',')+")){throw 'AI04_RECOVERY_UNKNOWN_PHASE'}",
  "if($journal.phase -in @('COMPLETE','ROLLED_BACK')){exit 0}",
  // ARMED is published before the first legacy mutation attempt. A later
  // owner stop must not be undone by the independent recovery timer.
  "if([string]$journal.phase -ceq 'ARMED'){throw 'AI04_RECOVERY_QUIESCE_NOT_ATTEMPTED'}",
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
  "$port=[int]$journal.port",
  "if($port -lt 1 -or $port -gt 65535){throw 'AI04_RECOVERY_PORT_UNTRUSTED'}",
  SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,
  "if($boot){",
  "  $sid=[string]$boot.Principal.UserId",
  "  if($sid -notin @('SYSTEM','S-1-5-18') -or [string]$boot.Description -cne [string]$journal.marker){throw 'AI04_RECOVERY_BOOT_TASK_NOT_OURS'}",
  "  $act=@($boot.Actions)",
  "  $expected='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1\"'",
  "  if($act.Count -ne 1 -or [string]$act[0].Execute -cne 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -or [string]$act[0].Arguments -cne $expected){throw 'AI04_RECOVERY_BOOT_ACTION_UNTRUSTED'}",
  "}",
  // A provisional, correctly owned healthy SYSTEM Hub must not be torn down
  // by the 15-minute recovery trigger or the concurrent startup trigger.
  // Timeout or uncertain identity falls through to the existing safe recovery.
  "if([string]$journal.phase -ceq 'AWAITING_PHYSICAL_ACCEPTANCE'){",
  "  if(-not $boot){throw 'AI07_PROVISIONAL_SYSTEM_TASK_MISSING'}",
  "  $until=(Get-Date).AddSeconds(45)",
  "  do {",
  "    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port)",
  "    if($listeners.Count -gt 1){throw 'AI07_PROVISIONAL_PORT_AMBIGUOUS'}",
  "    if($listeners.Count -eq 1){",
  "      $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0].OwningProcess) -ErrorAction Stop",
  "      if(-not $proc){throw 'AI07_PROVISIONAL_PORT_PROCESS_MISSING'}",
  "      $sidResult=Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction Stop",
  "      if([string]$sidResult.Sid -cne 'S-1-5-18'){throw 'AI07_PROVISIONAL_PORT_OWNER_UNTRUSTED'}",
  "      $liveBoot=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "      if([string]$liveBoot.Description -cne [string]$journal.marker -or [string]$liveBoot.Principal.UserId -notin @('SYSTEM','S-1-5-18')){throw 'AI07_PROVISIONAL_TASK_CHANGED'}",
  "      if([string]$liveBoot.State -ceq 'Running'){",
  "        try {",
  "          $health=Invoke-WebRequest -Uri ('http://127.0.0.1:'+$port+'/health') -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop",
  "          if([int]$health.StatusCode -eq 200){return}",
  "        } catch {}",
  "      }",
  "    }",
  "    Start-Sleep -Milliseconds 500",
  "  } while((Get-Date) -lt $until)",
  "}",
  // Keep the exact owned SYSTEM task registered until state equality is established.
  // An unacknowledged SYSTEM write must not trigger an implicit fallback.

  "$target='C:\\ProgramData\\Nexowire\\hub-state'",
  // Guard the active SYSTEM writer before any stop, and after shutdown.
  "$validateState = {",
  "  if($boot -and -not (Test-Path -LiteralPath $target -PathType Container)){throw 'AI04_RECOVERY_SYSTEM_TARGET_MISSING'}",
  "  if(Test-Path -LiteralPath $target){",
  "  $source=[string]$journal.sourceRoot",
  "  if(-not (Test-Path -LiteralPath $source -PathType Container)){throw 'AI04_RECOVERY_SOURCE_MISSING'}",
  "  foreach($dir in @($source,$target)){",
  "    $entries=@(Get-Item -LiteralPath $dir -Force -ErrorAction Stop)+@(Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction Stop)",
  "    if(@($entries | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count -gt 0){throw 'AI04_RECOVERY_REPARSE_DENIED'}",
  "  }",
  "  $maps=@()",
  "  foreach($dir in @($source,$target)){",
  "    $map=@{}",
  "    foreach($file in @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction Stop)){",
  "      if($file.Name -eq 'idempotency-records.sqlite-shm'){continue}",
  "      $relative=$file.FullName.Substring($dir.Length+1).ToLowerInvariant()",
  "      if($map.ContainsKey($relative)){throw 'AI04_RECOVERY_DUPLICATE_FILE'}",
  "      $map[$relative]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash",
  "    }",
  "    $maps+=,$map",
  "  }",
  "  if($maps[0].Count -ne $maps[1].Count){throw 'AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES'}",
  "  foreach($name in $maps[0].Keys){if(-not $maps[1].ContainsKey($name) -or $maps[0][$name] -cne $maps[1][$name]){throw 'AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES'}}",
  "}",
  "}",
  "& $validateState",
  "if($boot){",
  "  Stop-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "  $until=(Get-Date).AddSeconds(20)",
  "  do { $owners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port); if($owners.Count -eq 0){break}; Start-Sleep -Milliseconds 250 } while((Get-Date) -lt $until)",
  "  if($owners.Count -gt 0){throw 'AI04_RECOVERY_SYSTEM_PORT_STILL_OWNED'}",
  // A late shutdown write is not consent to discard SYSTEM data.
  // Restore availability using only the already owner-verified task.
  "  try{& $validateState}catch{",
  "    $divergence=$_",
  "    try{",
  SYSTEM_HUB_RECOVERY_RESUME_TASK_PS,
  "      Start-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "    }catch{throw 'AI04_RECOVERY_SYSTEM_RESUME_FAILED'}",
  "    throw $divergence",
  "  }",
  "  $current=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "  if([string]$current.Description -cne [string]$journal.marker -or [string]$current.Principal.UserId -notin @('SYSTEM','S-1-5-18')){throw 'AI04_RECOVERY_BOOT_REPLACED'}",
  // A replaced task action must never be unregistered as though it were the original.
  SYSTEM_HUB_RECOVERY_RESUME_TASK_PS,
  "  try{",
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
  "  }catch{",
  "    $launcherDrift=$_",
  "    try{",
  SYSTEM_HUB_RECOVERY_RESUME_TASK_PS,
  "      Start-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "    }catch{throw 'AI04_RECOVERY_SYSTEM_RESUME_FAILED'}",
  "    throw $launcherDrift",
  "  }",
  "  Unregister-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -Confirm:$false",
  // No stale legacy fallback even if a detached writer mutates after unregister.
  "  & $validateState",
  "}",




  SYSTEM_HUB_RECOVERY_FINAL_ABSENCE_PS,
  SYSTEM_HUB_RECOVERY_LAUNCHER_PROOF_PS,
  "& $validateState",
  "$user=Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop",
  "if([string]$user.Principal.UserId -cne [string]$journal.originalUserPrincipal){throw 'AI04_RECOVERY_LEGACY_TASK_REPLACED'}",
  "$portOwner=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port)",
  "if($portOwner.Count -gt 1){throw 'AI04_RECOVERY_PORT_AMBIGUOUS'}",
  "if($portOwner.Count -eq 1){",
  "  if([string]$user.State -cne 'Running'){throw 'AI04_RECOVERY_PORT_OCCUPIED'}",
  "  $pidOwner=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$portOwner[0].OwningProcess) -ErrorAction Stop",
  "  $owner=Invoke-CimMethod -InputObject $pidOwner -MethodName GetOwner -ErrorAction Stop",
  "  $expectedUser=([string]$journal.originalUserPrincipal).Split('\\')[-1]",
  "  if([string]$owner.User -cne $expectedUser){throw 'AI04_RECOVERY_PORT_FOREIGN_OWNER'}",
  "}else{",
  "  Enable-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' | Out-Null",
  "  Start-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\'",
  "}",
  "$until=(Get-Date).AddSeconds(30);$healthy=$false",
  "do {try{$r=Invoke-WebRequest -Uri ('http://127.0.0.1:'+$port+'/health') -UseBasicParsing -TimeoutSec 2;if($r.StatusCode -eq 200){$healthy=$true;break}}catch{};Start-Sleep -Milliseconds 500}while((Get-Date) -lt $until)",
  "if(-not $healthy){throw 'AI04_RECOVERY_LEGACY_HUB_NOT_HEALTHY'}",
  "$journal.phase='ROLLED_BACK'",
  "$temp=Join-Path $root ('recovery-'+[guid]::NewGuid().ToString()+'.tmp')",
  "$journal | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temp -Encoding UTF8 -ErrorAction Stop",
  "Move-Item -LiteralPath $temp -Destination $journalPath -Force -ErrorAction Stop",
  "}finally{$recoveryLock.Dispose()}",
].join('\r\n');

/** Non-mutating recovery admission; distinguish inaccessible from absent files. */
export async function assertRecoveryArtifactPresent(file:string):Promise<void>{
  let stat;
  try{stat=await fs.lstat(file)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')
      throw new Error('AI04_ROLLBACK_ARTIFACT_MISSING',{cause:error});
    throw error;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    throw new Error('AI04_ROLLBACK_ARTIFACT_UNTRUSTED');
}
/** Read back PowerShell 5.1 UTF-8 (with BOM) or Node UTF-8 journal bytes.
 * A terminal phase from a different transaction is not recovery evidence.
 */
export function assertDurableRollbackConfirmation(
  bytes:Buffer,expected:Pick<Journal,'version'|'host'|'marker'|'sourceRoot'|'launcherPath'|'launcherSha256'|'port'|'originalUserPrincipal'|'createdAt'>,
):void{
  let restored:unknown;
  try{
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    restored=JSON.parse(decoded);
  }catch(error){
    throw new Error('AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING',{cause:error});
  }
  if(!restored||typeof restored!=='object'||Array.isArray(restored))
    throw new Error('AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING');
  const record=restored as Record<string,unknown>;
  if(record.phase!=='ROLLED_BACK'||([
    'version','host','marker','sourceRoot','launcherPath','launcherSha256',
    'port','originalUserPrincipal','createdAt',
  ] as const).some(key=>record[key]!==expected[key]))
    throw new Error('AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING');
}
function validateRecoveredScript():void{
  trustedAncestors();
  verifyWindowsPrivateAcl(ROOT);
  verifyWindowsPrivateAcl(RECOVERY);
  verifyWindowsPrivateAcl(JOURNAL);
}
/**
 * The legacy cutover recovery artifact does not consume the independently
 * signed recovery authority or machine updater activation fence. Until those
 * real dependencies are composed, neither arming a new recovery task nor
 * invoking the legacy rollback artifact is an admissible production action.
 * This is deliberately a denial, not a verifier or configurable bypass.
 * Existing on-disk recovery tasks require separate authorized reconciliation.
 */
function requireIndependentRecoveryAuthority():void{
  throw new Error('AI04_SIGNED_SQLITE_RECOVERY_AUTHORITY_REQUIRED');
}
function runRollbackScript():void{
  requireIndependentRecoveryAuthority();
  validateRecoveredScript();
  runPS('& '+psLiteral(RECOVERY),SYSTEM_HUB_ROLLBACK_TIMEOUT_MS);
}
export async function controlledSystemHubCutover(
  trustedCli:string,
):Promise<{booted:true;rollbackArmed:true;physicalRebootAccepted:false;pendingPhysicalAcceptance:true}>{
  requireIndependentRecoveryAuthority();
  ensureElevated();
  const marker='Nexowire pre-logon Hub install '+randomUUID();
  const journal:Journal={
    version:1,host:os.hostname(),phase:'NEW',marker,port:0,
    sourceRoot:'',launcherPath:LAUNCHER,launcherSha256:'',
    originalUserPrincipal:'',createdAt:new Date().toISOString(),
  };
  let cutoverLock:Awaited<ReturnType<typeof fs.open>>|undefined;
  const releaseCutoverLock=async():Promise<void>=>{
    if(!cutoverLock)return;
    await cutoverLock.close();
    cutoverLock=undefined;
  };
  const assertCutoverLockHeld=async():Promise<void>=>{
    if(!cutoverLock)throw new Error('AI04_CUTOVER_LOCK_UNVERIFIED');
    const open=await cutoverLock.stat({bigint:true});
    const named=await fs.lstat(CUTOVER_LOCK,{bigint:true});
    if(!open.isFile()||!named.isFile()||named.isSymbolicLink()||
       open.nlink!==1n||named.nlink!==1n||open.size!==0n||named.size!==0n||
       open.dev!==named.dev||open.ino!==named.ino)
      throw new Error('AI04_CUTOVER_LOCK_UNVERIFIED');
  };
  let cutoverFailed=false;
  let cutoverFailure:unknown;
  try{
  return await runRecoverableSystemHubCutover({
    async preflight(){
      // No recovery artifacts or user Hub changes when the state volume is full.
      await assertSystemCutoverDiskReserve();
      trustedAncestors();
      assertWindowsPrivilegedRuntimeTrusted({
        executable:process.execPath,cliEntrypoint:process.argv[1]!,
        env:process.env,
      });
      assertWindowsPrivilegedRuntimeTrusted({
        executable:process.execPath,cliEntrypoint:trustedCli,env:process.env,
      });
      await absent(ROOT);await absent(SYSTEM_STATE_ROOT);await absent(SYSTEM_CUTOVER_RECEIPT);
      const boot=await hubBootLifecycleStatus();
      if(boot.installed||boot.state!=='not-installed')
        throw new Error('AI04_EXISTING_OR_HIDDEN_SYSTEM_BOOT_TASK_DENIED');
      const {raw:persistedLauncher,digest:launcherDigest}=decodeCutoverLauncherProof(await fs.readFile(LAUNCHER));
      const env=parsePersistedHubLauncherEnvironment(persistedLauncher);
      journal.sourceRoot=assertCanonicalHubStateSourcePath(env.NEXOWIRE_STATE_DIR);
      journal.launcherSha256=launcherDigest;
      // The actual source may be a mount point independent of the user profile.
      // Confirm it before registering any recovery artifact or stopping the Hub.
      await assertSystemCutoverDiskReserve(undefined,os.homedir(),journal.sourceRoot);
      journal.port=Number(env.NEXOWIRE_HTTP_PORT??'43110');
      if(!Number.isInteger(journal.port)||journal.port<1||journal.port>65535)
        throw new Error('AI04_LEGACY_PORT_INVALID');
      const info=JSON.parse(runPS([
        "$ErrorActionPreference='Stop'",
        "$t=Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop",
        "if([string]$t.State -cne 'Running'){throw 'AI04_USER_HUB_NOT_RUNNING'}",
        "$p=[string]$t.Principal.UserId",
        "if(-not $p -or $p -in @('SYSTEM','S-1-5-18')){throw 'AI04_USER_PRINCIPAL_INVALID'}",
        "[pscustomobject]@{principal=$p}|ConvertTo-Json -Compress",
      ].join('\n'))) as {principal:string};
      journal.originalUserPrincipal=info.principal;
    },
    async armRecovery(){
      if(runPS(systemHubRecoveryTaskAbsencePreflightScript())!=='OK')
        throw new Error('AI04_RECOVERY_TASK_ABSENCE_UNVERIFIED');
      await fs.mkdir(ROOT,{recursive:false,mode:0o700});
      setProtectedOwner(ROOT);
      hardenWindowsProgramDataAcl(ROOT);
      verifyWindowsPrivateAcl(ROOT);
      // Create and harden the lock before publishing any recovery task.
      await privateWrite(CUTOVER_LOCK,'');
      cutoverLock=await fs.open(CUTOVER_LOCK,'r+');
      await assertCutoverLockHeld();
      const backupLauncher=path.win32.join(ROOT,'original-user-launcher.ps1');
      await fs.copyFile(LAUNCHER,backupLauncher,fsConstants.COPYFILE_EXCL);
      privateFileAcl(backupLauncher);
      if(createHash('sha256').update(await fs.readFile(backupLauncher)).digest('hex')!==journal.launcherSha256)
        throw new Error('AI04_RECOVERY_LAUNCHER_BACKUP_MISMATCH');
      const xml=runPS("$ErrorActionPreference='Stop';Export-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop");
      if(!xml.startsWith('<?xml')&&!xml.startsWith('<Task'))throw new Error('AI04_RECOVERY_TASK_XML_UNVERIFIED');
      await privateWrite(path.win32.join(ROOT,'original-user-task.xml'),xml+'\n');
      await privateWrite(RECOVERY,SYSTEM_HUB_RECOVERY_PS+'\r\n');
      await privateWrite(JOURNAL,JSON.stringify({...journal,phase:'ARMED'},null,2)+'\n');
      if(runPS(systemHubRecoveryTaskAbsencePreflightScript())!=='OK')
        throw new Error('AI04_RECOVERY_TASK_ABSENCE_UNVERIFIED');
      runPS([
        "$ErrorActionPreference='Stop'",
        "$script="+psLiteral(RECOVERY),
        "$execute="+psLiteral(POWERSHELL),
        "$action=New-ScheduledTaskAction -Execute $execute -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"'+$script+'\"')",
        "$startup=New-ScheduledTaskTrigger -AtStartup",
        "$timeout=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 365)",
        "$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
        "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds "+(SYSTEM_HUB_ROLLBACK_TIMEOUT_MS/1000)+")",
        "Register-ScheduledTask -TaskName "+psLiteral(TASK)+" -TaskPath '\\' -Action $action -Trigger @($startup,$timeout) -Principal $principal -Settings $settings -ErrorAction Stop|Out-Null",
        ].join('\n'));
      const taskCheck=runPS(systemHubRecoveryTaskReadbackScript());
      if(taskCheck!=='OK')throw new Error('AI04_RECOVERY_TASK_UNVERIFIED');
      await advance(journal,'ARMED');
    },
    async confirmRecoveryBeforeQuiesce(){
      // This check MUST remain outside the rollback catch. The user Hub
      // has not been disabled and the registered recovery is untrusted.
      if(runPS(systemHubRecoveryTaskReadbackScript())!=='OK')
        throw new Error('AI04_RECOVERY_TASK_CHANGED_BEFORE_QUIESCE');
      verifyWindowsPrivateAcl(RECOVERY);
      verifyWindowsPrivateAcl(JOURNAL);
      verifyWindowsPrivateAcl(CUTOVER_LOCK);
      await assertCutoverLockHeld();
      await assertLegacyLauncherBoundToJournal(journal);
      // Other processes can consume space while the recovery task is armed.
      // Recheck the authoritative source path as well as the protected target
      // immediately before disabling the existing user Hub.
      await assertSystemCutoverDiskReserve(undefined,os.homedir(),journal.sourceRoot);
    },
    async quiesceLegacy(){
      await assertCutoverLockHeld();
      await advance(journal,'QUIESCING');
      runPS([
        "$ErrorActionPreference='Stop'",
        "$t=Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop",
        "if([string]$t.Principal.UserId -cne "+psLiteral(journal.originalUserPrincipal)+"){throw 'AI04_LEGACY_TASK_CHANGED'}",
        "Disable-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop|Out-Null",
        "Stop-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction SilentlyContinue",
      ].join('\n'));
      assertInteractiveHubTaskDisabledReadOnly();
      const deadline=Date.now()+20000;
      for(;;){
        try{
          await assertNoSourceWriterReadOnly(journal.sourceRoot);
          assertLegacyHubPortNotListening(journal.port);
          break;
        }catch(error){
          if(Date.now()>deadline)throw error;
          await new Promise(resolve=>setTimeout(resolve,350));
        }
      }
      await advance(journal,'QUIESCED');
    },
    async copyProtectedState(){
      await assertCutoverLockHeld();
      trustedAncestors();
      await assertLegacyLauncherBoundToJournal(journal);
      await prepareProtectedOfflineSystemHubStateCopy(LAUNCHER,true);
      await assertLegacyLauncherBoundToJournal(journal);
      await advance(journal,'COPIED');
    },
    async issueReceipt(){
      await assertCutoverLockHeld();
      assertInteractiveHubTaskDisabledReadOnly();
      await assertLegacyLauncherBoundToJournal(journal);
      await issueOfflineSystemStateCutoverReceipt(LAUNCHER,true);
      await assertLegacyLauncherBoundToJournal(journal);
      await advance(journal,'RECEIPT_ISSUED');
    },
    async installSystemHub(){
      await assertCutoverLockHeld();
      await advance(journal,'SYSTEM_INSTALLING');
      await installHubBootLifecycle({
        execPath:process.execPath,execArgv:[],
        cliEntrypoint:trustedCli,cutoverInstallMarker:marker,
      });
      await advance(journal,'SYSTEM_STARTED');
    },
    async verifySystemHub(){
      await assertCutoverLockHeld();
      const status=await hubBootLifecycleStatus();
      if(!status.installed||status.state!=='running'||!status.pid)
        throw new Error('AI04_SYSTEM_HUB_NOT_RUNNING');
      const proc=runPS([
        "$ErrorActionPreference='Stop'",
        "$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+status.pid+"' -ErrorAction Stop",
        "if(-not $p){throw 'AI04_SYSTEM_PID_GONE'}",
        "$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop",
        "if([string]$owner.Domain -cne 'NT AUTHORITY' -or [string]$owner.User -cne 'SYSTEM'){throw 'AI04_SYSTEM_HUB_WRONG_OWNER'}",
        "'SYSTEM'",
      ].join('\n'));
      if(proc!=='SYSTEM')throw new Error('AI04_SYSTEM_HUB_OWNER_UNVERIFIED');
      const health=await fetch('http://127.0.0.1:'+journal.port+'/health',{signal:AbortSignal.timeout(5000)});
      if(health.status!==200)throw new Error('AI04_SYSTEM_HUB_HEALTH_NOT_200');
      await advance(journal,'HEALTHY');
    },
    async commit(){
      await assertCutoverLockHeld();
      // A healthy SYSTEM PID and HTTP 200 are NOT sufficient for physical
      // acceptance. Never disarm recovery on this incomplete evidence.
      const disposition=postHealthSystemHubDisposition();
      if(!disposition.retainRecoveryTask||disposition.physicalRebootAccepted)
        throw new Error('AI07_UNSAFE_CUTOVER_FINALIZATION');
      await advance(journal,disposition.journalPhase);
      // Keep rollback task, journal, legacy launcher and state intact until
      // independent DPAPI, SQLite, CORE, Broker and reboot acceptance.
    },
    async rollback(){
      // The orchestrator only requests rollback after recovery was armed and
      // quiescence was attempted. Missing evidence is a failed rollback, never
      // proof that the original writer is restored.
      await assertRecoveryArtifactPresent(RECOVERY);
      await assertCutoverLockHeld();
      // Transfer execution to the PowerShell exclusive handle. If the
      // scheduled recovery wins the race, the manual attempt fails closed.
      await releaseCutoverLock();
      runRollbackScript();
      // PowerShell may exit successfully for a previously COMPLETE cutover.
      // Do not report a rollback unless the durable journal confirms one.
      assertDurableRollbackConfirmation(await fs.readFile(JOURNAL),journal);
    },
  });
  }catch(error){
    cutoverFailed=true;cutoverFailure=error;throw error;
  }finally{
    try{await releaseCutoverLock()}
    catch(error){
      if(cutoverFailed)throw new AggregateError([cutoverFailure,error],'AI04_CUTOVER_AND_LOCK_RELEASE_FAILED');
      throw new Error('AI04_CUTOVER_LOCK_RELEASE_UNVERIFIED',{cause:error});
    }
  }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  ensureElevated();
  if(process.argv[2]==='--rollback'&&process.argv.length===3){
    runRollbackScript();
    process.stdout.write('{"rollbackRequested":true,"accepted":false}\n');
  }else if(process.argv[2]==='--approve-controlled-cutover'&&
      process.argv.length===4&&process.argv[3]?.startsWith('--trusted-cli=')){
    const cli=process.argv[3].slice('--trusted-cli='.length);
    const outcome=await controlledSystemHubCutover(cli);
    process.stdout.write(JSON.stringify(outcome)+'\n');
  }else{
    throw new Error('Use --approve-controlled-cutover --trusted-cli=TRUSTED_PROGRAMFILES_CLI or --rollback. No automatic UAC elevation.');
  }
}
