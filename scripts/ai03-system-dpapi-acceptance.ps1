#Requires -Version 5.1
<#
.SYNOPSIS
  AI-03 read-only DPAPI equality attestation. Never installs a task or elevates.
.DESCRIPTION
  Run Source as the original interactive owner, and System ONLY inside an
  independently authorized NT AUTHORITY\SYSTEM process after the controlled
  cutover. Use the SAME fresh 256-bit challenge hex for both. Compare proofSha256.
  Proof equality is NOT reboot, Broker-effect or CORE-revocation acceptance.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Source','System')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$Nonce,
  [string]$SourceFile
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$trustedFile='C:\ProgramData\Nexowire\hub-boot\control-plane-service-token.machine.dpapi.json'
$allowed=@{
  'S-1-5-18'=$true
  'S-1-5-32-544'=$true
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true
}
function Fail([string]$Code) { throw $Code }
function Get-TrustedItem([string]$Path,[bool]$Directory) {
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if(([bool]$item.PSIsContainer) -ne $Directory) { Fail 'AI03_PATH_TYPE_INVALID' }
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail 'AI03_REPARSE_POINT_DENIED'
  }
  return $item
}
function Assert-TrustedOwner($Acl) {
  $sid=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if(-not $allowed.ContainsKey($sid)) { Fail 'AI03_PROTECTED_OWNER_INVALID' }
}
function Assert-OuterAncestor([string]$Path) {
  $null=Get-TrustedItem $Path $true
  $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  Assert-TrustedOwner $acl
  $rights=[Security.AccessControl.FileSystemRights]
  $mask=([int64]$rights::Delete -bor [int64]$rights::DeleteSubdirectoriesAndFiles -bor
    [int64]$rights::ChangePermissions -bor [int64]$rights::TakeOwnership -bor
    [int64]0x10000000)
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if(([int]$ace.PropagationFlags -band
       [int][Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
       ([int64]$ace.FileSystemRights -band $mask) -ne 0 -and
       -not $allowed.ContainsKey($ace.IdentityReference.Value)) {
      Fail 'AI03_PROTECTED_ANCESTOR_REPLACEABLE'
    }
  }
}
function Assert-PrivateConfidentialAcl([string]$Path,[bool]$Directory) {
  $null=Get-TrustedItem $Path $Directory
  $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  Assert-TrustedOwner $acl
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if(($ace.PropagationFlags -band
       [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    # LocalMachine DPAPI can be unsealed by other local identities if ciphertext
    # is readable. Unlike a write-only trust check, reject untrusted READ grants.
    if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
       -not $allowed.ContainsKey($ace.IdentityReference.Value)) {
      Fail 'AI03_MACHINE_SECRET_READ_ACL_UNTRUSTED'
    }
  }
}
try {
  Add-Type -AssemblyName System.Security
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if($Mode -eq 'System') {
    if($sid -cne 'S-1-5-18') { Fail 'AI03_SYSTEM_IDENTITY_REQUIRED' }
    if(-not [string]::IsNullOrWhiteSpace($SourceFile)) {
      Fail 'AI03_SYSTEM_SOURCE_OVERRIDE_DENIED'
    }
    Assert-OuterAncestor 'C:\'
    Assert-OuterAncestor 'C:\ProgramData'
    Assert-OuterAncestor 'C:\ProgramData\Nexowire'
    Assert-PrivateConfidentialAcl 'C:\ProgramData\Nexowire\hub-boot' $true
    Assert-PrivateConfidentialAcl $trustedFile $false
    $file=$trustedFile
    $requiredScope='windows-dpapi-local-machine'
    $scope=[Security.Cryptography.DataProtectionScope]::LocalMachine
  } else {
    if($sid -ceq 'S-1-5-18') { Fail 'AI03_SOURCE_REQUIRES_INTERACTIVE_OWNER' }
    if([string]::IsNullOrWhiteSpace($SourceFile) -or
       $SourceFile -cnotmatch '^[A-Za-z]:\\' -or
       $SourceFile.StartsWith('\\') -or
       $SourceFile.Contains('..')) {
      Fail 'AI03_SOURCE_PATH_INVALID'
    }
    $item=Get-TrustedItem $SourceFile $false
    $file=$item.FullName
    $requiredScope='windows-dpapi-current-user'
    $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
  }
  $raw=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8)
  if([Text.Encoding]::UTF8.GetByteCount($raw) -gt 2000000) {
    Fail 'AI03_SECRET_ENVELOPE_TOO_LARGE'
  }
  $e=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  if($e.version -ne 1 -or $e.protection -cne $requiredScope -or
     $e.purpose -cne 'control-plane-service-token') {
    Fail 'AI03_DPAPI_ENVELOPE_SCOPE_OR_PURPOSE_INVALID'
  }
  $cipher=[string]$e.ciphertext
  if($cipher.Length -lt 4 -or $cipher.Length -gt 2000000 -or
     $cipher.Length % 4 -ne 0 -or $cipher -cnotmatch '^[A-Za-z0-9+/]*={0,2}$') {
    Fail 'AI03_DPAPI_CIPHERTEXT_INVALID'
  }
  $bytes=[Convert]::FromBase64String($cipher)
  if([Convert]::ToBase64String($bytes) -cne $cipher) {
    Fail 'AI03_DPAPI_CIPHERTEXT_NONCANONICAL'
  }
  $entropy=[Text.Encoding]::UTF8.GetBytes('Nexowire/protected-secret/v1/control-plane-service-token')
  $secret=$null
  $hmac=$null
  try {
    $secret=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,$scope)
    if($secret.Length -lt 1 -or $secret.Length -gt 1048576) {
      Fail 'AI03_DPAPI_PLAINTEXT_INVALID'
    }
    $hmac=[Security.Cryptography.HMACSHA256]::new($secret)
    $prefix=[Text.Encoding]::UTF8.GetBytes("NEXOWIRE_SYSTEM_DPAPI_ACCEPTANCE_V1$([char]0)")
    [byte[]]$challenge=for($i=0;$i -lt 32;$i++) { [Convert]::ToByte($Nonce.Substring($i*2,2),16) }
    $data=New-Object byte[] ($prefix.Length+$challenge.Length)
    [Array]::Copy($prefix,0,$data,0,$prefix.Length)
    [Array]::Copy($challenge,0,$data,$prefix.Length,$challenge.Length)
    $proof=[BitConverter]::ToString($hmac.ComputeHash($data)).Replace('-','').ToLowerInvariant()
    [Array]::Clear($data,0,$data.Length)
  } finally {
    if($hmac) { $hmac.Dispose() }
    if($secret) { [Array]::Clear($secret,0,$secret.Length) }
    if($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
  }
  [pscustomobject]@{
    schemaVersion=1
    mode=$Mode
    checkedIdentitySid=$sid
    scopeVerified=$true
    proofSha256=$proof
    secretContentEmitted=$false
    physicalRebootAccepted=$false
    brokerEffectAccepted=$false
  } | ConvertTo-Json -Compress -Depth 3
} catch {
  # Do not emit the original exception, file contents, DPAPI plaintext,
  # ciphertext, token hashes or any untrusted error detail.
  $reason=([string]$_.Exception.Message).Trim()
  $known=@(
    'AI03_PATH_TYPE_INVALID','AI03_REPARSE_POINT_DENIED',
    'AI03_PROTECTED_OWNER_INVALID','AI03_PROTECTED_ANCESTOR_REPLACEABLE',
    'AI03_MACHINE_SECRET_READ_ACL_UNTRUSTED','AI03_SYSTEM_IDENTITY_REQUIRED',
    'AI03_SYSTEM_SOURCE_OVERRIDE_DENIED','AI03_SOURCE_REQUIRES_INTERACTIVE_OWNER',
    'AI03_SOURCE_PATH_INVALID','AI03_SECRET_ENVELOPE_TOO_LARGE',
    'AI03_DPAPI_ENVELOPE_SCOPE_OR_PURPOSE_INVALID',
    'AI03_DPAPI_CIPHERTEXT_INVALID','AI03_DPAPI_CIPHERTEXT_NONCANONICAL',
    'AI03_DPAPI_PLAINTEXT_INVALID'
  )
  if($known -cnotcontains $reason) { $reason='AI03_DPAPI_ATTESTATION_FAILED' }
  [Console]::Error.WriteLine($reason)
  exit 1
}