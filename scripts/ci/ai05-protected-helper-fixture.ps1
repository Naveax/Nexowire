param([string[]]$FixtureSources=@())
# CI-only fixture. No production credentials, runtime registration or helper execution.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows'){
  throw 'AI05_DISPOSABLE_HOST_REQUIRED'
}
if($FixtureSources.Count -ne 0 -and $FixtureSources.Count -ne 2){throw 'AI05_FIXTURE_SOURCE_COUNT_INVALID'}
$modules='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$env:PSModulePath=$modules
foreach($name in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')){
  Import-Module -Name (Join-Path $modules ($name+'\'+$name+'.psd1')) -ErrorAction Stop
}
$fixed='C:\ProgramData\Nexowire-TransferRuntime'
if(Test-Path -LiteralPath $fixed){throw 'AI05_FIXTURE_FIXED_ROOT_ALREADY_EXISTS'}
$runtime=Join-Path 'C:\ProgramData' ('Nexowire-AI05-CI-'+[guid]::NewGuid().ToString('N'))
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($admin)
foreach($sid in @($admin,$system)){
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
[void][IO.Directory]::CreateDirectory($runtime,$acl)
try{
  $nodeSource=(& node -p 'process.execPath').Trim()
  if($LASTEXITCODE -ne 0){throw 'AI05_FIXTURE_NODE_MISSING'}
  $signature=Get-AuthenticodeSignature -LiteralPath $nodeSource
  if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'){
    throw 'AI05_FIXTURE_NODE_SIGNATURE_INVALID'
  }
  $node=Join-Path $runtime 'node.exe'
  Copy-Item -LiteralPath $nodeSource -Destination $node
  if((Get-FileHash -LiteralPath $node).Hash -cne (Get-FileHash -LiteralPath $nodeSource).Hash){throw 'AI05_FIXTURE_NODE_COPY_CHANGED'}
  $files=@(
    'dist/src/installer/protected-transfer-helper-lifecycle.js',
    'dist/src/security/windows-programdata-acl.js',
    'dist/src/security/windows-privileged-runtime-trust.js'
  )
  foreach($relative in $files){
    $dest=Join-Path $runtime $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
    Copy-Item -LiteralPath $relative -Destination $dest
    if((Get-FileHash -LiteralPath $relative).Hash -cne (Get-FileHash -LiteralPath $dest).Hash){throw 'AI05_FIXTURE_SOURCE_COPY_CHANGED'}
  }
  $entry=Join-Path $runtime 'fixture.mjs'
  Copy-Item -LiteralPath 'scripts/ci/ai05-protected-helper-fixture.mjs' -Destination $entry
  [IO.File]::WriteAllText((Join-Path $runtime 'package.json'),'{"type":"module"}')
  # This is a fresh fixture root only. Never change the fixed helper root ACL
  # here; the actual lifecycle implementation must create and verify it.
  & 'C:\Windows\System32\icacls.exe' $runtime /setowner '*S-1-5-32-544' /T
  if($LASTEXITCODE -ne 0){throw 'AI05_FIXTURE_OWNER_FAILED'}
  & $node $entry @FixtureSources
  if($LASTEXITCODE -ne 0){throw 'AI05_PROTECTED_LIFECYCLE_FIXTURE_FAILED'}
}finally{
  # No recursive deletion of the fixed helper root. The fixture removes only
  # its verified known binary names; failed evidence remains on disposable VM.
  $item=Get-Item -LiteralPath $runtime -Force -ErrorAction SilentlyContinue
  if($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){
    Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction Stop
  }
}
