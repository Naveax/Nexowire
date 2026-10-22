# Source-only read-only **actual Windows kernel access check** fixture.
# CreateFile(OPEN_EXISTING) requests access but does NOT perform writes.
# Never called on installed Nexowire/ProgramData; temp synthetic owned only.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$FixtureRoot,
 [Parameter(Mandatory=$true)][string]$TargetsBase64
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_ONLY'}
$root=[IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $root.StartsWith($temp+'\', [StringComparison]::OrdinalIgnoreCase)){
 throw 'ONLY_TEST_OWNED_TEMP_FIXTURE_ALLOWED'
}
$marker=Join-Path $root '.nx03-synthetic-acl-fixture'
if(-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker).Trim() -ne 'NX03_SOURCE_ONLY'){
 throw 'TEST_OWNERSHIP_MARKER_MISSING'
}
try{
 $inputJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetsBase64))
 $targets=ConvertFrom-Json -InputObject $inputJson -AsHashtable -ErrorAction Stop
}catch{throw 'INVALID_SYNTHETIC_TARGET_ENVELOPE'}
if($targets -isnot [array] -or $targets.Count -lt 1 -or $targets.Count -gt 24){
 throw 'INVALID_SYNTHETIC_TARGET_COUNT'
}
$src=@'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class Nx03TestAccessProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern SafeFileHandle CreateFileW(string path,uint access,uint share,
   IntPtr security,uint disposition,uint flags,IntPtr template);
 public static string CanOpen(string path,bool isDirectory,uint desired) {
   using(SafeFileHandle handle=CreateFileW(path,desired,7,IntPtr.Zero,3,
     isDirectory ? 0x02000000u : 0u,IntPtr.Zero)) {
     if(!handle.IsInvalid)return "ALLOW";
     int error=Marshal.GetLastWin32Error();
     if(error==5)return "DENIED";
     return "UNKNOWN_WIN32_"+error;
   }
 }
}
'@
if(-not ('Nx03TestAccessProbe' -as [type])){
 Add-Type -TypeDefinition $src -ErrorAction Stop
}
$results=@()
foreach($target in $targets){
 if($target -isnot [System.Collections.IDictionary] -or $target.Count -ne 2 -or
    -not $target.ContainsKey('path') -or -not $target.ContainsKey('isDirectory') -or
    $target.path -isnot [string] -or $target.isDirectory -isnot [bool] -or
    -not [IO.Path]::IsPathFullyQualified($target.path)){
   throw 'INVALID_SYNTHETIC_TARGET_SCHEMA'
 }
 $path=[IO.Path]::GetFullPath([string]$target.path)
 if(-not ($path.StartsWith($root+'\', [StringComparison]::OrdinalIgnoreCase) -or
           [string]::Equals($path,$root,[StringComparison]::OrdinalIgnoreCase))){
   throw 'SYNTHETIC_TARGET_OUT_OF_ROOT'
 }
 $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 if([bool]$item.PSIsContainer -ne [bool]$target.isDirectory){throw 'SYNTHETIC_TARGET_TYPE_MISMATCH'}
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'REPARSE_POINT_NOT_A_SAFE_SYNTHETIC_FIXTURE'
 }
 $directory=[bool]$item.PSIsContainer
 $desired=if($directory){[ordered]@{
   addFile=[uint32]0x0002;deleteChild=[uint32]0x0040;
   delete=[uint32]0x00010000;writeDac=[uint32]0x00040000
 }}else{[ordered]@{
   writeData=[uint32]0x0002;appendData=[uint32]0x0004;
   delete=[uint32]0x00010000;writeDac=[uint32]0x00040000
 }}
 $out=[ordered]@{}
 foreach($key in $desired.Keys){
  $out[$key]=[Nx03TestAccessProbe]::CanOpen($path,$directory,$desired[$key])
 }
 $acl=if($directory){
   [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]$item)
 }else{
   [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]$item)
 }
 $results+=,[ordered]@{
   path=$path
   actualCurrentTokenAccess=$out
   listedAclAvailable=($null -ne $acl)
   inheritedAndExplicitAceCount=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count
 }
}
[ordered]@{
 kind='source_only_windows_current_token_access_probe_v1'
 provider='CreateFileW(OPEN_EXISTING,SHARE_ALL): read-only access requests'
 tokenScope='actual-calling-test-process-only'
 fixtureOnly=$true
 paths=$results
 fullTransitiveImportInventoryVerified=$false
 highIntegrityInstalledBrokerPidVerified=$false
 ownerEpochExternallySigned=$false
 separateLowPrivilegeTokenBoundaryVerified=$false
 signedReleaseAndRollbackManifestVerified=$false
 productionReady=$false
 elevatedDispatchEnabled=$false
} | ConvertTo-Json -Compress -Depth 8
