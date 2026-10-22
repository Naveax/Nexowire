# Read-only native PID identity and DUP_HANDLE access inquiry.
# Only caller-created TEMP-owned synthetic pwsh/powershell with marker.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$FixtureRoot,
 [Parameter(Mandatory=$true)][int]$TargetPid,
 [Parameter(Mandatory=$true)][string]$ExpectedMarker,
 [Parameter(Mandatory=$true)][string]$ExpectedImagePath,
 [string]$ExpectedCreationFiletime=''
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_ONLY'}
$root=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $root.StartsWith($temp+'\', [StringComparison]::OrdinalIgnoreCase)){throw 'ONLY_TEMP_SYNTHETIC_PROCESS_ALLOWED'}
$markerFile=Join-Path $root '.nx03-test-owned-process'
if(-not [IO.File]::Exists($markerFile) -or
   [IO.File]::ReadAllText($markerFile).Trim() -cne $ExpectedMarker -or
   $ExpectedMarker -notmatch '^NX03_FIXTURE_[a-f0-9]{32}$'){
 throw 'PROCESS_FIXTURE_OWNERSHIP_MARKER_INVALID'
}
if($TargetPid -le 0 -or $TargetPid -eq $PID){throw 'NOT_A_SYNTHETIC_CHILD_PID'}
$expectedImage=[IO.Path]::GetFullPath($ExpectedImagePath)
if([IO.Path]::GetFileName($expectedImage) -notin @('pwsh.exe','powershell.exe')){
 throw 'SYNTHETIC_POWERSHELL_ONLY'
}
$wmi=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop
if($null -eq $wmi -or $wmi.CommandLine -notlike ('*'+$ExpectedMarker+'*')){
 throw 'UNRELATED_PROCESS_NOT_INSPECTED'
}
$code=@'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class Nx03SyntheticProcessInspection {
 [DllImport("kernel32.dll",SetLastError=true)]
 private static extern SafeWaitHandle OpenProcess(uint access,bool inherit,int processId);
 [DllImport("kernel32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 private static extern bool GetProcessTimes(SafeWaitHandle process,
   out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 private static extern bool QueryFullProcessImageNameW(SafeWaitHandle process,uint flags,
   StringBuilder image,ref uint size);
 [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 private static extern bool GetTokenInformation(IntPtr token,int info,IntPtr buffer,
    int length,out int returned);
 [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 [DllImport("kernel32.dll")] [return:MarshalAs(UnmanagedType.Bool)]
 private static extern bool CloseHandle(IntPtr handle);
 public sealed class Info {
   public int? CallerIntegrityRid;
   public bool? CallerElevated;
   public string CallerTokenError;
   public bool IdentityAvailable;
   public long CreationFiletime;
   public string NativeImagePath;
   public string IdentityError;
   public string DuplicateHandleOpenAccess;
 }
 public static Info Observe(int pid) {
   Info x=new Info{IdentityAvailable=false,NativeImagePath="",
     IdentityError="",DuplicateHandleOpenAccess="UNKNOWN",CallerTokenError=""};
   IntPtr tok=IntPtr.Zero;
   try{
     if(!OpenProcessToken(GetCurrentProcess(),8u,out tok)){
       x.CallerTokenError="TOKEN_OPEN_"+Marshal.GetLastWin32Error();
     }else{
       IntPtr buffer=Marshal.AllocHGlobal(1024);
       try{
         int returned=0;
         if(GetTokenInformation(tok,25,buffer,1024,out returned)){
           IntPtr sid=Marshal.ReadIntPtr(buffer);
           if(sid!=IntPtr.Zero){
             int count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
             if(count>0)x.CallerIntegrityRid=Marshal.ReadInt32(
               GetSidSubAuthority(sid,(uint)(count-1)));
           }
         }
         if(GetTokenInformation(tok,20,buffer,4,out returned)){
           x.CallerElevated=Marshal.ReadInt32(buffer)!=0;
         }
         if(!x.CallerIntegrityRid.HasValue||!x.CallerElevated.HasValue)
           x.CallerTokenError="TOKEN_INTEGRITY_OR_ELEVATION_UNAVAILABLE";
       }finally{Marshal.FreeHGlobal(buffer);}
     }
   }catch(Exception e){x.CallerTokenError="TOKEN_PROVIDER_"+e.GetType().Name;}
   finally{if(tok!=IntPtr.Zero)CloseHandle(tok);}
   using(var query=OpenProcess(0x1000u,false,pid)){
     if(query.IsInvalid){
       x.IdentityError="QUERY_OPEN_ERROR_"+Marshal.GetLastWin32Error();
       return x;
     }
     long c,e,k,u;
     if(!GetProcessTimes(query,out c,out e,out k,out u)){
       x.IdentityError="QUERY_FILETIME_ERROR_"+Marshal.GetLastWin32Error();
       return x;
     }
     StringBuilder image=new StringBuilder(32768);
     uint length=(uint)image.Capacity;
     if(!QueryFullProcessImageNameW(query,0,image,ref length)){
       x.IdentityError="QUERY_IMAGE_ERROR_"+Marshal.GetLastWin32Error();
       return x;
     }
     x.CreationFiletime=c;x.NativeImagePath=image.ToString();
     x.IdentityAvailable=true;
   }
   // Opening for PROCESS_DUP_HANDLE itself is a read-only rights probe.
   // Do NOT call DuplicateHandle, install Broker or retain any handle.
   using(var dup=OpenProcess(0x0040u,false,pid)){
     if(!dup.IsInvalid)x.DuplicateHandleOpenAccess="ALLOW";
     else{
       int error=Marshal.GetLastWin32Error();
       x.DuplicateHandleOpenAccess=error==5 ? "DENIED" : "UNKNOWN_WIN32_"+error;
     }
   }
   return x;
 }
}
'@
if(-not ('Nx03SyntheticProcessInspection' -as [type])){
 Add-Type -TypeDefinition $code -ErrorAction Stop
}
$result=[Nx03SyntheticProcessInspection]::Observe($TargetPid)
$nativeImageMatch=$result.IdentityAvailable -and
  [string]::Equals($result.NativeImagePath,$expectedImage,
    [StringComparison]::OrdinalIgnoreCase)
$timeMatches=($ExpectedCreationFiletime -match '^[1-9][0-9]{9,19}$') -and
  ([string]$result.CreationFiletime -ceq $ExpectedCreationFiletime)
[ordered]@{
 kind='source_only_synthetic_win32_pid_dup_access_probe_v1'
 inspectedFixturePid=$TargetPid
 processCreationFiletime=$(if($result.IdentityAvailable){[string]$result.CreationFiletime}else{$null})
 nativeImagePath=$(if($result.IdentityAvailable){$result.NativeImagePath}else{$null})
 nativeIdentityEvidenceAvailable=[bool]$result.IdentityAvailable
 nativeIdentityError=$result.IdentityError
 actualProcessImagePathMatched=[bool]$nativeImageMatch
 expectedCreationFiletimeMatched=[bool]$timeMatches
 processDupHandleOpenAccess=$result.DuplicateHandleOpenAccess
 inspectingCallerToken=[ordered]@{
  integrityRid=$result.CallerIntegrityRid
  elevated=$result.CallerElevated
  evidenceError=$result.CallerTokenError
  tokenIsIndependentOfInstalledBroker=$true
 }
 actualKernelHandleWasDuplicated=$false
 installedBrokerProcessAttested=$false
 separateLowPrivilegeCallerBoundaryVerified=$false
 protectedJobHandleInheritanceAndDaclVerified=$false
 effectiveBrokerHighTokenVerified=$false
 signedBrokerReleaseManifestVerified=$false
 productionReady=$false
 elevatedDispatchEnabled=$false
} | ConvertTo-Json -Compress -Depth 6
