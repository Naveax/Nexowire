#Requires -Version 5.1
<#
.SYNOPSIS
  Non-mutating Windows access-token probe for elevated-runtime file paths.
.DESCRIPTION
  Run under the ACTUAL ordinary interactive/non-elevated user token.
  Request individual write/delete/DACL rights with CreateFileW OPEN_EXISTING.
  No bytes are written, directories created, DACLs changed or tasks touched.
  The result is a snapshot and never authorizes a privileged cutover.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$RuntimeRoot,
 [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Entrypoint,
 [switch]$FullTree,
 [ValidateRange(2,20000)][int]$MaxObjects=4096,
 [ValidateRange(1,200)][int]$MaxReportedFindings=40
)
$ErrorActionPreference='Stop'
# Avoid loading caller-selected modules while probing protected code paths.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1' -ErrorAction Stop
if(-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6){
 throw 'ACCESS_PROBE_WINDOWS_REQUIRED'
}
function Assert-LocalPath([string]$value){
 if(-not [IO.Path]::IsPathRooted($value) -or
    $value.StartsWith('\\') -or
    $value -match '^[a-zA-Z]:[^\\]' -or
    $value.Contains('..') -or
    $value.Contains('/') ){
   throw 'ACCESS_PROBE_INVALID_LOCAL_ABSOLUTE_PATH'
 }
 return [IO.Path]::GetFullPath($value).TrimEnd('\')
}
$root=Assert-LocalPath $RuntimeRoot
$entry=Assert-LocalPath $Entrypoint
if($root.Length -lt 4 -or
   -not $entry.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){
 throw 'ACCESS_PROBE_ENTRY_OUTSIDE_ROOT'
}
if(-not (Test-Path -LiteralPath $root -PathType Container) -or
   -not (Test-Path -LiteralPath $entry -PathType Leaf)){
 throw 'ACCESS_PROBE_PATH_MISSING'
}
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$identity=$principal.Identity
if($identity.User.Value -eq 'S-1-5-18' -or
   $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'ACCESS_PROBE_REQUIRES_UNELEVATED_USER'
}

# OS-owned kernel32 is resolved by Windows, not by caller PATH.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NexowireP0CreateFileProbe {
 [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern SafeFileHandle Open(
  string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
  uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
'@ -ErrorAction Stop
# Individual requests are critical: asking for all rights at once can be denied
# even when a dangerous subset is granted.
$fileRights=[ordered]@{
 WRITE_DATA=0x00000002; APPEND_DATA=0x00000004
 WRITE_EA=0x00000010; WRITE_ATTRIBUTES=0x00000100
 DELETE=0x00010000; WRITE_DAC=0x00040000; WRITE_OWNER=0x00080000
}
$dirRights=[ordered]@{
 ADD_FILE=0x00000002; ADD_SUBDIRECTORY=0x00000004
 DELETE_CHILD=0x00000040; WRITE_ATTRIBUTES=0x00000100
 DELETE=0x00010000; WRITE_DAC=0x00040000; WRITE_OWNER=0x00080000
}
$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$total=0;$treeCount=0;$parentCount=0
$grantedCount=0;$inconclusiveCount=0
$findings=New-Object System.Collections.ArrayList
function Emit([string]$label,[string]$right,[string]$outcome){
 if($script:findings.Count -lt $MaxReportedFindings){
  [void]$script:findings.Add([ordered]@{component=$label;right=$right;result=$outcome})
 }
}
function Inspect([string]$path,[string]$label,[string]$category){
 if(-not $script:seen.Add($path)){return $true}
 if($script:total -ge $MaxObjects){throw 'ACCESS_PROBE_MAX_OBJECTS_EXCEEDED'}
 $script:total++
 if($category -eq 'tree'){$script:treeCount++}
 if($category -eq 'parent'){$script:parentCount++}
 $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'ACCESS_PROBE_REPARSE_POINT'
 }
 $dir=[bool]$item.PSIsContainer
 $rights=if($dir){$dirRights}else{$fileRights}
 foreach($name in $rights.Keys){
  $mask=[uint32]$rights[$name]
  # SHARE_READ|SHARE_WRITE|SHARE_DELETE; OPEN_EXISTING (never CREATE/TRUNCATE).
  # FILE_FLAG_BACKUP_SEMANTICS is required to open a directory as a handle.
  $handle=[NexowireP0CreateFileProbe]::Open($path,$mask,7,[IntPtr]::Zero,
    3,[uint32]0x02000000,[IntPtr]::Zero)
  if($handle.IsInvalid){
   $errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
   $handle.Dispose()
   if($errorCode -eq 5){continue} # ACCESS_DENIED for this exact right
   $script:inconclusiveCount++
   Emit $label $name 'INCONCLUSIVE'
  }else{
   $handle.Dispose()
   $script:grantedCount++
   Emit $label $name 'GRANTED'
  }
 }
 return $true
}
# The entry, every parent under runtime root, and root itself.
$current=$entry
$depth=0
while($true){
 $label=if($depth -eq 0){'@entry'}elseif($current -ieq $root){'.'}else{'@entry-parent/'+$depth}
 [void](Inspect $current $label 'chain')
 if($current -ieq $root){break}
 $up=[IO.Path]::GetDirectoryName($current)
 if(!$up -or $up.Length -ge $current.Length -or $depth++ -ge 128){
  throw 'ACCESS_PROBE_UNEXPECTED_ANCESTRY'
 }
 $current=$up
}
if($FullTree){
 # Bounded enumeration, never follow directory links; any link fails closed.
 $pending=New-Object 'System.Collections.Generic.Stack[string]'
 $pending.Push($root)
 $ordinal=0
 while($pending.Count -gt 0){
  $dir=$pending.Pop()
  foreach($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)){
   $ordinal++
   [void](Inspect $item.FullName ('@tree/'+$ordinal) 'tree')
   if($item.PSIsContainer){$pending.Push($item.FullName)}
  }
 }
}
# Parent directory replacement rights matter even if all code files deny
# direct writes. Include ancestors up to volume root. Parent grants are
# conservative risk signals, not a complete exploitability conclusion.
$outer=[IO.Path]::GetDirectoryName($root)
$parentDepth=0
while($outer){
 $parentDepth++
 [void](Inspect $outer ('@outer-parent/'+$parentDepth) 'parent')
 $up=[IO.Path]::GetDirectoryName($outer.TrimEnd('\'))
 if(!$up -or $up -ieq $outer){break}
 if($parentDepth -ge 128){throw 'ACCESS_PROBE_PARENT_LIMIT'}
 $outer=$up
}
[pscustomobject]@{
 schemaVersion=1;mode='READ_ONLY_OPEN_EXISTING'
 tokenClass='NON_ELEVATED_USER'
 objectCount=$total;treeObjects=$treeCount;outerParentObjects=$parentCount
 fullTreeAudited=[bool]$FullTree;grantedWriteRights=$grantedCount
 inconclusiveRights=$inconclusiveCount
 findings=@($findings.ToArray())
 omittedFindings=[math]::Max(0,($grantedCount+$inconclusiveCount)-$findings.Count)
 allProbedRightsDenied=($grantedCount -eq 0 -and $inconclusiveCount -eq 0)
 effectiveAccessSnapshotOnly=$true;futureTamperImpossible=$false
 tokenDiffersFromOtherUsersUnknown=$true;restorationTested=$false
 productionBytesChanged=$false;taskOrAclChanged=$false
 authorizedToElevate=$false;safeToCutover=$false
}|ConvertTo-Json -Depth 5 -Compress
