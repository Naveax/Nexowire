import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildNativeAgentLauncher,WINDOWS_NATIVE_AGENT_TASK_SETTINGS} from './native-agent-lifecycle.js';
import {isWindowsProcessElevated} from './privileged-broker.js';
import {hubBootLifecycleStatus} from '../hub/hub-boot-lifecycle.js';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted,validatePrivilegedRuntimePaths} from '../security/windows-privileged-runtime-trust.js';
import {hardenWindowsProgramDataAcl,verifyWindowsPrivateAcl} from '../security/windows-programdata-acl.js';
import {inspectProtectedSecretFile,readProtectedSecretFile,writeProtectedSecretFile} from '../security/protected-secret-files.js';
import {
  WINDOWS_PRELOGIN_AGENT_ROOT,WINDOWS_PRELOGIN_AGENT_STATE_ROOT,
  WINDOWS_PRELOGIN_AGENT_PATHS,assertWindowsPreloginStartupConfiguration,
} from './windows-prelogin-bootstrap.js';

const TASK='Nexowire Prelogin Agent';
const HUB_TASK='Nexowire Hub Boot';
const SYSTEM32='C:\\Windows\\System32';
const POWERSHELL=SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const MARKER_PREFIX='Nexowire controlled prelogin agent v1 ';
const LAUNCHER=WINDOWS_PRELOGIN_AGENT_ROOT+'\\launch.ps1';
const LAUNCH_ARGS='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+LAUNCHER+'"';
const FILES=new Set(['launch.ps1','agent.json','agent-token.machine.dpapi.json','installation.json','state']);
const TOKEN_SOURCE=path.win32.join(os.homedir(),'.nexowire','secrets','agent-bearer-token.dpapi.json');

export interface SystemAgentPreloginPlan {
  taskName:string;root:string;stateRoot:string;launcher:string;
  manifest:string;tokenFile:string;identityFile:string;
  executable:string;cliEntrypoint:string;jobHelper:string;
}
export interface SystemAgentPreloginStatus {
  staged:boolean;installed:boolean;taskState:string;
  taskIdentityVerified:boolean;hubBootInstalled:boolean;
  markerPresent:boolean;readyForPhysicalReboot:false;
}

export function planSystemAgentPrelogin(
  executable:string,cliEntrypoint:string,
):SystemAgentPreloginPlan{
  if(!path.win32.isAbsolute(executable)||!path.win32.isAbsolute(cliEntrypoint))
    throw new Error('PRELOGIN_AGENT_ABSOLUTE_RUNTIME_PATH_REQUIRED');
  const helper=path.win32.resolve(path.win32.dirname(cliEntrypoint),'..','native','windows-job-owner.exe');
  return {
    taskName:TASK,root:WINDOWS_PRELOGIN_AGENT_ROOT,
    stateRoot:WINDOWS_PRELOGIN_AGENT_STATE_ROOT,
    launcher:path.win32.join(WINDOWS_PRELOGIN_AGENT_ROOT,'launch.ps1'),
    manifest:path.win32.join(WINDOWS_PRELOGIN_AGENT_ROOT,'installation.json'),
    identityFile:WINDOWS_PRELOGIN_AGENT_PATHS.NEXOWIRE_AGENT_IDENTITY_FILE,
    tokenFile:WINDOWS_PRELOGIN_AGENT_PATHS.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE,
    executable,cliEntrypoint,jobHelper:helper,
  };
}

export function systemAgentPreloginEnvironment():NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={
    ...WINDOWS_PRELOGIN_AGENT_PATHS,
    NEXOWIRE_WINDOWS_PRELOGIN_AGENT:'1',
    NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:43110/agent',
    NEXOWIRE_DEVICE_NAME:os.hostname()+' (prelogin)',
  };
  assertWindowsPreloginStartupConfiguration(env,'win32');
  return env;
}

export function renderSystemAgentPreloginLauncher(plan:SystemAgentPreloginPlan):string{
  const env=systemAgentPreloginEnvironment();
  return buildNativeAgentLauncher({
    platform:'win32',execPath:plan.executable,
    cliEntrypoint:plan.cliEntrypoint,execArgv:[],env,
    windowsTaskJobOwnerPath:plan.jobHelper,
    windowsTaskJobStatusDir:plan.stateRoot,
  });
}

function assertWindowsElevation():void{
  if(process.platform!=='win32')throw new Error('PRELOGIN_AGENT_WINDOWS_ONLY');
  if(!isWindowsProcessElevated())throw new Error('PRELOGIN_AGENT_ELEVATION_REQUIRED');
}

function ps(value:string):string {
  return "'"+value.replaceAll("'","''")+"'";
}

function taskShell(script:string):unknown{
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const result=spawnSync(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{
    cwd:SYSTEM32,windowsHide:true,shell:false,timeout:30_000,
    encoding:'utf8',maxBuffer:256*1024,stdio:['ignore','pipe','pipe'],
    env:{
      SystemRoot:'C:\\Windows',windir:'C:\\Windows',
      ComSpec:SYSTEM32+'\\cmd.exe',
      PATH:SYSTEM32+';C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    },
  });
  if(result.error||result.status!==0)
    throw new Error('PRELOGIN_AGENT_TASK_OPERATION_FAILED');
  try{return JSON.parse(result.stdout.trim()) as unknown}
  catch{throw new Error('PRELOGIN_AGENT_TASK_RESULT_INVALID')}
}

interface TaskProbe {installed:boolean;state:string;identityVerified:boolean;hubBoot:boolean;description:string}
function queryTaskState():TaskProbe{
  const data=taskShell([
    "$ErrorActionPreference='Stop'",
    "$t=Get-ScheduledTask -TaskPath '\\' -TaskName "+ps(TASK)+" -ErrorAction SilentlyContinue",
    "$h=Get-ScheduledTask -TaskPath '\\' -TaskName "+ps(HUB_TASK)+" -ErrorAction SilentlyContinue",
    "$verified=$false",
    "if($t){",
    "  $principal=[string]$t.Principal.UserId",
    "  try{$principal=(New-Object System.Security.Principal.NTAccount($principal)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
    "  $system=($principal -eq 'S-1-5-18')",
    "  $boot=(@($t.Triggers).Count -eq 1 -and @($t.Triggers|Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'}).Count -eq 1)",
    "  $action=(@($t.Actions).Count -eq 1 -and ([string]$t.Actions[0].Execute -ieq "+ps(POWERSHELL)+") -and ([string]$t.Actions[0].Arguments -ceq "+ps(LAUNCH_ARGS)+"))",
    "  $desc=([string]$t.Description).StartsWith("+ps(MARKER_PREFIX)+")",
    "  $verified=($system -and $boot -and $action -and $desc -and ([string]$t.Principal.LogonType -eq 'ServiceAccount') -and ([string]$t.Principal.RunLevel -eq 'Highest'))",
    "}",
    "[pscustomobject]@{installed=($null-ne$t);state=$(if($t){[string]$t.State}else{'not-installed'});identityVerified=$verified;hubBoot=($null-ne$h);description=$(if($t){[string]$t.Description}else{''})} | ConvertTo-Json -Compress",
  ].join('\n')) as Partial<TaskProbe>;
  if(typeof data.installed!=='boolean'||typeof data.state!=='string'||
      typeof data.identityVerified!=='boolean'||typeof data.hubBoot!=='boolean'||
      typeof data.description!=='string')
    throw new Error('PRELOGIN_AGENT_TASK_READBACK_INVALID');
  return {installed:data.installed,state:data.state,
    identityVerified:data.identityVerified,hubBoot:data.hubBoot,
    description:data.description};
}

interface StagedManifest {
  version:1;
  marker:string;
  runtimeSha256:string;
  createdAt:string;
}
async function readManifest(plan:SystemAgentPreloginPlan):Promise<StagedManifest|null>{
  let raw:string;
  try{raw=await fs.readFile(plan.manifest,'utf8')}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw error;
  }
  const value=JSON.parse(raw) as Partial<StagedManifest>;
  if(value.version!==1||typeof value.marker!=='string'||
     !value.marker.startsWith(MARKER_PREFIX)||typeof value.runtimeSha256!=='string'||
     !/^[a-f0-9]{64}$/.test(value.runtimeSha256))
    throw new Error('PRELOGIN_AGENT_STAGE_MANIFEST_INVALID');
  return value as StagedManifest;
}

export async function systemAgentPreloginStatus():Promise<SystemAgentPreloginStatus>{
  if(process.platform!=='win32')throw new Error('PRELOGIN_AGENT_WINDOWS_ONLY');
  const task=queryTaskState();
  const plan=planSystemAgentPrelogin(process.execPath,process.argv[1]??'');
  let staged=false;
  try{staged=(await fs.lstat(plan.root)).isDirectory()}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const markerPresent=staged?(await readManifest(plan))!==null:false;
  let trustedHub=false;
  try{
    const hub=await hubBootLifecycleStatus();
    trustedHub=hub.installed&&['ready','running'].includes(hub.state);
  }catch{ /* Foreign or unreadable SYSTEM Hub is never a trusted boot task. */ }
  return {staged,installed:task.installed,taskState:task.state,
    taskIdentityVerified:task.identityVerified,hubBootInstalled:trustedHub,
    markerPresent,readyForPhysicalReboot:false};
}

function ensureRuntime(plan:SystemAgentPreloginPlan):void {
  assertWindowsElevation();
  assertNoPrivilegedNodeStartupFlags(process.execArgv);
  const {codeRoot}=validatePrivilegedRuntimePaths({
    executable:plan.executable,cliEntrypoint:plan.cliEntrypoint,
  });
  if(!plan.jobHelper.toLowerCase().startsWith(path.win32.resolve(codeRoot).toLowerCase()+'\\'))
    throw new Error('PRELOGIN_AGENT_JOB_HELPER_OUTSIDE_TRUSTED_RUNTIME');
  assertWindowsPrivilegedRuntimeTrusted({
    executable:plan.executable,cliEntrypoint:plan.cliEntrypoint,env:process.env,
  });
  verifyWindowsPrivateAcl(path.win32.dirname(plan.root));
}

async function verifyHelper(plan:SystemAgentPreloginPlan):Promise<void>{
  const helper=await fs.lstat(plan.jobHelper);
  if(!helper.isFile()||helper.isSymbolicLink())
    throw new Error('PRELOGIN_AGENT_JOB_HELPER_UNTRUSTED');
  const expected=(await fs.readFile(plan.jobHelper.replace(/\.exe$/i,'.sha256'),'utf8')).trim().toLowerCase();
  const actual=createHash('sha256').update(await fs.readFile(plan.jobHelper)).digest('hex');
  if(expected!==actual)throw new Error('PRELOGIN_AGENT_JOB_HELPER_HASH_MISMATCH');
}

async function assertOwnedStage(plan:SystemAgentPreloginPlan):Promise<StagedManifest> {
  verifyWindowsPrivateAcl(plan.root);
  verifyWindowsPrivateAcl(plan.stateRoot);
  for(const p of [plan.launcher,plan.manifest,plan.identityFile,plan.tokenFile])
    verifyWindowsPrivateAcl(p);
  const manifest=await readManifest(plan);
  if(!manifest)throw new Error('PRELOGIN_AGENT_STAGE_NOT_PRESENT');
  const entries=await fs.readdir(plan.root,{withFileTypes:true});
  if(entries.some(x=>!FILES.has(x.name)||x.isSymbolicLink()||
    (x.name==='state'?!x.isDirectory():!x.isFile())))
    throw new Error('PRELOGIN_AGENT_STAGE_CONTENT_UNEXPECTED');
  const token=inspectProtectedSecretFile(plan.tokenFile);
  if(token.protection!=='windows-dpapi-local-machine'||token.purpose!=='agent-bearer-token')
    throw new Error('PRELOGIN_AGENT_MACHINE_DPAPI_REQUIRED');
  const expected=createHash('sha256').update(await fs.readFile(plan.launcher)).digest('hex');
  if(expected!==manifest.runtimeSha256)
    throw new Error('PRELOGIN_AGENT_STAGE_LAUNCHER_CHANGED');
  return manifest;
}

export async function stageSystemAgentPrelogin():Promise<SystemAgentPreloginStatus>{
  const plan=planSystemAgentPrelogin(process.execPath,process.argv[1]??'');
  ensureRuntime(plan);
  await verifyHelper(plan);
  const task=queryTaskState();
  if(task.installed)throw new Error('PRELOGIN_AGENT_TASK_ALREADY_EXISTS');
  if(await fs.lstat(plan.root).then(()=>true).catch(e=>{
    if((e as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw e;
  })) throw new Error('PRELOGIN_AGENT_STAGE_ALREADY_EXISTS');

  const source=inspectProtectedSecretFile(TOKEN_SOURCE);
  if(source.protection!=='windows-dpapi-current-user'||source.purpose!=='agent-bearer-token')
    throw new Error('PRELOGIN_AGENT_SOURCE_USER_DPAPI_REQUIRED');
  const secret=readProtectedSecretFile(TOKEN_SOURCE,'agent-bearer-token','agent bearer token');
  let created=false;
  try{
    await fs.mkdir(plan.root,{mode:0o700});created=true;
    hardenWindowsProgramDataAcl(plan.root);
    await fs.writeFile(plan.identityFile,JSON.stringify({id:randomUUID()})+'\n',{flag:'wx',mode:0o600});
    await writeProtectedSecretFile(plan.tokenFile,'agent-bearer-token',secret,{scope:'local-machine'});
    const launcher=renderSystemAgentPreloginLauncher(plan);
    await fs.writeFile(plan.launcher,launcher,{flag:'wx',encoding:'utf8',mode:0o600});
    const manifest:StagedManifest={
      version:1,marker:MARKER_PREFIX+randomUUID(),
      runtimeSha256:createHash('sha256').update(launcher,'utf8').digest('hex'),
      createdAt:new Date().toISOString(),
    };
    await fs.writeFile(plan.manifest,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
    // Harden the flat root before introducing the nested state directory.
    hardenWindowsProgramDataAcl(plan.root);
    await fs.mkdir(plan.stateRoot,{mode:0o700});
    hardenWindowsProgramDataAcl(plan.stateRoot);
    await assertOwnedStage(plan);
    return await systemAgentPreloginStatus();
  }catch(error){
    if(created&&!queryTaskState().installed){
      try{await assertSafeStageCleanup(plan)}catch{
        throw new AggregateError([error],'PRELOGIN_AGENT_STAGING_NEEDS_MANUAL_RECOVERY');
      }
      await fs.rm(plan.root,{recursive:true,force:false});
    }
    throw error;
  }
}

async function assertSafeStageCleanup(plan:SystemAgentPreloginPlan):Promise<void>{
  const top=await fs.readdir(plan.root,{withFileTypes:true});
  if(top.some(x=>!FILES.has(x.name)||x.isSymbolicLink()||
    (x.name==='state'?!x.isDirectory():!x.isFile())))
    throw new Error('PRELOGIN_AGENT_UNEXPECTED_STAGE_CONTENT');
  const nested=top.find(x=>x.name==='state');
  if(nested&&(await fs.readdir(plan.stateRoot)).length!==0)
    throw new Error('PRELOGIN_AGENT_STATE_NOT_EMPTY');
}

/** Register only the own exact SYSTEM AtStartup task. No user-Agent handoff or
 * reboot occurs here. A verified SYSTEM Hub boot task is a prerequisite. */
export async function installStagedSystemAgentPrelogin():Promise<SystemAgentPreloginStatus>{
  const plan=planSystemAgentPrelogin(process.execPath,process.argv[1]??'');
  ensureRuntime(plan);
  await verifyHelper(plan);
  const before=queryTaskState();
  if(before.installed)throw new Error('PRELOGIN_AGENT_EXISTING_TASK_INSTALL_DENIED');
  const hub=await hubBootLifecycleStatus();
  if(!hub.installed||!['ready','running'].includes(hub.state))
    throw new Error('PRELOGIN_AGENT_TRUSTED_SYSTEM_HUB_BOOT_REQUIRED');
  const manifest=await assertOwnedStage(plan);
  const args=LAUNCH_ARGS;
  try{
    const result=taskShell([
      "$ErrorActionPreference='Stop'",
      "$name="+ps(plan.taskName),
      "$task=Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction SilentlyContinue",
      "if($task){throw 'PRELOGIN_AGENT_TASK_ALREADY_EXISTS'}",
      "$action=New-ScheduledTaskAction -Execute "+ps(POWERSHELL)+" -Argument "+ps(args),
      "$trigger=New-ScheduledTaskTrigger -AtStartup",
      "$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
      WINDOWS_NATIVE_AGENT_TASK_SETTINGS,
      "Register-ScheduledTask -TaskPath '\\' -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "+ps(manifest.marker)+" | Out-Null",
      "[pscustomobject]@{registered=$true}|ConvertTo-Json -Compress",
    ].join('\n')) as {registered?:unknown};
    if(result.registered!==true)throw new Error('PRELOGIN_AGENT_TASK_INSTALL_UNCONFIRMED');
    const after=queryTaskState();
    if(!after.installed||!after.identityVerified||after.description!==manifest.marker)
      throw new Error('PRELOGIN_AGENT_TASK_POST_INSTALL_IDENTITY_UNVERIFIED');
    return await systemAgentPreloginStatus();
  }catch(error){
    // Scheduler can create the task before a later readback/JSON failure.
    // Roll back only if the exact marker and trusted SYSTEM task match.
    let observed:TaskProbe;
    try{observed=queryTaskState()}catch(probeError){
      throw new AggregateError([error,probeError],'PRELOGIN_AGENT_TASK_INSTALL_STATE_UNKNOWN');
    }
    if(observed.installed){
      if(!observed.identityVerified||observed.description!==manifest.marker)
        throw new AggregateError([error],'PRELOGIN_AGENT_FOREIGN_TASK_PRESERVED');
      try{await uninstallSystemAgentPrelogin()}
      catch(rollbackError){
        throw new AggregateError([error,rollbackError],'PRELOGIN_AGENT_TASK_INSTALL_ROLLBACK_FAILED');
      }
    }
    throw error;
  }
}


/**
 * Controlled rollback: only remove our exact task and preserve the machine
 * identity, sealed token and operation journal for reconciliation. Never
 * touch the interactive owner Agent, its profile, or SYSTEM Hub Boot.
 */
export async function uninstallSystemAgentPrelogin():Promise<SystemAgentPreloginStatus>{
  const plan=planSystemAgentPrelogin(process.execPath,process.argv[1]??'');
  ensureRuntime(plan);
  const task=queryTaskState();
  if(!task.installed)return await systemAgentPreloginStatus();
  if(!task.identityVerified)throw new Error('PRELOGIN_AGENT_FOREIGN_TASK_UNINSTALL_DENIED');
  const manifest=await assertOwnedStage(plan);
  if(task.description!==manifest.marker)
    throw new Error('PRELOGIN_AGENT_TASK_MARKER_MISMATCH');
  const result=taskShell([
    "$ErrorActionPreference='Stop'",
    "$name="+ps(TASK),
    "$expected="+ps(manifest.marker),
    "$t=Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction Stop",
    "if(([string]$t.Description) -cne $expected){throw 'PRELOGIN_AGENT_TASK_MARKER_MISMATCH'}",
    "$principal=[string]$t.Principal.UserId",
    "try{$principal=(New-Object System.Security.Principal.NTAccount($principal)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
    "if($principal -ne 'S-1-5-18'){throw 'PRELOGIN_AGENT_FOREIGN_PRINCIPAL'}",
    "if(([string]$t.Principal.LogonType) -ne 'ServiceAccount' -or ([string]$t.Principal.RunLevel) -ne 'Highest'){throw 'PRELOGIN_AGENT_FOREIGN_LOGON_TYPE'}",
    "if(@($t.Triggers).Count -ne 1 -or @($t.Triggers|Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'}).Count -ne 1){throw 'PRELOGIN_AGENT_FOREIGN_TRIGGER'}",
    "if(@($t.Actions).Count -ne 1 -or ([string]$t.Actions[0].Execute -ine "+ps(POWERSHELL)+") -or ([string]$t.Actions[0].Arguments -cne "+ps(LAUNCH_ARGS)+")){throw 'PRELOGIN_AGENT_FOREIGN_ACTION'}",
    "if(([string]$t.State) -eq 'Running'){Stop-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction Stop;Start-Sleep -Milliseconds 500}",
    "Unregister-ScheduledTask -TaskPath '\\' -TaskName $name -Confirm:$false -ErrorAction Stop",
    "$after=Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction SilentlyContinue",
    "if($after){throw 'PRELOGIN_AGENT_UNREGISTER_READBACK_FAILED'}",
    "[pscustomobject]@{unregistered=$true}|ConvertTo-Json -Compress",
  ].join('\n')) as {unregistered?:unknown};
  if(result.unregistered!==true||queryTaskState().installed)
    throw new Error('PRELOGIN_AGENT_TASK_UNINSTALL_UNCONFIRMED');
  return await systemAgentPreloginStatus();
}

export async function runSystemAgentPreloginLifecycleCommand(args:readonly string[]):Promise<void>{
  if(args.length!==1)throw new Error('Usage: agent prelogin-status|prelogin-stage|prelogin-install|prelogin-uninstall');
  const action=args[0];
  const result=action==='prelogin-status'
    ? await systemAgentPreloginStatus()
    : action==='prelogin-stage'
      ? await stageSystemAgentPrelogin()
      : action==='prelogin-install'
        ? await installStagedSystemAgentPrelogin()
        : action==='prelogin-uninstall'
          ? await uninstallSystemAgentPrelogin()
          : (()=>{throw new Error('Unknown prelogin lifecycle action')})();
  process.stdout.write(JSON.stringify(await result,null,2)+'\n');
}
