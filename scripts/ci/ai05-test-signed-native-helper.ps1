#requires -Version 5.1
# Disposable GitHub-hosted runner only. Test keys are never exported or uploaded.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows'){
  throw 'AI05_TEST_SIGNING_DISPOSABLE_HOST_REQUIRED'
}
$phaseLog=$env:AI05_NATIVE_PHASE_LOG
if([string]::IsNullOrWhiteSpace($phaseLog) -or -not [IO.Path]::IsPathRooted($phaseLog) -or
   (Split-Path -Leaf $phaseLog) -cne 'test-signed-native.phases.log' -or -not [IO.File]::Exists($phaseLog)){
  throw 'AI05_NATIVE_PHASE_LOG_REQUIRED'
}
function Phase([string]$name){
  [IO.File]::AppendAllText($phaseLog,([DateTime]::UtcNow.ToString('o')+' '+$name+[Environment]::NewLine),[Text.Encoding]::ASCII)
}
Phase 'ENTERED'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'AI05_TEST_SIGNING_ADMIN_REQUIRED'}
$modules='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$env:PSModulePath=$modules
foreach($name in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','PKI')){
  Phase ('MODULE_BEGIN_'+$name)
  Import-Module -Name (Join-Path $modules ($name+'\'+$name+'.psd1')) -ErrorAction Stop
  Phase ('MODULE_END_'+$name)
}
function Get-Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Cert-Hash($cert){
  $hash=[Security.Cryptography.SHA256]::Create()
  try{([BitConverter]::ToString($hash.ComputeHash($cert.RawData))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
$framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$compiler=Join-Path $framework 'csc.exe'
$reference=Join-Path $framework 'mscorlib.dll'
Phase 'COMPILER_SIGNATURE_BEGIN'
$compilerSig=Get-AuthenticodeSignature -LiteralPath $compiler
Phase 'COMPILER_SIGNATURE_END'
if($compilerSig.Status -ne 'Valid' -or $null -eq $compilerSig.SignerCertificate){throw 'AI05_FIXTURE_COMPILER_UNTRUSTED'}
$source=(Get-Item -LiteralPath 'native/windows-transfer-volume-flush.cs').FullName
Phase 'BUILD_BEGIN'
$build=& ./scripts/Build-Nexowire-TransferFlushArtifact.ps1 -BuildUnsigned -SourcePath $source -ExpectedSourceSha256 (Get-Hash $source) -ExpectedCompilerSha256 (Get-Hash $compiler) -ExpectedCompilerSignerSha256 (Cert-Hash $compilerSig.SignerCertificate) -ExpectedReferenceSha256 (Get-Hash $reference) | ConvertFrom-Json
if($build.status -cne 'UNSIGNED_BUILD_ONLY' -or $build.productionEligible -ne $false -or $build.sourceGitBlob -cne '7a62bf6c027544dfceb14f3ca939d7d76eb2ced9'){throw 'AI05_TEST_BUILD_RECEIPT_INVALID'}
Phase 'BUILD_END'
$root=Split-Path -Parent $build.artifactPath
$leaf=Split-Path -Leaf $root
if($leaf -cnotmatch '^Nexowire-TransferFlush-Build-[0-9a-f]{32}$' -or (Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'AI05_TEST_BUILD_ROOT_UNTRUSTED'}
$certs=New-Object 'System.Collections.Generic.List[System.Security.Cryptography.X509Certificates.X509Certificate2]'
$files=@($build.artifactPath,(Join-Path $root 'windows-transfer-volume-flush-upgrade.exe'))
$success=$false
try{
  Copy-Item -LiteralPath $files[0] -Destination $files[1]
  if((Get-Hash $files[0]) -cne $build.sha256 -or (Get-Hash $files[1]) -cne $build.sha256){throw 'AI05_UNSIGNED_COPY_CHANGED'}
  foreach($file in $files){
    $index=$certs.Count
    Phase ("CERT_CREATE_BEGIN_"+$index)
    $cert=New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=Nexowire disposable CI test only '+[guid]::NewGuid().ToString('N')) -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter ([DateTime]::Now.AddDays(1)) -KeyExportPolicy NonExportable -Provider 'Microsoft Software Key Storage Provider' -HashAlgorithm SHA256
    $certs.Add($cert)
    Phase ("CERT_CREATE_END_"+$index)
    # CurrentUser Root additions can invoke a modal Windows trust confirmation.
    # Avoid that interactive path. ONLY on elevated disposable hosted CI:
    # register the two generated public leaf certs in LocalMachine stores,
    # verify exact membership, and remove both by thumbprint in finally.
    # No global validation policy changes and no production key or host.
    foreach($name in @('Root','TrustedPublisher')){
      Phase ("TEST_TRUST_BEGIN_"+$index+"_"+$name)
      $store=[Security.Cryptography.X509Certificates.X509Store]::new($name,'LocalMachine')
      try{
        $store.Open('ReadWrite')
        if(@($store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false)).Count -ne 0){throw 'AI05_TEST_CERT_COLLISION'}
        $store.Add($cert)
        if(@($store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false)).Count -ne 1){throw 'AI05_TEST_TRUST_MISSING'}
      }finally{$store.Close()}
      Phase ("TEST_TRUST_END_"+$index+"_"+$name)
    }
    Phase ("AUTHENTICODE_SIGN_BEGIN_"+$index)
    $signed=Set-AuthenticodeSignature -FilePath $file -Certificate $cert -HashAlgorithm SHA256
    if($signed.Status -ne 'Valid'){throw 'AI05_FIXTURE_TEST_SIGNATURE_INVALID'}
    Phase ("AUTHENTICODE_SIGN_END_"+$index)
    Phase ("VERIFY_BEGIN_"+$index)
    $verified=& ./scripts/Build-Nexowire-TransferFlushArtifact.ps1 -VerifySigned -ArtifactPath $file -ExpectedArtifactSha256 (Get-Hash $file) -ExpectedArtifactSignerSha256 (Cert-Hash $cert) | ConvertFrom-Json
    if($verified.status -cne 'SIGNED_ARTIFACT_VERIFIED_NOT_INSTALLED' -or $verified.executed -ne $false -or $verified.installed -ne $false){throw 'AI05_FIXTURE_VERIFY_RECEIPT_INVALID'}
    Phase ("VERIFY_END_"+$index)
  }
  if((Get-Hash $files[0]) -ceq (Get-Hash $files[1])){throw 'AI05_TEST_ARTIFACTS_NOT_DISTINCT'}
  # Same reviewed C# source, distinct test signatures and content addresses.
  # This is an artifact replacement fixture, not two production releases.
  Phase 'STORAGE_BEGIN'
  & ./scripts/ci/ai05-protected-helper-fixture.ps1 -FixtureSources $files
  Phase 'STORAGE_END'
  $success=$true
}finally{
  Phase 'CLEANUP_BEGIN'
  $cleanupFailed=$false
  foreach($cert in $certs){
    foreach($name in @('Root','TrustedPublisher')){
      $store=[Security.Cryptography.X509Certificates.X509Store]::new($name,'LocalMachine')
      try{
        $store.Open('ReadWrite')
        $store.Remove($cert)
        if(@($store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false)).Count -ne 0){$cleanupFailed=$true}
      }catch{$cleanupFailed=$true}finally{$store.Close()}
    }
    try{
      Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey -ErrorAction Stop
      if(Test-Path -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint)){$cleanupFailed=$true}
    }catch{$cleanupFailed=$true}
    $cert.Dispose()
  }
  try{
    if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'AI05_BUILD_CLEANUP_UNTRUSTED'}
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    if(Test-Path -LiteralPath $root){$cleanupFailed=$true}
  }catch{$cleanupFailed=$true}
  if($cleanupFailed){Phase 'CLEANUP_FAILED';throw 'AI05_FIXTURE_TEST_SIGNING_CLEANUP_FAILED'}
  Phase 'CLEANUP_END'
}
if(-not $success){throw 'AI05_TEST_SIGNED_LIFECYCLE_FAILED'}
Phase 'COMPLETE'
[Console]::WriteLine('{"scope":"HOSTED_WINDOWS_TEST_SIGNING_CLEANUP","testTrustRemoved":true,"privateKeysRemoved":true,"buildFilesRemoved":true,"productionSigner":false}')
