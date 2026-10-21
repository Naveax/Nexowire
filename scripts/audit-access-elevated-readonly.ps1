# Preparation for an independently authorized ELEVATED READ-ONLY source audit.
# This command does NOT request elevation, change rights, run a service, or attest
# true token effective access (native AuthzAccessCheck remains a separate gate).
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'ACCESS_READONLY_WINDOWS_ONLY'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'ACCESS_READONLY_ELEVATED_OBSERVER_REQUIRED'
}
# A medium-integrity or split-token admin is not a sufficient observer.
$whoami=& 'C:\Windows\System32\whoami.exe' /groups /fo csv
if($LASTEXITCODE -ne 0 -or
  [string]::Join([Environment]::NewLine,$whoami) -notmatch 'S-1-16-(12288|16384)'){
  throw 'ACCESS_READONLY_HIGH_INTEGRITY_REQUIRED'
}
# Targets are fixed; no caller-supplied executable path or optional rewrite.
$targets=@(
  @{role='legacy-parent';path='C:\ProgramData\NexowireStack'},
  @{role='legacy-cli';path='C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js'},
  @{role='broker-parent';path='C:\ProgramData\Nexowire'},
  @{role='broker-root';path='C:\ProgramData\Nexowire\privileged-broker'},
  @{role='broker-launcher';path='C:\ProgramData\Nexowire\privileged-broker\launch.ps1'}
)
$allowed=@{'S-1-5-18'=$true;'S-1-5-32-544'=$true}
$mask=[uint64](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor
  0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
$nodes=@()
foreach($target in $targets){
  $result=[ordered]@{
    role=$target.role
    path=$target.path
    acl='UNKNOWN'
    sourceOwnerTrusted=$false
    inheritedOrExplicitUntrustedWrite=$null
    readOnlyObservation=$true
  }
  try {
    $item=Get-Item -LiteralPath $target.path -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'SOURCE_REPARSE_UNTRUSTED'
    }
    $acl=Get-Acl -LiteralPath $target.path -ErrorAction Stop
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $result.sourceOwnerTrusted=[bool]$allowed.ContainsKey($owner)
    $unsafe=$false
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($ace.AccessControlType -eq 'Allow' -and
        -not $allowed.ContainsKey($ace.IdentityReference.Value) -and
        (([uint64]([int64]$ace.FileSystemRights) -band $mask) -ne 0)){
        $unsafe=$true
      }
    }
    $result.inheritedOrExplicitUntrustedWrite=$unsafe
    $result.acl=if($unsafe -or -not $result.sourceOwnerTrusted){'UNSAFE'}else{'CANDIDATE_ONLY'}
  } catch {
    # An ACL access denial is unknown, NEVER "secure".
    $result.acl='UNKNOWN'
  }
  $nodes += [pscustomobject]$result
}
[pscustomobject]@{
  status='P0_PHYSICAL_READONLY_SOURCE_SNAPSHOT'
  elevatedReadOnlyObserver=$true
  sourceNodes=$nodes
  sourceCoverageComplete=$false # updater, dependency graph, exact executable image not attested
  nativeAccessCheckPerformed=$false
  independentGuardianAttested=$false
  productionApproved=$false
  physicalNoGo=$true
  aclOrUacOrServiceMutated=$false
} | ConvertTo-Json -Depth 5 -Compress
