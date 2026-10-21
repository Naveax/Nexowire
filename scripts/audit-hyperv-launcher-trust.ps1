# P0 #617 READ-ONLY. Source/staging inspection, NEVER privileged dispatch.
# Even when the Windows signature and file ACLs pass, this script cannot
# attest an actual running elevated Broker image, local UAC approval or a
# signed/rollback-bound Nexowire manifest. It must never enable Hyper-V.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$RuntimePath,
  [string]$ExpectedPublisherThumbprint = '',
  [string]$ExpectedLauncherSha256 = '',
  [string]$ExpectedRuntimeSha256 = ''
)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop } catch { # Fail closed in per-image evidence checks below
}
$unsafeSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')
$writeMask=0x2 -bor 0x4 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
function Inspect-Executable([string]$literalPath, [string]$digestPinned) {
  $p=[IO.Path]::GetFullPath($literalPath)
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if ($item.PSIsContainer) {throw 'HYPERV_EXPECTED_EXE_FILE'}
  $parent=Get-Item -LiteralPath $item.DirectoryName -Force -ErrorAction Stop
  $reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  $sha=[Security.Cryptography.SHA256]::Create()
  $stream=$null
  try {
    $stream=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
  } finally {if ($stream) {$stream.Dispose()};$sha.Dispose()}
  $auth=$null;$acl=$null;$parentAcl=$null
  $signatureProviderError='';$aclProviderError=''
  try {$auth=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop}
  catch {$signatureProviderError=$_.Exception.GetType().Name}
  try {
    # Use the native .NET Windows ACL API. Hosted pwsh/WindowsPowerShell
    # cmdlet availability varies; missing evidence must never be a clean ACL.
    $acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]$item)
    $parentAcl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]$parent)
  } catch {
    $aclProviderError=$_.Exception.GetType().Name
    $acl=$null;$parentAcl=$null
  }
  $badFile=@();$badParent=@()
  foreach($pair in @(@($acl,$badFile),@($parentAcl,$badParent))){
    $a=$pair[0]
    if ($null -eq $a){continue}
    foreach($entry in $a.Access){
      if ($entry.AccessControlType -ne 'Allow'){continue}
      $sid=try {$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
        catch {$entry.IdentityReference.Value}
      if ($sid -in $unsafeSids -and (([int64]$entry.FileSystemRights -band $writeMask) -ne 0)){
        if ($a -eq $acl){$badFile+= $sid}else{$badParent+= $sid}
      }
    }
  }
  return [ordered]@{
    signatureStatus=$(if($null -ne $auth){[string]$auth.Status}else{'UNAVAILABLE'})
    signerThumbprint=$(if($null -ne $auth -and $null -ne $auth.SignerCertificate){[string]$auth.SignerCertificate.Thumbprint}else{''})
    signatureProviderError=$signatureProviderError
    aclProviderError=$aclProviderError
    publisherMatches=$null -ne $auth -and $auth.Status -eq 'Valid' -and
      $null -ne $auth.SignerCertificate -and
      $ExpectedPublisherThumbprint -match '^[a-fA-F0-9]{40}$' -and
      $auth.SignerCertificate.Thumbprint -eq $ExpectedPublisherThumbprint
    sha256=$digest
    independentlyPinnedSha256Matches=$digestPinned -match '^[a-fA-F0-9]{64}$' -and
      $digest -eq $digestPinned.ToLowerInvariant()
    pathReparseDetected=[bool]$reparse
    fileAclProtected=[bool]($null -ne $acl -and $acl.AreAccessRulesProtected)
    parentAclProtected=[bool]($null -ne $parentAcl -and $parentAcl.AreAccessRulesProtected)
    fileBroadWriteGrantFound=$(if($null -ne $acl){$badFile.Count -gt 0}else{$null})
    parentBroadWriteGrantFound=$(if($null -ne $parentAcl){$badParent.Count -gt 0}else{$null})
    fileAclEvidenceAvailable=($null -ne $acl)
    parentAclEvidenceAvailable=($null -ne $parentAcl)
    installedRunningImageIdentityVerified=$false
  }
}
$launcher=Inspect-Executable $LauncherPath $ExpectedLauncherSha256
$runtime=Inspect-Executable $RuntimePath $ExpectedRuntimeSha256
[ordered]@{
  kind='hyperv_launcher_trust_readonly_v1'
  launcher=$launcher
  runtime=$runtime
  releaseManifestSignatureVerified=$false
  ownerGrantVerified=$false
  installedProcessHandleIdentityVerified=$false
  elevatedDispatchEnabled=$false
  productionApproved=$false
} | ConvertTo-Json -Compress -Depth 6
