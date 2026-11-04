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
    // Job object owns the connector and every descendant. Never start Node via
    // PowerShell's bare & operator: Stop-ScheduledTask kills PowerShell only.
    `$jobSource=@'\\r\\n${WINDOWS_JOB_SOURCE}\\r\\n'@`,
    'Add-Type -TypeDefinition $jobSource -ErrorAction Stop',
    `$exitCode=[NexowireConnectionJob]::Run(${literal(executable)},@(${[cli,'local-first','cloudflare-run',profile].map(literal).join(',')}))`,
    'exit $exitCode',''];
  return '\uFEFF'+lines.join('\r\n');
}
const WINDOWS_JOB_SOURCE=String.raw`using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NexowireConnectionJob {
  // The only inheritable lifetime is the Windows Job Object, not a PID.
  // Create the process suspended so there is never an unmanaged spawn window.
  const uint CREATE_SUSPENDED=0x00000004, CREATE_NO_WINDOW=0x08000000;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x00002000, WAIT_FAILED=0xffffffff;
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit,PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass,SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount;
    public ulong ReadTransferCount,WriteTransferCount,OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public uint cb; public IntPtr lpReserved,lpDesktop,lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;}
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref EXTENDED_LIMIT info,uint size);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="CreateProcessW")]
  static extern bool CreateProcess(string executable,StringBuilder commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string currentDirectory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    StringBuilder b=new StringBuilder("\"");int slashes=0;
    foreach(char ch in value) {
      if(ch=='\\'){slashes++;continue;}
      if(ch=='"'){b.Append('\\',slashes*2+1);b.Append('"');slashes=0;continue;}
      b.Append('\\',slashes);slashes=0;b.Append(ch);
    }
    b.Append('\\',slashes*2);b.Append('"');return b.ToString();
  }
  public static int Run(string executable,string[] args) {
    if(String.IsNullOrEmpty(executable)||!System.IO.Path.IsPathRooted(executable))
      throw new ArgumentException("Expected absolute executable");
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    PROCESS_INFORMATION child=new PROCESS_INFORMATION();bool created=false;
    try {
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT();
      limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder command=new StringBuilder(Quote(executable));
      foreach(string arg in args){command.Append(' ');command.Append(Quote(arg));}
      STARTUPINFO startup=new STARTUPINFO();
      startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,
        CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out child))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      created=true;
      try {
        if(!AssignProcessToJobObject(job,child.hProcess))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if(ResumeThread(child.hThread)==WAIT_FAILED)
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if(WaitForSingleObject(child.hProcess,0xffffffff)!=0)
          throw new Win32Exception(Marshal.GetLastWin32Error());
        uint exitCode;
        if(!GetExitCodeProcess(child.hProcess,out exitCode))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        return unchecked((int)exitCode);
      } catch {
        TerminateProcess(child.hProcess,1);
        throw;
      }
    } finally {
      if(created){CloseHandle(child.hThread);CloseHandle(child.hProcess);}
      // The kernel now kills EVERY descendant still in this job, including
      // when Task Scheduler forcibly terminates this PowerShell owner.
      CloseHandle(job);
    }
  }
}`;
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
 if($taskUser -ne $sid -or [string]$task.Principal.RunLevel -ne 'Limited' -or [string]$task.Principal.LogonType -ne 'Interactive'){$owned=$false}
 if([string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or [int]$task.Settings.RestartCount -gt 3 -or [int]$task.Settings.RestartCount -lt 0){$owned=$false}
 $triggers=@($task.Triggers)
 if($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger'){$owned=$false}
 if($triggers.Count -eq 1){
   $triggerSid=[string]$triggers[0].UserId
   try{if($triggerSid -ne $sid){$triggerSid=([Security.Principal.NTAccount]$triggerSid).Translate([Security.Principal.SecurityIdentifier]).Value}}catch{$owned=$false}
   if($triggerSid -ne $sid){$owned=$false}
 }
 if(-not $owned){throw 'CONNECTION_TASK_NOT_OWNED'}
 if(-not (Test-Path -LiteralPath $launcher -PathType Leaf)){throw 'CONNECTION_LAUNCHER_MISSING'}
 $launcherItem=Get-Item -LiteralPath $launcher -Force
 if(($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CONNECTION_LAUNCHER_REPARSE'}
 $launcherText=[IO.File]::ReadAllText($launcher)
 if(-not $launcherText.StartsWith([char]0xFEFF+'# Nexowire Cloudflare connection user launcher v1')){throw 'CONNECTION_LAUNCHER_UNTRUSTED'}
 foreach($protectedPath in @($launcher,(Split-Path -Parent $launcher))){
   $acl=Get-Acl -LiteralPath $protectedPath
   $aclOwner=$acl.Owner
   try{if($aclOwner -ne $sid){$aclOwner=([Security.Principal.NTAccount]$aclOwner).Translate([Security.Principal.SecurityIdentifier]).Value}}catch{throw 'CONNECTION_LAUNCHER_OWNER_UNKNOWN'}
   if($aclOwner -ne $sid){throw 'CONNECTION_LAUNCHER_OWNER_MISMATCH'}
   foreach($ace in $acl.Access){
     if($ace.AccessControlType -ne 'Allow'){continue}
     try{$aceSid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{throw 'CONNECTION_LAUNCHER_ACL_UNKNOWN'}
     if($aceSid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-32-546')){
       $writeRights=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
       if(($ace.FileSystemRights -band $writeRights) -ne 0){throw 'CONNECTION_LAUNCHER_BROAD_WRITE'}
     }
   }
 }

}
switch($env:NEXOWIRE_CONNECTION_ACTION){
 'install' {
  if($task){throw 'CONNECTION_ALREADY_INSTALLED'}
  $action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $argument
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
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
  if(!/^[A-Za-z0-9 _-]{1,100}$/.test(task)||/^(Nexowire Hub|Nexowire Hub Boot|Nexowire Stack)$/i.test(task))throw Error('Invalid connection task name');
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
