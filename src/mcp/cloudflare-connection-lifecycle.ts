import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {persistedHubEnvironment} from '../hub/hub-lifecycle.js';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';
import {loadConfig} from '../config.js';
import {cloudflareConnectionConfig} from './local-first-cloudflare.js';

const PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASK='Nexowire Cloudflare Connection';
type Action='install'|'status'|'start'|'stop'|'uninstall';
export interface CloudflareLifecycleOptions{
  root?:string;taskName?:string;env?:NodeJS.ProcessEnv;executable?:string;cli?:string;
}
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
function absolute(value:string){
  if(!path.isAbsolute(value)||/[\r\n\0]/.test(value))throw Error('Connection lifecycle needs absolute paths');
  return value;
}
export function buildCloudflareConnectionLauncher(profile:string,options:CloudflareLifecycleOptions={}){
  absolute(profile);
  const executable=absolute(options.executable??process.execPath);
  const cli=absolute(options.cli??process.argv[1]??'');
  const env=persistedHubEnvironment(options.env??process.env);
  const lines=['# Nexowire Cloudflare connection user launcher v1',"$ErrorActionPreference='Stop'","$ProgressPreference='SilentlyContinue'",
    // Prevent user/system Node preloads, proxy/tunnel overrides and secret
    // environment inheritance from changing the scheduled runtime.
    "Get-ChildItem Env: | Where-Object { $_.Name -match '^(NEXOWIRE_|TUNNEL_|NODE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)' } | ForEach-Object { Remove-Item ('Env:'+$_.Name) }",
    ...Object.entries(env).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`$env:${k}=${literal(v)}`),
    `& ${literal(executable)} ${[cli,'local-first','cloudflare-run',profile].map(literal).join(' ')}`,
    'exit $LASTEXITCODE',''];
  return '\uFEFF'+lines.join('\r\n');
}
const SCRIPT=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$name=$env:NEXOWIRE_CONNECTION_TASK
$launcher=$env:NEXOWIRE_CONNECTION_LAUNCHER
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$argument='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcher+'"'
$task=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
if($task){
 $actions=@($task.Actions)
 $owned=$actions.Count -eq 1 -and $actions[0].Execute -ceq 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -and $actions[0].Arguments -ceq $argument
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $taskUser=$task.Principal.UserId
 try{if($taskUser -ne $sid){$taskUser=([Security.Principal.NTAccount]$taskUser).Translate([Security.Principal.SecurityIdentifier]).Value}}catch{$owned=$false}
 if($taskUser -ne $sid -or [string]$task.Principal.RunLevel -ne 'Limited'){$owned=$false}
 if(-not $owned){throw 'CONNECTION_TASK_NOT_OWNED'}
}
switch($env:NEXOWIRE_CONNECTION_ACTION){
 'install' {
  if($task){throw 'CONNECTION_ALREADY_INSTALLED'}
  $action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $argument
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire Cloudflare-only MCP connection' | Out-Null
 }
 'start' {if(-not $task){throw 'CONNECTION_NOT_INSTALLED'};Start-ScheduledTask -InputObject $task}
 'stop' {if($task){Stop-ScheduledTask -InputObject $task}}
 'uninstall' {if($task){if($task.State -in @('Running','Queued')){throw 'CONNECTION_STOP_BEFORE_UNINSTALL'};Unregister-ScheduledTask -InputObject $task -Confirm:$false}}
 'status' {}
 default {throw 'INVALID_CONNECTION_ACTION'}
}
$task=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
[pscustomobject]@{installed=($null -ne $task);state=$(if($task){[string]$task.State}else{'NotInstalled'});autostart=($null -ne $task -and @($task.Triggers).Count -gt 0);limited=($null -ne $task -and [string]$task.Principal.RunLevel -eq 'Limited')} | ConvertTo-Json -Compress
`;
async function operate(action:Action,launcher:string,taskName:string){
  return await new Promise<{installed:boolean;state:string;autostart:boolean;limited:boolean}>((resolve,reject)=>{
    const child=spawn(PS,['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT],{
      cwd:'C:\\Windows\\System32',windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...windowsDpapiChildEnvironment(),NEXOWIRE_CONNECTION_ACTION:action,
        NEXOWIRE_CONNECTION_TASK:taskName,NEXOWIRE_CONNECTION_LAUNCHER:launcher},
    });
    let out='',done=false;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);
      if(error){reject(error);return;}
      try{const value=JSON.parse(out);if(typeof value.installed!=='boolean'||typeof value.state!=='string'||typeof value.autostart!=='boolean'||typeof value.limited!=='boolean')throw Error();resolve(value);}
      catch{reject(Error('Invalid connection task status'));}
    };
    const timer=setTimeout(()=>{child.kill();finish(Error('Connection task operation timed out'));},30000);
    child.stdout.on('data',b=>{out+=String(b);if(out.length>65536){child.kill();finish(Error('Connection task output exceeded bound'));}});
    child.stderr.resume();
    child.once('error',()=>finish(Error('Connection task controller unavailable')));
    child.once('close',code=>finish(code===0?undefined:Error('Connection task operation refused; existing task was not overwritten')));
  });
}
export async function cloudflareConnectionLifecycle(action:Action,profile?:string,options:CloudflareLifecycleOptions={}){
  if(process.platform!=='win32')throw Error('Cloudflare connection autostart currently supports Windows user logon');
  const root=absolute(options.root??path.join(os.homedir(),'.nexowire','cloudflare-connection'));
  const task=options.taskName??TASK;
  if(!/^[A-Za-z0-9 _-]{1,100}$/.test(task))throw Error('Invalid connection task name');
  const launcher=path.join(root,'launch.ps1');
  if(action!=='install'){
    if(action!=='uninstall')return await operate(action,launcher,task);
    const before=await operate('status',launcher,task);
    const result=await operate(action,launcher,task);
    if(before.installed&&!result.installed){
      const source=await fs.readFile(launcher,'utf8');
      if(source.startsWith('\uFEFF# Nexowire Cloudflare connection user launcher v1'))await fs.unlink(launcher);
    }
    return result;
  }
  if(!profile)throw Error('Connection install requires one absolute profile path');
  absolute(profile);
  const stat=await fs.lstat(profile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Invalid connection profile file');
  cloudflareConnectionConfig(JSON.parse(await fs.readFile(profile,'utf8')),loadConfig(options.env??process.env));
  const source=buildCloudflareConnectionLauncher(profile,options);
  const status=await operate('status',launcher,task);
  if(status.installed)throw Error('Connection already installed; stop/uninstall before replacing it');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  // Exclusive creation refuses an unknown launcher and concurrent installers.
  await fs.writeFile(launcher,source,{flag:'wx',mode:0o600});
  try{return await operate('install',launcher,task);}
  catch(error){
    // A timeout may have committed registration. Retain its launcher whenever
    // current ownership cannot be established; never break an installed task.
    try{if(!(await operate('status',launcher,task)).installed)await fs.unlink(launcher);}catch{}
    throw error;
  }
}
