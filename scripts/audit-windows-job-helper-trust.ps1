# Read-only inspection of a Job helper. Never installs, signs or changes ACLs.
# "Production" intentionally fails closed without externally pinned release evidence.
[CmdletBinding()]
param(
  [string]$HelperPath = '',
  [switch]$Production,
  [string]$ExpectedPublisherThumbprint = '',
  [string]$ExpectedReleaseSha256 = ''
)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_JOB_WINDOWS_ONLY' }
if (-not $HelperPath) {
  $HelperPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'native\windows-job-owner.exe'
}
$HelperPath = [IO.Path]::GetFullPath($HelperPath)
if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
  throw 'WINDOWS_JOB_HELPER_MISSING'
}
$helper = Get-Item -LiteralPath $HelperPath -Force
$parent = Get-Item -LiteralPath (Split-Path $HelperPath -Parent) -Force
$linked = (($helper.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
          (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
# Use the .NET SHA-256 primitive directly. Certain stripped Windows test
# environments do not expose the Get-FileHash PowerShell cmdlet even though
# the cryptographic provider is available. A missing cmdlet must never turn
# a fail-closed security decision into an unrelated command-not-found error.
# Keep the file open only for a bounded read and always dispose both handles.
$sha256 = [Security.Cryptography.SHA256]::Create()
$stream = $null
try {
  $stream = [IO.File]::Open(
    $HelperPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $digest = $sha256.ComputeHash($stream)
  $hash = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
  $sha256.Dispose()
}
$manifest = Join-Path $helper.DirectoryName 'windows-job-owner.sha256'
$manifestDigest = if (Test-Path -LiteralPath $manifest -PathType Leaf) {
  (Get-Content -LiteralPath $manifest -Raw).Trim().ToLowerInvariant()
} else { '' }
$hashMatches = $manifestDigest -match '^[0-9a-f]{64}$' -and $hash -eq $manifestDigest
# Explicit built-in module-qualified cmdlets: functions exported by a calling
# session must not forge Valid Authenticode or protected ACL evidence.
# Missing module/provider still yields UNAVAILABLE and production NO-GO.
# Unavailable signature or ACL providers mean missing evidence, never trust.
$auth = $null
$authError = ''
try {
  $auth = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $HelperPath -ErrorAction Stop
} catch {
  $authError = $_.Exception.GetType().Name
}
$authAvailable = $null -ne $auth
$validSigner = $authAvailable -and $auth.Status -eq 'Valid' -and $null -ne $auth.SignerCertificate
$thumbprint = if ($authAvailable -and $auth.SignerCertificate) {
  $auth.SignerCertificate.Thumbprint.ToLowerInvariant()
} else { '' }
$acl = $null
$parentAcl = $null
$aclError = ''
try {
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $HelperPath -ErrorAction Stop
  $parentAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $parent.FullName -ErrorAction Stop
} catch {
  $aclError = $_.Exception.GetType().Name
  $acl = $null
  $parentAcl = $null
}
$aclAvailable = $null -ne $acl -and $null -ne $parentAcl
# Deny broad low-trust groups WRITE_DAC/WRITE_OWNER/DELETE and data writes.
# These SIDs are stable across localized Windows installations.
$untrustedSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')
$unsafe=@()
foreach($entry in $(if ($aclAvailable) { $acl.Access } else { @() })) {
  if ($entry.AccessControlType -ne 'Allow') { continue }
  $identity=try { $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { $entry.IdentityReference.Value }
  $bits=[int64]$entry.FileSystemRights
  $writeMask=0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
  if ($identity -in $untrustedSids -and (($bits -band $writeMask) -ne 0)) {
    $unsafe+= $identity
  }
}
# Directory replacement is possible even when the EXE DACL is restricted:
# inherited/create/delete grants on the *parent* are independently dangerous.
# This is read-only detection, not Windows effective-permissions attestation.
$unsafeParent=@()
foreach($entry in $(if ($aclAvailable) { $parentAcl.Access } else { @() })) {
  if ($entry.AccessControlType -ne 'Allow') { continue }
  $identity=try { $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { $entry.IdentityReference.Value }
  $rights=[int64]$entry.FileSystemRights
  $replaceMask=0x2 -bor 0x4 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
  if ($identity -in $untrustedSids -and (($rights -band $replaceMask) -ne 0)) {
    $unsafeParent+= $identity
  }
}
$expectedShaOK = $ExpectedReleaseSha256 -match '^[0-9a-fA-F]{64}$' -and
  $hash -eq $ExpectedReleaseSha256.ToLowerInvariant()
$expectedPublisherOK = $ExpectedPublisherThumbprint -match '^[0-9a-fA-F]{40}$' -and
  $thumbprint -eq $ExpectedPublisherThumbprint.ToLowerInvariant()
$evidence=[ordered]@{
  kind='windows_job_helper_trust_audit_v1'
  helperPresent=$true
  helperSha256=$hash
  companionManifestMatches=[bool]$hashMatches
  pathReparseDetected=[bool]$linked
  authenticodeStatus=$(if ($authAvailable) { [string]$auth.Status } else { 'UNAVAILABLE' })
  authenticodeEvidenceAvailable=[bool]$authAvailable
  authenticodeEvidenceError=$authError
  publisherValid=[bool]$validSigner
  externallyPinnedPublisherMatches=[bool]$expectedPublisherOK
  externallyPinnedReleaseSha256Matches=[bool]$expectedShaOK
  aclEvidenceAvailable=[bool]$aclAvailable
  aclEvidenceError=$aclError
  fileAclProtected=[bool]($aclAvailable -and $acl.AreAccessRulesProtected)
  parentAclProtected=[bool]($aclAvailable -and $parentAcl.AreAccessRulesProtected)
  broadWriteGrantFound=$(if ($aclAvailable) { $unsafe.Count -gt 0 } else { $null })
  parentBroadWriteGrantFound=$(if ($aclAvailable) { $unsafeParent.Count -gt 0 } else { $null })
  signedReleaseManifestVerified=$false
  runningImageFileIdentityVerified=$false
  productionReady=$false
}
$ready= $hashMatches -and (-not $linked) -and $validSigner -and
  $expectedPublisherOK -and $expectedShaOK -and
  $aclAvailable -and $acl.AreAccessRulesProtected -and $parentAcl.AreAccessRulesProtected -and
  ($unsafe.Count -eq 0) -and ($unsafeParent.Count -eq 0)
# Deliberately do NOT declare productionReady based solely on file-level
# evidence: the caller's signer trust anchor, installation identity, rollback
# proof, runtime image race and PROCESS_DUP_HANDLE boundary must still be reviewed.
$evidence.provisionalFileTrustChecksPassed=[bool]$ready
$evidence | ConvertTo-Json -Compress
if ($Production) {
  if (-not $ready) { throw 'WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED' }
  throw 'WINDOWS_JOB_PRODUCTION_ACCEPTANCE_REQUIRES_EXTERNAL_ATTESTATION'
}
