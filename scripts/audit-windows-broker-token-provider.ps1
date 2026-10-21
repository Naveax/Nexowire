# P0 SOURCE-ONLY. Read-only OS provider on THIS disposable test PowerShell.
# Observing our own token is NEVER an installed Broker attestation.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$BrokerImagePath,
 [string]$ExpectedPublisherThumbprint='',
 [string]$ExpectedReleaseSha256=''
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_BROKER_PROVIDER_WINDOWS_ONLY'}
$helperAudit=Join-Path $PSScriptRoot 'audit-windows-job-helper-trust.ps1'
$trustJson=& $helperAudit -HelperPath $BrokerImagePath -ExpectedPublisherThumbprint $ExpectedPublisherThumbprint -ExpectedReleaseSha256 $ExpectedReleaseSha256
$fileTrust=$trustJson | ConvertFrom-Json -ErrorAction Stop
$integrityRid=$null;$elevated=$null;$tokenError=''
try {
$definition=@'
using System;
using System.Runtime.InteropServices;
public static class NxTestOnlyTokenQuery {
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("advapi32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool OpenProcessToken(IntPtr process,uint rights,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool GetTokenInformation(IntPtr token,int info,IntPtr data,int length,out int returned);
 [DllImport("advapi32.dll",SetLastError=true)]
 public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll",SetLastError=true)]
 public static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 [DllImport("kernel32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool CloseHandle(IntPtr handle);
}
'@
if(-not ('NxTestOnlyTokenQuery' -as [type])){
 Add-Type -TypeDefinition $definition -ErrorAction Stop
}
$token=[IntPtr]::Zero
if(-not [NxTestOnlyTokenQuery]::OpenProcessToken([NxTestOnlyTokenQuery]::GetCurrentProcess(),8,[ref]$token)){
 throw 'TOKEN_QUERY_OPEN_DENIED'
}
try{
 $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
 try{
  $written=0
  if(-not [NxTestOnlyTokenQuery]::GetTokenInformation($token,25,$ptr,1024,[ref]$written)){
    throw 'TOKEN_INTEGRITY_UNAVAILABLE'
  }
  $sid=[Runtime.InteropServices.Marshal]::ReadIntPtr($ptr)
  if($sid -eq [IntPtr]::Zero){throw 'TOKEN_INTEGRITY_SID_UNAVAILABLE'}
  $countPtr=[NxTestOnlyTokenQuery]::GetSidSubAuthorityCount($sid)
  $count=[Runtime.InteropServices.Marshal]::ReadByte($countPtr)
  if($count -eq 0){throw 'TOKEN_INTEGRITY_SUBAUTHORITY_EMPTY'}
  $last=[NxTestOnlyTokenQuery]::GetSidSubAuthority($sid,[uint32]($count-1))
  $integrityRid=[Runtime.InteropServices.Marshal]::ReadInt32($last)
  if(-not [NxTestOnlyTokenQuery]::GetTokenInformation($token,20,$ptr,4,[ref]$written)){
    throw ('TOKEN_ELEVATION_UNAVAILABLE_'+[Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $elevated=[Runtime.InteropServices.Marshal]::ReadInt32($ptr) -eq 1
 }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}
}finally{[void][NxTestOnlyTokenQuery]::CloseHandle($token)}
}catch{$tokenError=$_.Exception.GetType().Name+':'+$_.Exception.Message}
# Independent Win32 creation FILETIME is recorded for THIS test-process ONLY.
# This is NOT an attestation of any installed Broker PID, imports or token.
$selfPid=$PID
$selfCreationFiletime=$null
$selfCreationError=''
try{
 $created=[int64]0;$exited=[int64]0;$kernel=[int64]0;$user=[int64]0
 if(-not [NxTestOnlyTokenQuery]::GetProcessTimes(
    [NxTestOnlyTokenQuery]::GetCurrentProcess(),
    [ref]$created,[ref]$exited,[ref]$kernel,[ref]$user
 )){throw ('OWN_PROCESS_CREATION_QUERY_FAILED_'+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 $selfCreationFiletime=[string]$created
}catch{$selfCreationError=$_.Exception.GetType().Name+':'+$_.Exception.Message}
$principal=[Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())
$adminEnabled=$false
try{$adminEnabled=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{}
$tokenAvailable=($null -ne $integrityRid) -and ($null -ne $elevated)
[ordered]@{
 kind='windows_core_broker_provider_readonly_v1'
 evaluatedImage=[IO.Path]::GetFullPath($BrokerImagePath)
 imageEvidence=$fileTrust
 ownInspectingProcessToken=[ordered]@{
   provider='native GetTokenInformation(TokenIntegrityLevel+TokenElevation)'
   evidenceAvailable=[bool]$tokenAvailable
   evidenceError=$tokenError
   integrityRid=$integrityRid
   elevated=$elevated
   administratorsEnabled=[bool]$adminEnabled
   highIntegrity=$(if($tokenAvailable){$integrityRid -ge 12288}else{$null})
 }
 ownInspectingProcessIdentity=[ordered]@{
   pid=$selfPid
   creationFiletime=$selfCreationFiletime
   creationEvidenceAvailable=($null -ne $selfCreationFiletime)
   creationEvidenceError=$selfCreationError
   provider='native GetProcessTimes(current-process pseudo-handle)'
 }
 brokerProcessPidAttested=$false
 brokerProcessCreationFiletimeAttested=$false
 lowPrivilegeDupHandleDeniedByBrokerAcl=$false
 brokerProcessImageIdentityAttested=$false
 brokerOwnerDeviceEpochAttested=$false
 protectedBrokerImportTreeAttested=$false
 trustedSignedReleaseManifestAttested=$false
 highTokenBrokerIdentityAttested=$false
 elevatedCoreDispatchEnabled=$false
 productionReady=$false
} | ConvertTo-Json -Compress -Depth 8
