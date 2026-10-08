#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only Windows ACL audit for an elevated Nexowire runtime code path.
.DESCRIPTION
  Audits effective owner and allow-write grants along the entrypoint-to-root
  chain. Does not modify DACLs, read secrets or authorize privileged execution.
  This is a prerequisite diagnostic, NOT a complete recursive dependency audit.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Entrypoint
)
$ErrorActionPreference='Stop'
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
# Rights to mutate executable code, remove/rewrite it or change its ACL.
$rights=[System.Security.AccessControl.FileSystemRights]
$writeMask=([int]$rights::WriteData -bor
            [int]$rights::AppendData -bor
            [int]$rights::WriteAttributes -bor
            [int]$rights::WriteExtendedAttributes -bor
            [int]$rights::Delete -bor
            [int]$rights::DeleteSubdirectoriesAndFiles -bor
            [int]$rights::ChangePermissions -bor
            [int]$rights::TakeOwnership)
$problems=New-Object System.Collections.ArrayList
$current=$entryFull
$components=0
while ($true) {
  $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
  $acl=Get-Acl -LiteralPath $current -ErrorAction Stop
  $relative=if($current -ieq $rootFull){'.'}else{$current.Substring($rootFull.Length).TrimStart('\')}
  $components++
  if (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    [void]$problems.Add([ordered]@{component=$relative;reason='REPARSE_POINT';principalClass=$null})
  }
  $ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if (-not $trusted.ContainsKey($ownerSid)) {
    [void]$problems.Add([ordered]@{component=$relative;reason='UNTRUSTED_OWNER';principalClass='Other'})
  }
  $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
  foreach($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if ((([int]$rule.FileSystemRights -band $writeMask) -eq 0)) { continue }
    $sid=$rule.IdentityReference.Value
    if ($trusted.ContainsKey($sid)) { continue }
    $classification=switch($sid) {
      'S-1-5-11' {'Authenticated Users';break}
      'S-1-5-32-545' {'Users';break}
      'S-1-1-0' {'Everyone';break}
      'S-1-5-4' {'Interactive';break}
      default {'Other'}
    }
    [void]$problems.Add([ordered]@{component=$relative;reason='UNTRUSTED_WRITE_GRANT';principalClass=$classification})
  }
  if ($current -ieq $rootFull) {break}
  $parent=[System.IO.Path]::GetDirectoryName($current)
  if (-not $parent -or $parent.Length -ge $current.Length) {throw 'UNEXPECTED_RUNTIME_ANCESTRY'}
  $current=$parent
  if ($components -gt 256) {throw 'UNBOUNDED_RUNTIME_ANCESTRY'}
}
[pscustomobject]@{
  schemaVersion=1
  mode='READ_ONLY'
  componentsAudited=$components
  issues=@($problems.ToArray())
  riskyCodePath=($problems.Count -gt 0)
  dependenciesRecursivelyAudited=$false
  ownerApprovedElevatedExecution=$false
  productionFilesChanged=$false
} | ConvertTo-Json -Depth 6 -Compress
