# CLEAN-13 Windows immutable image production readiness inspector.
# READ-ONLY. This tool NEVER issues GO, never changes WDAC policies, never
# launches Cloudflared, never reads tunnel credentials, never logs env secrets.
# CI intentionally expects productionLaunchGO = false.
param([Parameter(Mandatory=$true)][string]$BinaryPath)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'CLEAN13_WINDOWS_ONLY' }
$expected = '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6'
$binary = (Resolve-Path -LiteralPath $BinaryPath -ErrorAction Stop).Path
if (-not [IO.Path]::IsPathRooted($binary)) { throw 'CLEAN13_ABSOLUTE_BINARY_REQUIRED' }
$sha = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
$sign = Get-AuthenticodeSignature -LiteralPath $binary -ErrorAction Stop
$signer = $sign.SignerCertificate
$shaPinned = $sha -eq $expected
$valid = ([string]$sign.Status -eq 'Valid') -and ($null -ne $signer) -and ($signer.Subject -match 'Cloudflare')

# Actual independent PS5.1/PS7 child checks using fixed, non-PATH binaries.
# Output is ASCII JSON containing only fixed enums and non-secret cert hashes.
$script = @'
$ErrorActionPreference='Stop'
try {
  $s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_C13_INSPECT_IMAGE -ErrorAction Stop
  $c=$s.SignerCertificate
  $r=[ordered]@{
    status=[string]$s.Status
    signerPresent=($null -ne $c)
    publisherCloudflare=($null -ne $c -and $c.Subject -match 'Cloudflare')
    thumbprint=$(if($null -ne $c){$c.Thumbprint}else{'NONE'})
  }
  [Console]::Out.Write(($r | ConvertTo-Json -Compress))
  exit 0
} catch {
  [Console]::Error.Write('C13:SIGNER_DIAGNOSTIC_EXCEPTION')
  exit 29
}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
function Invoke-AuditChild([string]$engine,[string]$executable,[int]$timeoutMs) {
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    return [ordered]@{engine=$engine;result='NOT_INSTALLED';exitCode=$null;elapsedMs=0;signatureStatus=$null;publisherCloudflare=$null;thumbprint=$null}
  }
  $start = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::new()
  try {
    $p.StartInfo.FileName = $executable
    $p.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $p.StartInfo.UseShellExecute = $false
    $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardOutput = $true
    $p.StartInfo.RedirectStandardError = $true
    $p.StartInfo.EnvironmentVariables['NEXOWIRE_C13_INSPECT_IMAGE'] = $binary
    if (-not $p.Start()) { throw 'AUDIT_SPAWN_FAILED' }
    if (-not $p.WaitForExit($timeoutMs)) {
      $p.Kill()
      $p.WaitForExit()
      return [ordered]@{engine=$engine;result='TIMEOUT_FAIL_CLOSED';exitCode=$null;elapsedMs=$start.ElapsedMilliseconds;signatureStatus=$null;publisherCloudflare=$null;thumbprint=$null}
    }
    $exit = $p.ExitCode
    $stdout = $p.StandardOutput.ReadToEnd()
    # Do not read raw stderr into output: errors may contain local paths.
    if ($exit -ne 0) {
      return [ordered]@{engine=$engine;result='NONZERO_FAIL_CLOSED';exitCode=$exit;elapsedMs=$start.ElapsedMilliseconds;signatureStatus=$null;publisherCloudflare=$null;thumbprint=$null}
    }
    $data = $stdout | ConvertFrom-Json -ErrorAction Stop
    $positive = $data.status -eq 'Valid' -and $data.signerPresent -eq $true -and $data.publisherCloudflare -eq $true -and $data.thumbprint -match '^[A-Fa-f0-9]{40}$'
    return [ordered]@{
      engine=$engine;result=$(if($positive){'SIGNED_SOURCE_VALID'}else{'SIGNATURE_REJECTED'})
      exitCode=$exit;elapsedMs=$start.ElapsedMilliseconds
      signatureStatus=[string]$data.status
      publisherCloudflare=[bool]$data.publisherCloudflare
      thumbprint=[string]$data.thumbprint
    }
  } catch {
    return [ordered]@{engine=$engine;result='INSPECTION_ERROR_FAIL_CLOSED';exitCode=$null;elapsedMs=$start.ElapsedMilliseconds;signatureStatus=$null;publisherCloudflare=$null;thumbprint=$null}
  } finally { $p.Dispose() }
}
$ps7 = Invoke-AuditChild 'PowerShell7' 'C:\Program Files\PowerShell\7\pwsh.exe' 15000
$ps51 = Invoke-AuditChild 'WindowsPowerShell5.1' 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' 15000

# Enumerate active App Control policies only. Policy counts and IsEnforced are
# NOT sufficient to prove UMCI, rule scope, signed policy, or kernel blocking.
$wdac = [ordered]@{inventoryAvailable=$false;activeEnforcedPolicyCount=0;policyScopeProven=$false;actualBlockEventProven=$false}
$ciTool = Join-Path $env:windir 'System32\CiTool.exe'
if (Test-Path -LiteralPath $ciTool -PathType Leaf) {
  try {
    $raw = & $ciTool -lp -json 2>$null
    if ($LASTEXITCODE -eq 0) {
      $policies = @((($raw -join [Environment]::NewLine) | ConvertFrom-Json).Policies)
      $enforced = @($policies | Where-Object { $_.IsEnforced -eq $true -or $_.IsEnforced -eq 'True' })
      $wdac.inventoryAvailable = $true
      $wdac.activeEnforcedPolicyCount = $enforced.Count
    }
  } catch { $wdac.inventoryAvailable = $false }
}
$report = [ordered]@{
  schema='NEXOWIRE_C13_WINDOWS_READINESS_V1'
  sha256Pinned=$shaPinned
  directAuthenticodeValid=$valid
  signerThumbprint=$(if($null -ne $signer){$signer.Thumbprint}else{$null})
  powershell7=$ps7
  powershell51=$ps51
  wdac=$wdac
  nativeHeldImageSectionCustodianImplemented=$false
  productionLaunchGO=$false
  reason='UNPROVEN_KERNEL_IMAGE_SECTION_AND_WDAC_ENFORCEMENT'
}
# No paths, secrets, tokens, user SIDs, environment dumps or live credentials.
Write-Output ('NEXOWIRE_C13_WINDOWS_READINESS=' + ($report | ConvertTo-Json -Compress -Depth 7))
