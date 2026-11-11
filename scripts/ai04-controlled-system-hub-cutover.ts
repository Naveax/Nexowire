/**
 * Explicit owner maintenance: arm an independent protected Windows rollback
 * task BEFORE disabling the legacy Hub. No UAC bypass or auto-elevation.
 * Never delete/overwrite the original user state, its launcher or secret.
 */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
import {
  prepareProtectedOfflineSystemHubStateCopy,assertInteractiveHubTaskDisabledReadOnly,
} from './ai04-prepare-system-hub-state-copy.js';
import {issueOfflineSystemStateCutoverReceipt,assertLegacyHubPortNotListening}
  from './ai04-issue-system-state-receipt.js';

const PARENT='C:\\ProgramData\\Nexowire';
const ROOT=path.win32.join(PARENT,'hub-cutover-recovery');
const JOURNAL=path.win32.join(ROOT,'journal.json');
const RECOVERY=path.win32.join(ROOT,'rollback.ps1');
const TASK='Nexowire Hub Cutover Recovery';
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const LAUNCHER=path.win32.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
const SYSTEM_LAUNCHER='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1';

interface Journal {
  version:1;
  host:string;
  phase:string;
  marker:string;
  port:number;
  originalUserPrincipal:string;
  sourceRoot:string;
  createdAt:string;
}
function psLiteral(value:string):string{return "'"+value.replaceAll("'","''")+"'";}
function runPS(code:string):string{
  const r=spawnSync(POWERSHELL,[
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',
    Buffer.from(code,'utf16le').toString('base64')],
    {cwd:'C:\\Windows\\System32',windowsHide:true,shell:false,
      env:protectedWindowsAclEnvironment(),encoding:'utf8',timeout:45000,maxBuffer:256*1024});
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
async function advance(journal:Journal,phase:string):Promise<void>{
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
export const SYSTEM_HUB_RECOVERY_PS=[
  "$ErrorActionPreference='Stop'",
  "$root='C:\\ProgramData\\Nexowire\\hub-cutover-recovery'",
  "$journalPath=Join-Path $root 'journal.json'",
  "$journal=Get-Content -LiteralPath $journalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop",
  "if($journal.version -ne 1 -or [string]$journal.host -cne $env:COMPUTERNAME){throw 'AI04_RECOVERY_JOURNAL_FOREIGN'}",
  "if($journal.phase -in @('COMPLETE','ROLLED_BACK')){exit 0}",
  "$port=[int]$journal.port",
  "if($port -lt 1 -or $port -gt 65535){throw 'AI04_RECOVERY_PORT_UNTRUSTED'}",
  "$boot=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction SilentlyContinue",
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
  "    try{Start-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop}catch{throw 'AI04_RECOVERY_SYSTEM_RESUME_FAILED'}",
  "    throw $divergence",
  "  }",
  "  $current=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction Stop",
  "  if([string]$current.Description -cne [string]$journal.marker -or [string]$current.Principal.UserId -notin @('SYSTEM','S-1-5-18')){throw 'AI04_RECOVERY_BOOT_REPLACED'}",
  "  Unregister-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -Confirm:$false",
  "}",
  "$check=Get-ScheduledTask -TaskName 'Nexowire Hub Boot' -TaskPath '\\' -ErrorAction SilentlyContinue",
  "if($check){throw 'AI04_RECOVERY_BOOT_TASK_REAPPEARED'}",
  "$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect();$folder=$svc.GetFolder('\\')",
  "try{$null=$folder.GetTask('Nexowire Hub Boot');throw 'AI04_RECOVERY_BOOT_VISIBILITY_UNVERIFIED'}catch{if([int]$_.Exception.HResult -ne -2147024894){throw}}",
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
].join('\r\n');

function validateRecoveredScript():void{
  trustedAncestors();
  verifyWindowsPrivateAcl(ROOT);
  verifyWindowsPrivateAcl(RECOVERY);
  verifyWindowsPrivateAcl(JOURNAL);
}
function runRollbackScript():void{
  validateRecoveredScript();
  runPS('& '+psLiteral(RECOVERY));
}
export async function controlledSystemHubCutover(
  trustedCli:string,
):Promise<{booted:true;rollbackArmed:true;physicalRebootAccepted:false;pendingPhysicalAcceptance:true}>{
  ensureElevated();
  const marker='Nexowire pre-logon Hub install '+randomUUID();
  const journal:Journal={
    version:1,host:os.hostname(),phase:'NEW',marker,port:0,
    sourceRoot:'',originalUserPrincipal:'',createdAt:new Date().toISOString(),
  };
  return await runRecoverableSystemHubCutover({
    async preflight(){
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
      const env=parsePersistedHubLauncherEnvironment(await fs.readFile(LAUNCHER,'utf8'));
      journal.sourceRoot=assertCanonicalHubStateSourcePath(env.NEXOWIRE_STATE_DIR);
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
      await fs.mkdir(ROOT,{recursive:false,mode:0o700});
      setProtectedOwner(ROOT);
      hardenWindowsProgramDataAcl(ROOT);
      verifyWindowsPrivateAcl(ROOT);
      await fs.copyFile(LAUNCHER,path.win32.join(ROOT,'original-user-launcher.ps1'),fsConstants.COPYFILE_EXCL);
      privateFileAcl(path.win32.join(ROOT,'original-user-launcher.ps1'));
      const xml=runPS("$ErrorActionPreference='Stop';Export-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\\' -ErrorAction Stop");
      if(!xml.startsWith('<?xml')&&!xml.startsWith('<Task'))throw new Error('AI04_RECOVERY_TASK_XML_UNVERIFIED');
      await privateWrite(path.win32.join(ROOT,'original-user-task.xml'),xml+'\n');
      await privateWrite(RECOVERY,SYSTEM_HUB_RECOVERY_PS+'\r\n');
      await privateWrite(JOURNAL,JSON.stringify({...journal,phase:'ARMED'},null,2)+'\n');
      runPS([
        "$ErrorActionPreference='Stop'",
        "$existing=Get-ScheduledTask -TaskName "+psLiteral(TASK)+" -TaskPath '\\' -ErrorAction SilentlyContinue",
        "if($existing){throw 'AI04_RECOVERY_TASK_ALREADY_EXISTS'}",
        "$script="+psLiteral(RECOVERY),
        "$execute="+psLiteral(POWERSHELL),
        "$action=New-ScheduledTaskAction -Execute $execute -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"'+$script+'\"')",
        "$startup=New-ScheduledTaskTrigger -AtStartup",
        "$timeout=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 365)",
        "$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
        "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)",
        "Register-ScheduledTask -TaskName "+psLiteral(TASK)+" -TaskPath '\\' -Action $action -Trigger @($startup,$timeout) -Principal $principal -Settings $settings -ErrorAction Stop|Out-Null",
        ].join('\n'));
      const taskCheck=runPS("$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName "+
        psLiteral(TASK)+" -TaskPath '\\' -ErrorAction Stop;"+
        "if([string]$t.Principal.UserId -notin @('SYSTEM','S-1-5-18')){throw 'AI04_RECOVERY_TASK_WRONG_PRINCIPAL'};'OK'");
      if(taskCheck!=='OK')throw new Error('AI04_RECOVERY_TASK_UNVERIFIED');
      await advance(journal,'ARMED');
    },
    async quiesceLegacy(){
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
      trustedAncestors();
      await prepareProtectedOfflineSystemHubStateCopy(LAUNCHER,true);
      await advance(journal,'COPIED');
    },
    async issueReceipt(){
      assertInteractiveHubTaskDisabledReadOnly();
      await issueOfflineSystemStateCutoverReceipt(LAUNCHER,true);
      await advance(journal,'RECEIPT_ISSUED');
    },
    async installSystemHub(){
      await advance(journal,'SYSTEM_INSTALLING');
      await installHubBootLifecycle({
        execPath:process.execPath,execArgv:[],
        cliEntrypoint:trustedCli,cutoverInstallMarker:marker,
      });
      await advance(journal,'SYSTEM_STARTED');
    },
    async verifySystemHub(){
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
      try{await fs.lstat(RECOVERY)}catch{
        // The preflight never touched the legacy Hub before recovery creation.
        return;
      }
      runRollbackScript();
      // PowerShell may exit successfully for a previously COMPLETE cutover.
      // Do not report a rollback unless the durable journal confirms one.
      const restored=JSON.parse(await fs.readFile(JOURNAL,'utf8')) as {phase?:unknown};
      if(restored.phase!=='ROLLED_BACK')
        throw new Error('AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING');
    },
  });
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
