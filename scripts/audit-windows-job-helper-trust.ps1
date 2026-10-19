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
$hash = (Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = Join-Path $helper.DirectoryName 'windows-job-owner.sha256'
$manifestDigest = if (Test-Path -LiteralPath $manifest -PathType Leaf) {
  (Get-Content -LiteralPath $manifest -Raw).Trim().ToLowerInvariant()
} else { '' }
$hashMatches = $manifestDigest -match '^[0-9a-f]{64}$' -and $hash -eq $manifestDigest
$auth = Get-AuthenticodeSignature -LiteralPath $HelperPath
$validSigner = $auth.Status -eq 'Valid' -and $null -ne $auth.SignerCertificate
$thumbprint = if ($auth.SignerCertificate) {
  $auth.SignerCertificate.Thumbprint.ToLowerInvariant()
} else { '' }
$acl = Get-Acl -LiteralPath $HelperPath
$parentAcl = Get-Acl -LiteralPath $parent.FullName
# Deny broad low-trust groups WRITE_DAC/WRITE_OWNER/DELETE and data writes.
# These SIDs are stable across localized Windows installations.
$untrustedSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')
$unsafe=@()
foreach($entry in $acl.Access) {
  if ($entry.AccessControlType -ne 'Allow') { continue }
  $identity=try { $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { $entry.IdentityReference.Value }
  $bits=[int64]$entry.FileSystemRights
  $writeMask=0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
  if ($identity -in $untrustedSids -and (($bits -band $writeMask) -ne 0)) {
    $unsafe+= $identity
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
  authenticodeStatus=[string]$auth.Status
  publisherValid=[bool]$validSigner
  externallyPinnedPublisherMatches=[bool]$expectedPublisherOK
  externallyPinnedReleaseSha256Matches=[bool]$expectedShaOK
  fileAclProtected=[bool]$acl.AreAccessRulesProtected
  parentAclProtected=[bool]$parentAcl.AreAccessRulesProtected
  broadWriteGrantFound=($unsafe.Count -gt 0)
  productionReady=$false
}
$ready= $hashMatches -and (-not $linked) -and $validSigner -and
  $expectedPublisherOK -and $expectedShaOK -and
  $acl.AreAccessRulesProtected -and $parentAcl.AreAccessRulesProtected -and
  ($unsafe.Count -eq 0)
# Deliberately do NOT declare productionReady based solely on file-level
# evidence: the caller's signer trust anchor, installation identity, rollback
# proof, runtime image race and PROCESS_DUP_HANDLE boundary must still be reviewed.
$evidence.provisionalFileTrustChecksPassed=[bool]$ready
$evidence | ConvertTo-Json -Compress
if ($Production) {
  if (-not $ready) { throw 'WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED' }
  throw 'WINDOWS_JOB_PRODUCTION_ACCEPTANCE_REQUIRES_EXTERNAL_ATTESTATION'
}
