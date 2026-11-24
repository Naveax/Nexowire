#requires -Version 5.1
<#
  Offline build and verification only. Never install, sign, run the helper,
  create production directories, change ACLs, generate keys, or elevate.
  The release authority supplies independent SHA-256 and signer pins.
#>
[CmdletBinding(DefaultParameterSetName='Verify')]
param(
  [Parameter(Mandatory=$true,ParameterSetName='Build')]
  [switch]$BuildUnsigned,
  [Parameter(Mandatory=$true,ParameterSetName='Verify')]
  [switch]$VerifySigned,
  [Parameter(Mandatory=$true,ParameterSetName='Build')]
  [string]$SourcePath,
  [Parameter(Mandatory=$true,ParameterSetName='Build')]
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceSha256,
  [Parameter(Mandatory=$true,ParameterSetName='Build')]
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedCompilerSha256,
  [Parameter(Mandatory=$true,ParameterSetName='Build')]
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedCompilerSignerSha256,
  [Parameter(Mandatory=$true,ParameterSetName='Verify')]
  [string]$ArtifactPath,
  [Parameter(Mandatory=$true,ParameterSetName='Verify')]
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArtifactSha256,
  [Parameter(Mandatory=$true,ParameterSetName='Verify')]
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArtifactSignerSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
   -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess){
  throw 'AI05_TRANSFER_WINDOWS_X64_REQUIRED'
}

function Get-HexDigest([byte[]]$bytes,[string]$algorithm){
  $hash=[Security.Cryptography.HashAlgorithm]::Create($algorithm)
  try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Assert-PlainPath([string]$inputPath,[bool]$directory){
  if($inputPath -notmatch '^[A-Za-z]:\\' -or $inputPath.Substring(2).Contains(':') -or $inputPath.Contains('/')){
    throw 'AI05_TRANSFER_LOCAL_PATH_REQUIRED'
  }
  $full=[IO.Path]::GetFullPath($inputPath)
  if($full -cne $inputPath){throw 'AI05_TRANSFER_CANONICAL_PATH_REQUIRED'}
  $item=Get-Item -LiteralPath $full -Force
  if([bool]$item.PSIsContainer -ne $directory){throw 'AI05_TRANSFER_FILE_KIND_INVALID'}
  for($cursor=$full; $cursor; $cursor=Split-Path -Parent $cursor){
    $entry=Get-Item -LiteralPath $cursor -Force
    if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'AI05_TRANSFER_REPARSE_DENIED'
    }
    $next=Split-Path -Parent $cursor
    if(-not $next -or $next -eq $cursor){break}
  }
  return $item
}
function Assert-SignedArtifact([string]$file,[string]$expectedHash,[string]$expectedSigner,[long]$maxBytes){
  $item=Assert-PlainPath $file $false
  if($item.Length -lt 1 -or $item.Length -gt $maxBytes){throw 'AI05_TRANSFER_ARTIFACT_SIZE_INVALID'}
  $actual=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -cne $expectedHash){throw 'AI05_TRANSFER_ARTIFACT_HASH_MISMATCH'}
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate){
    throw 'AI05_TRANSFER_AUTHENTICODE_INVALID'
  }
  $certHash=Get-HexDigest $signature.SignerCertificate.RawData 'SHA256'
  if($certHash -cne $expectedSigner){throw 'AI05_TRANSFER_SIGNER_PIN_MISMATCH'}
  [void](Assert-PlainPath $file $false)
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $actual){
    throw 'AI05_TRANSFER_ARTIFACT_CHANGED'
  }
  return [pscustomobject]@{sha256=$actual;signerSha256=$certHash;authenticode='Valid'}
}

if($VerifySigned){
  $evidence=Assert-SignedArtifact $ArtifactPath $ExpectedArtifactSha256 $ExpectedArtifactSignerSha256 (8MB)
  [pscustomobject]@{
    status='SIGNED_ARTIFACT_VERIFIED_NOT_INSTALLED'
    artifactPath=$ArtifactPath;sha256=$evidence.sha256
    signerSha256=$evidence.signerSha256;authenticode=$evidence.authenticode
    installed=$false;executed=$false;protectedAclVerified=$false
  } | ConvertTo-Json -Depth 4
  return
}
# Reviewed exact upstream #1283 source. A source change requires independent
# review and a new blob pin; a caller-provided digest alone is insufficient.
$reviewedSourceBlob='7a62bf6c027544dfceb14f3ca939d7d76eb2ced9'
$sourceItem=Assert-PlainPath $SourcePath $false
if($sourceItem.Length -lt 1 -or $sourceItem.Length -gt 64KB){throw 'AI05_TRANSFER_SOURCE_SIZE_INVALID'}
$sourceBytes=[IO.File]::ReadAllBytes($SourcePath)
if((Get-HexDigest $sourceBytes 'SHA256') -cne $ExpectedSourceSha256){throw 'AI05_TRANSFER_SOURCE_HASH_MISMATCH'}
$header=[Text.Encoding]::ASCII.GetBytes(('blob '+$sourceBytes.Length+[char]0))
$gitBytes=[byte[]]($header+$sourceBytes)
if((Get-HexDigest $gitBytes 'SHA1') -cne $reviewedSourceBlob){throw 'AI05_TRANSFER_SOURCE_REVIEW_REQUIRED'}

$windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$framework=Join-Path $windows 'Microsoft.NET\Framework64\v4.0.30319'
$compiler=Join-Path $framework 'csc.exe'
$reference=Join-Path $framework 'mscorlib.dll'
[void](Assert-PlainPath $reference $false)
[void](Assert-SignedArtifact $compiler $ExpectedCompilerSha256 $ExpectedCompilerSignerSha256 (32MB))

# Only a fresh child of the current user's existing Temp directory is used.
# No ProgramData or Program Files destination, including on build success.
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
[void](Assert-PlainPath $temp $true)
foreach($protected in @([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData),[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),$windows)){
  if($protected -and ($temp -ieq $protected -or $temp.StartsWith($protected.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase))){
    throw 'AI05_TRANSFER_BUILD_TEMP_PROTECTED'
  }
}
$work=Join-Path $temp ('Nexowire-TransferFlush-Build-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
$success=$false
try {
  [void](Assert-PlainPath $work $true)
  $source=Join-Path $work 'windows-transfer-volume-flush.cs'
  $binary=Join-Path $work 'windows-transfer-volume-flush.exe'
  [IO.File]::WriteAllBytes($source,$sourceBytes)
  & $compiler '/nologo' '/noconfig' '/nostdlib+' '/target:exe' '/platform:x64' '/optimize+' '/debug-' ('/reference:'+$reference) ('/out:'+$binary) $source | Out-Host
  if($LASTEXITCODE -ne 0){throw 'AI05_TRANSFER_COMPILE_FAILED'}
  [void](Assert-SignedArtifact $compiler $ExpectedCompilerSha256 $ExpectedCompilerSignerSha256 (32MB))
  $out=Assert-PlainPath $binary $false
  if($out.Length -lt 1 -or $out.Length -gt 8MB){throw 'AI05_TRANSFER_ARTIFACT_SIZE_INVALID'}
  if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSourceSha256){throw 'AI05_TRANSFER_SOURCE_CHANGED'}
  $digest=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  $result=[pscustomobject]@{
    status='UNSIGNED_BUILD_ONLY';artifactPath=$binary;sha256=$digest
    sourceGitBlob=$reviewedSourceBlob;sourceSha256=$ExpectedSourceSha256
    compilerSha256=$ExpectedCompilerSha256;compilerSignerSha256=$ExpectedCompilerSignerSha256
    installed=$false;executed=$false;productionEligible=$false
  }
  $success=$true
  $result | ConvertTo-Json -Depth 4
} finally {
  if(-not $success){
    $item=Get-Item -LiteralPath $work -Force -ErrorAction SilentlyContinue
    if($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop
    }
  }
}
