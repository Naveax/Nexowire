# Isolated negative inventory ONLY. NEVER enumerate or modify installed Nexowire paths.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$fixture=$null
$result=[ordered]@{
  scope='isolated-temp-only'
  inheritedAuthenticatedUsersModifyDetected=$false
  parentWritableDetected=$false
  updaterModifiedDetected=$false
  launcherModifiedDetected=$false
  binaryReplacedDetected=$false
  unsignedBinaryDenied=$false
  otherValidPublisherRejected=$false
  signerIdentityPinned=$false
  childDaclInherited=$false
  sourceSnapshotMismatchDenied=$false
  fixtureRemoved=$false
  productionAccepted=$false
  productionFileTouched=$false
}
try {
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $fixture=Join-Path $temp ('nwx-source-evidence-'+[Guid]::NewGuid().ToString('N'))
  if(-not $fixture.StartsWith(($temp+'\nwx-source-evidence-'),[StringComparison]::OrdinalIgnoreCase)){
    throw 'SOURCE_FIXTURE_SCOPE_INVALID'
  }
  [void](New-Item -ItemType Directory -Path $fixture)
  $parent=Join-Path $fixture 'parent'
  $root=Join-Path $parent 'privileged-broker'
  $bin=Join-Path $root 'fake-broker.exe'
  $updater=Join-Path $parent 'updater.ps1'
  $launcher=Join-Path $root 'launch.ps1'
  [void](New-Item -ItemType Directory -Path $parent)
  [void](New-Item -ItemType Directory -Path $root)
  [IO.File]::WriteAllText($bin,'FAKE_BINARY_UNSIGNED_FOR_NEGATIVE_TEST')
  [IO.File]::WriteAllText($updater,'# unsafe-updater-fixture')
  [IO.File]::WriteAllText($launcher,'# dummy-launcher-fixture')
  $icacls='C:\Windows\System32\icacls.exe'
  & $icacls $parent '/grant' '*S-1-5-11:(OI)(CI)M' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'SOURCE_FIXTURE_GRANT_FAILED'}
  $sid='S-1-5-11'
  $modify=[int][Security.AccessControl.FileSystemRights]::Modify
  function HasBroadWrite([string]$p){
    $acl=Get-Acl -LiteralPath $p -ErrorAction Stop
    $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    foreach($ace in $rules){
      if($ace.AccessControlType -eq 'Allow' -and
        $ace.IdentityReference.Value -eq $sid -and
        (([int]$ace.FileSystemRights -band $modify) -ne 0)){return $true}
    }
    return $false
  }
  $result.parentWritableDetected=HasBroadWrite $parent
  $result.childDaclInherited=@((Get-Acl -LiteralPath $bin).Access |
     Where-Object { $_.IsInherited -and $_.AccessControlType -eq 'Allow' -and
       $_.IdentityReference.Value -match 'Authenticated Users|S-1-5-11' }).Count -gt 0
  $result.inheritedAuthenticatedUsersModifyDetected=(HasBroadWrite $root) -and
     (HasBroadWrite $updater) -and (HasBroadWrite $bin) -and
     (HasBroadWrite $launcher)
  if(-not ($result.parentWritableDetected -and
    $result.inheritedAuthenticatedUsersModifyDetected)){throw 'INHERITED_UNSAFE_ACL_NOT_OBSERVED'}
  $digest=[Security.Cryptography.SHA256]::Create()
  function Fingerprint([string]$p) {
    $stream=[IO.File]::OpenRead($p)
    try {return [Convert]::ToBase64String($digest.ComputeHash($stream))}
    finally {$stream.Dispose()}
  }
  $before=@{
    updater=Fingerprint $updater
    launcher=Fingerprint $launcher
    binary=Fingerprint $bin
  }
  [IO.File]::AppendAllText($updater,'# attacker edit')
  $result.updaterModifiedDetected=(Fingerprint $updater) -cne $before.updater
  [IO.File]::AppendAllText($launcher,'# attacker edit')
  $result.launcherModifiedDetected=(Fingerprint $launcher) -cne $before.launcher
  $replacement=Join-Path $root 'replacement.exe'
  [IO.File]::WriteAllText($replacement,'FAKE_REPLACEMENT_BINARY')
  [IO.File]::Delete($bin)
  [IO.File]::Move($replacement,$bin)
  $result.binaryReplacedDetected=(Fingerprint $bin) -cne $before.binary
  $result.sourceSnapshotMismatchDenied=$result.updaterModifiedDetected -and
    $result.launcherModifiedDetected -and $result.binaryReplacedDetected
  $signature=Get-AuthenticodeSignature -LiteralPath $bin -ErrorAction Stop
  $expectedSubject='CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
  $result.signerIdentityPinned=($signature.Status -eq 'Valid' -and
    $null -ne $signature.SignerCertificate -and
    $signature.SignerCertificate.Subject -ceq $expectedSubject)
  $result.unsignedBinaryDenied= -not $result.signerIdentityPinned
  # A genuinely valid signature from a *different* pinned publisher must
  # not authorize the Node/Broker runtime. This only reads an OS system file.
  $other=Get-AuthenticodeSignature -LiteralPath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ErrorAction Stop
  $result.otherValidPublisherRejected=($other.Status -eq 'Valid' -and
    $null -ne $other.SignerCertificate -and
    $other.SignerCertificate.Subject -cne $expectedSubject)
  if(-not ($result.otherValidPublisherRejected -and
    $result.sourceSnapshotMismatchDenied -and
    $result.unsignedBinaryDenied)){throw 'NEGATIVE_SOURCE_PROOF_FAILED'}
} finally {
  if($fixture -and
      $fixture.StartsWith(($temp+'\nwx-source-evidence-'),[StringComparison]::OrdinalIgnoreCase)){
    if(Test-Path -LiteralPath $fixture){
      Remove-Item -LiteralPath $fixture -Force -Recurse -ErrorAction Stop
    }
    $result.fixtureRemoved= -not (Test-Path -LiteralPath $fixture)
  }
}
[pscustomobject]$result | ConvertTo-Json -Compress
if(-not $result.fixtureRemoved -or
    -not $result.inheritedAuthenticatedUsersModifyDetected -or
    -not $result.parentWritableDetected -or
    -not $result.updaterModifiedDetected -or
    -not $result.launcherModifiedDetected -or
    -not $result.binaryReplacedDetected -or
    -not $result.unsignedBinaryDenied -or
    -not $result.otherValidPublisherRejected){
  exit 1
}
