#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only Windows ACL audit for an elevated Nexowire runtime code path.
.DESCRIPTION
  By default, audits the entrypoint-to-runtime-root chain. -FullTree also
  inventories all children under RuntimeRoot and its parent directories up to
  the volume root, without following reparse points. It does NOT prove imported
  dependencies outside that tree are safe. No DACL/task/process mutations.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Entrypoint,
  [switch]$FullTree,
  [ValidateRange(2,20000)][int]$MaxObjects=10000,
  [ValidateRange(1,200)][int]$MaxReportedFindings=80
)
$ErrorActionPreference='Stop'
# Caller-provided PSModulePath may point at executable untrusted modules.
# Resolve inbox Windows cmdlets only from the pinned Windows system module root.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
# PowerShell 7 has its own inbox Security module. Importing WindowsPowerShell
# 5.1's copy through implicit remoting can fail due command shadowing.
# Always pin the native inbox manifest for the selected PowerShell engine.
$securityManifest=if($PSVersionTable.PSEdition -eq 'Core'){
 Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
}else{
 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
}
if(-not [IO.Path]::IsPathRooted($securityManifest) -or
   -not (Test-Path -LiteralPath $securityManifest -PathType Leaf)){
 throw 'P0_TRUSTED_SECURITY_MODULE_MISSING'
}
Import-Module -Name $securityManifest -ErrorAction Stop
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1' -ErrorAction Stop
$rootFull=[System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$entryFull=[System.IO.Path]::GetFullPath($Entrypoint)
if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot) -or
    -not [System.IO.Path]::IsPathRooted($Entrypoint) -or
    $rootFull.Length -lt 4 -or
    -not $entryFull.StartsWith($rootFull+'\',[System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'INVALID_RUNTIME_SCOPE: Entrypoint must be beneath a non-volume-root absolute RuntimeRoot.'
}
if (-not (Test-Path -LiteralPath $rootFull -PathType Container) -or
    -not (Test-Path -LiteralPath $entryFull -PathType Leaf)) {
  throw 'MISSING_RUNTIME_ENTRY_OR_ROOT'
}
$trusted=@{
  'S-1-5-18'=$true                 # LocalSystem
  'S-1-5-32-544'=$true             # Administrators
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true # TrustedInstaller
}
$rights=[System.Security.AccessControl.FileSystemRights]
$writeMask=([int]$rights::WriteData -bor
            [int]$rights::AppendData -bor
            [int]$rights::WriteAttributes -bor
            [int]$rights::WriteExtendedAttributes -bor
            [int]$rights::Delete -bor
            [int]$rights::DeleteSubdirectoriesAndFiles -bor
            [int]$rights::ChangePermissions -bor
            [int]$rights::TakeOwnership)
$visited=New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$problems=New-Object System.Collections.ArrayList
$totalFindings=0
$components=0
$treeComponents=0
$parentComponents=0
function Add-Finding([string]$Component,[string]$Reason,[string]$PrincipalClass) {
  $script:totalFindings++
  if ($script:problems.Count -lt $MaxReportedFindings) {
    [void]$script:problems.Add([ordered]@{
      component=$Component;reason=$Reason;principalClass=$PrincipalClass
    })
  }
}
function Inspect-Path([string]$Path,[string]$Label,[string]$Category) {
  if (-not $script:visited.Add($Path)) {
    # Previously audited ancestors still need their children traversed during
    # FullTree enumeration. Do not count the ACL twice, but never prune the
    # directory solely because its own ACL was already checked.
    $known=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return (($known.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)
  }
  if ($script:components -ge $MaxObjects) {throw 'MAX_OBJECTS_EXCEEDED: ACL inventory did not complete'}
  $script:components++
  if ($Category -eq 'tree') {$script:treeComponents++}
  if ($Category -eq 'parent') {$script:parentComponents++}
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  if (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Add-Finding $Label 'REPARSE_POINT' $null
  }
  $ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if (-not $trusted.ContainsKey($ownerSid)) {
    Add-Finding $Label 'UNTRUSTED_OWNER' 'Other'
  }
  $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
  foreach($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {continue}
    if ((([int]$rule.FileSystemRights -band $writeMask) -eq 0)) {continue}
    $sid=$rule.IdentityReference.Value
    if ($trusted.ContainsKey($sid)) {continue}
    $classification=switch($sid) {
      'S-1-5-11' {'Authenticated Users';break}
      'S-1-5-32-545' {'Users';break}
      'S-1-1-0' {'Everyone';break}
      'S-1-5-4' {'Interactive';break}
      default {'Other'}
    }
    Add-Finding $Label 'UNTRUSTED_WRITE_GRANT' $classification
  }
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)
}
function Relative-Path([string]$Path) {
  if($Path -ieq $rootFull) {return '.'}
  return $Path.Substring($rootFull.Length).TrimStart('\')
}
# Exact entrypoint and all ancestor components up to the declared package root.
$current=$entryFull
while ($true) {
  [void](Inspect-Path $current (Relative-Path $current) 'entry')
  if ($current -ieq $rootFull) {break}
  $parent=[System.IO.Path]::GetDirectoryName($current)
  if (-not $parent -or $parent.Length -ge $current.Length) {throw 'UNEXPECTED_RUNTIME_ANCESTRY'}
  $current=$parent
}
if ($FullTree) {
  $rootItem=Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'REPARSE_RUNTIME_ROOT: Cannot fully enumerate a linked root.'
  }
  # Enumerate every file/directory under the declared root without descending
  # into junctions/symlinks (their presence is itself a blocking finding).
  $pending=New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($rootFull)
  while ($pending.Count -gt 0) {
    $dir=$pending.Pop()
    $children=@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)
    foreach($child in $children) {
      $allowed=Inspect-Path $child.FullName (Relative-Path $child.FullName) 'tree'
      if ($child.PSIsContainer -and $allowed) {$pending.Push($child.FullName)}
    }
  }
  # Also check replacement/rename capabilities of directories outside the
  # package root, up to the volume root. Redact their actual filesystem names.
  $ancestor=[System.IO.Path]::GetDirectoryName($rootFull)
  $outerDepth=0
  while($ancestor) {
    $outerDepth++
    [void](Inspect-Path $ancestor ('@parent/'+$outerDepth) 'parent')
    $up=[System.IO.Path]::GetDirectoryName($ancestor.TrimEnd('\'))
    if (-not $up -or $up -ieq $ancestor) {break}
    if ($outerDepth -ge 128) {throw 'UNBOUNDED_ROOT_PARENTS'}
    $ancestor=$up
  }
}
[pscustomobject]@{
  schemaVersion=2
  mode='READ_ONLY'
  scope=if($FullTree){'ROOT_TREE_AND_PARENTS'}else{'ENTRYPOINT_CHAIN'}
  componentsAudited=$components
  runtimeTreeComponentsAudited=$treeComponents
  outerParentComponentsAudited=$parentComponents
  issues=@($problems.ToArray())
  totalFindings=$totalFindings
  omittedFindings=($totalFindings-$problems.Count)
  riskyCodePath=($totalFindings -gt 0)
  packageTreeAudited=[bool]$FullTree
  dependenciesRecursivelyAudited=$false
  ownerApprovedElevatedExecution=$false
  productionFilesChanged=$false
} | ConvertTo-Json -Depth 6 -Compress
