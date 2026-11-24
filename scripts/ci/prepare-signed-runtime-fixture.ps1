# CI-only signed runtime preparation. Existing installed runtime is never altered.
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'SIGNED_RUNTIME_DISPOSABLE_HOST_REQUIRED'
}
$root='C:\Program Files\nodejs'
$node=Join-Path $root 'node.exe'
$npmCli=Join-Path $root 'node_modules\npm\bin\npm-cli.js'
$publisher='CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
function Assert-OfficialSignature([string]$file) {
  $item=Get-Item -LiteralPath $file -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'SIGNED_RUNTIME_UNSAFE_FILE'
  }
  $sig=Get-AuthenticodeSignature -LiteralPath $file
  if($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or $sig.SignerCertificate.Subject -cne $publisher) {
    throw 'SIGNED_RUNTIME_PUBLISHER_REJECTED'
  }
}
if(!(Test-Path -LiteralPath $root)) {
  # Use the exact version already selected by trusted actions/setup-node.
  # Only install when the fixed official directory is entirely absent.
  $version=(& node -p 'process.versions.node').Trim()
  if($LASTEXITCODE -ne 0 -or $version -cnotmatch '^(22|24)\.[0-9]+\.[0-9]+$') {throw 'SIGNED_RUNTIME_VERSION_REJECTED'}
  $temp=Join-Path $env:RUNNER_TEMP ('nx-signed-node-'+[guid]::NewGuid())
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $name='node-v'+$version+'-x64.msi'
    $base='https://nodejs.org/dist/v'+$version
    $msi=Join-Path $temp $name
    $sums=Join-Path $temp 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri ($base+'/'+$name) -OutFile $msi -TimeoutSec 90
    Invoke-WebRequest -UseBasicParsing -Uri ($base+'/SHASUMS256.txt') -OutFile $sums -TimeoutSec 30
    $pattern='^([0-9a-f]{64})  '+[regex]::Escape($name)+'$'
    $rows=@(Get-Content -LiteralPath $sums | Where-Object {$_ -cmatch $pattern})
    if($rows.Count -ne 1) {throw 'SIGNED_RUNTIME_HASH_MANIFEST_REJECTED'}
    $expected=([regex]::Match($rows[0],$pattern)).Groups[1].Value
    if((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {throw 'SIGNED_RUNTIME_HASH_MISMATCH'}
    Assert-OfficialSignature $msi
    if(Test-Path -LiteralPath $root) {throw 'SIGNED_RUNTIME_ROOT_CHANGED'}
    $install=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList @('/i',('"'+$msi+'"'),'/qn','/norestart') -Wait -PassThru
    if($install.ExitCode -ne 0) {throw ('SIGNED_RUNTIME_MSI_EXIT_'+$install.ExitCode)}
    Write-Output 'SIGNED_RUNTIME_PROVISIONED_OFFICIAL_MSI'
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
  }
} else {
  Write-Output 'SIGNED_RUNTIME_EXISTING_READ_ONLY'
}
# Never repair permissions, ownership or publisher. The production ACL inspector
# independently verifies every ancestor and descendant in the actual test.
$rootItem=Get-Item -LiteralPath $root -ErrorAction Stop
if(!$rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'SIGNED_RUNTIME_ROOT_UNSAFE'}
if(!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $npmCli -PathType Leaf)) {throw 'SIGNED_RUNTIME_PREREQUISITE_MISSING'}
Assert-OfficialSignature $node
Write-Output ('SIGNED_RUNTIME_FIXTURE_READY sha256='+ (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant())
