# Read-only S2 algorithm/provider inventory. No key creation, export,
# certificates, credentials, service changes, DNS or Cloudflare API calls.
# A zero status is not proof of non-exportability or TPM-backed key identity.
$ErrorActionPreference = 'Stop'
$native = @"
using System;
using System.Runtime.InteropServices;
public static class NexowireS2ReadOnlyNcrypt {
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
  public static extern int NCryptOpenStorageProvider(
    out IntPtr handle, string name, int flags);
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
  public static extern int NCryptIsAlgSupported(
    IntPtr handle, string algorithm, int flags);
  [DllImport("ncrypt.dll")]
  public static extern int NCryptFreeObject(IntPtr handle);
}
"@
Add-Type -TypeDefinition $native -ErrorAction Stop
function StatusHex([int]$status) {
  $bits = [BitConverter]::ToUInt32([BitConverter]::GetBytes($status),0)
  return ('0x{0:X8}' -f $bits)
}
$results = @()
foreach ($provider in @(
  'Microsoft Software Key Storage Provider',
  'Microsoft Platform Crypto Provider'
)) {
  $handle = [IntPtr]::Zero
  $opened = [NexowireS2ReadOnlyNcrypt]::NCryptOpenStorageProvider(
    [ref]$handle,$provider,0)
  $algs = @()
  if($opened -eq 0) {
    try {
      foreach($nameAlg in @('ED25519','ECDSA_P256','RSA')) {
        $code = [NexowireS2ReadOnlyNcrypt]::NCryptIsAlgSupported(
          $handle,$nameAlg,0)
        $algs += [ordered]@{
          name=$nameAlg
          supported=($code -eq 0)
          status=StatusHex($code)
        }
      }
    } finally {
      [void][NexowireS2ReadOnlyNcrypt]::NCryptFreeObject($handle)
    }
  }
  $results += [ordered]@{
    provider=$provider
    openStatus=StatusHex($opened)
    algorithms=$algs
  }
}
[ordered]@{
  version=1
  origin='local-readonly-ncrypt-probe'
  checkedAtUtc=[DateTime]::UtcNow.ToString('o')
  osVersion=[Environment]::OSVersion.VersionString
  providers=$results
  persistentKeyTested=$false
  privateKeyNonExportabilityEstablished=$false
  tpmBackingEstablished=$false
  nativeAgentIdentityTested=$false
  productionAccepted=$false
} | ConvertTo-Json -Depth 7 -Compress
