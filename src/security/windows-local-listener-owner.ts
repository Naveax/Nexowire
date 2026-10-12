import {spawnSync} from 'node:child_process';
import {protectedWindowsAclEnvironment} from './windows-programdata-acl.js';

const SYSTEM32='C:\\Windows\\System32';
const SYSTEM_POWERSHELL=SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Read-only Windows acceptance gate. An arbitrary local HTTP server may
 * answer /health on the old Hub port while a different (unrelated) PID is
 * alive. Require the actual Listening TCP socket owner to be the PID
 * written by the protected SYSTEM task launcher.
 */
export function assertWindowsLocalTcpListenerOwnedByPid(port:number,pid:number):void {
  if(process.platform!=='win32')throw new Error('HUB_BOOT_LISTENER_WINDOWS_ONLY');
  if(!Number.isInteger(port)||port<1||port>65535||
     !Number.isSafeInteger(pid)||pid<1||pid>2147483647){
    throw new Error('HUB_BOOT_LISTENER_IDENTITY_INVALID');
  }
  const script=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetTCPIP\NetTCPIP.psd1' -ErrorAction Stop
$listenPort=[int]$env:NEXOWIRE_HUB_LISTENER_PORT
$expectedProcess=[int]$env:NEXOWIRE_HUB_LISTENER_PID
$connections=@(Get-NetTCPConnection -State Listen -LocalPort $listenPort -ErrorAction SilentlyContinue)
if(@($connections|Where-Object {[int]$_.OwningProcess -eq $expectedProcess}).Count -lt 1){
  throw 'HUB_BOOT_LISTENER_PROCESS_MISMATCH'
}
Write-Output 'HUB_BOOT_LISTENER_PID_VERIFIED'
`;
  const result=spawnSync(SYSTEM_POWERSHELL,[
    '-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64'),
  ],{
    windowsHide:true,shell:false,cwd:SYSTEM32,encoding:'utf8',
    env:{
      ...protectedWindowsAclEnvironment(),
      NEXOWIRE_HUB_LISTENER_PORT:String(port),
      NEXOWIRE_HUB_LISTENER_PID:String(pid),
    },
    timeout:12000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],
  });
  if(result.error||result.status!==0||
     result.stdout.trim()!=='HUB_BOOT_LISTENER_PID_VERIFIED'){
    throw new Error('HUB_BOOT_LISTENER_PID_MISMATCH');
  }
}