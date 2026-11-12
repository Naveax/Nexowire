#requires -Version 5.1
<#
  Build an independent, source-pinned SYSTEM Hub runtime source for the AI-01
  protected installer. Does NOT install tasks, alter Program Files or migrate
  Hub state. Build work is done only in a unique disposable user Temp folder.
#>
[CmdletBinding()]
param(
  [ValidateSet('Plan','Build')][string]$Action='Plan',
  [Parameter(Mandatory=$true)][string]$RepositoryRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommitSha,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
$output=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$sha=$ExpectedCommitSha.ToLowerInvariant()
$profileRoot=[IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$documents=Join-Path $profileRoot 'Documents'
$parent=Split-Path -Parent $output
$name=[IO.Path]::GetFileName($output)
if($parent -ine $documents -or
   $name -notmatch '^Nexowire-SystemHub-Stage-[a-fA-F0-9]{8,40}$' -or
   $output.StartsWith($repo+'\',[StringComparison]::OrdinalIgnoreCase) -or
   $output -eq $repo){
  throw 'AI01_STAGE_OUTPUT_BOUNDARY_UNTRUSTED'
}
if(-not (Test-Path -LiteralPath $parent -PathType Container)){throw 'AI01_STAGE_OUTPUT_PARENT_MISSING'}
$cursor=$parent
while($cursor.Length -ge $profileRoot.Length) {
  $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'AI01_STAGE_OUTPUT_ANCESTOR_REPARSE'}
  if($cursor -ieq $profileRoot){break}
  $cursor=Split-Path -Parent $cursor
}
if(Test-Path -LiteralPath $output){throw 'AI01_STAGE_OUTPUT_EXISTS'}
if(Test-Path -LiteralPath ($output+'.provenance.json')){throw 'AI01_STAGE_PROVENANCE_EXISTS'}
if(-not (Test-Path -LiteralPath $repo -PathType Container)){throw 'AI01_STAGE_REPOSITORY_MISSING'}
$actual=(& git -C $repo rev-parse HEAD 2>$null | Out-String).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $actual -cne $sha){throw 'AI01_STAGE_SOURCE_COMMIT_MISMATCH'}
$dirty=@(& git -C $repo status --porcelain=v1 --untracked-files=all)
if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'AI01_STAGE_SOURCE_WORKTREE_DIRTY'}
$record=[ordered]@{
  action=$Action;repositoryRoot=$repo;sourceCommit=$sha
  outputDirectory=$output;sourceClean=$true
  buildFromGitArchive=$true;installerTargetUntouched=$true
}
if($Action -eq 'Plan'){
  $record.readyForBuild=$true
  [pscustomobject]$record|ConvertTo-Json -Depth 5
  return
}
$work=Join-Path $env:TEMP ('nexowire-ai01-stage-'+[guid]::NewGuid().ToString('N'))
$archive=Join-Path $work 'source.zip'
$sourceDir=Join-Path $work 'source'
$extract=Join-Path $work 'extract'
$stage=Join-Path $extract 'package'
$installer=Join-Path $sourceDir 'scripts\Install-Nexowire-SystemHubRuntime.ps1'
function Invoke-Checked([string]$exe,[string[]]$arguments,[string]$errorCode) {
  & $exe @arguments | Out-Host
  if($LASTEXITCODE -ne 0){throw $errorCode}
}
function Assert-NoReparse([string]$path) {
  $items=@(Get-Item -LiteralPath $path -Force -ErrorAction Stop)
  $items+=@(Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction Stop)
  foreach($item in $items){
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'AI01_STAGE_REPARSE_POINT'
    }
  }
}
try {
  New-Item -ItemType Directory -Path $work -ErrorAction Stop|Out-Null
  Invoke-Checked 'git' @('-C',$repo,'archive','--format=zip','-o',$archive,$sha) 'AI01_STAGE_ARCHIVE_FAILED'
  if(-not (Test-Path -LiteralPath $archive -PathType Leaf)){throw 'AI01_STAGE_ARCHIVE_MISSING'}
  Expand-Archive -LiteralPath $archive -DestinationPath $sourceDir -ErrorAction Stop
  Assert-NoReparse $sourceDir
  if(-not (Test-Path -LiteralPath (Join-Path $sourceDir 'package-lock.json') -PathType Leaf)){
    throw 'AI01_STAGE_LOCKFILE_MISSING'
  }
  $lockSha=(Get-FileHash -LiteralPath (Join-Path $sourceDir 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  Push-Location -LiteralPath $sourceDir
  try {
    Invoke-Checked 'npm.cmd' @('ci','--ignore-scripts','--no-audit','--no-fund') 'AI01_STAGE_DEV_INSTALL_FAILED'
    Invoke-Checked 'node.exe' @('node_modules/typescript/bin/tsc','-p','tsconfig.json') 'AI01_STAGE_BUILD_FAILED'
    $packJson=(& npm.cmd pack --ignore-scripts --json --pack-destination $work | Out-String)
    if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_PACK_FAILED'}
  } finally {Pop-Location}
  $packages=@($packJson|ConvertFrom-Json)
  if($packages.Count -ne 1){throw 'AI01_STAGE_PACK_RESPONSE_UNTRUSTED'}
  $filename=[string]$packages[0].filename
  if($filename -notmatch '^nexowire-[0-9]+\.[0-9]+\.[0-9]+\.tgz$'){
    throw 'AI01_STAGE_PACK_FILENAME_UNTRUSTED'
  }
  $tarball=Join-Path $work $filename
  if(-not(Test-Path -LiteralPath $tarball -PathType Leaf)){throw 'AI01_STAGE_PACK_FILE_MISSING'}
  New-Item -ItemType Directory -Path $extract -ErrorAction Stop|Out-Null
  Invoke-Checked 'C:\Windows\System32\tar.exe' @('-xzf',$tarball,'-C',$extract) 'AI01_STAGE_EXTRACT_FAILED'
  Assert-NoReparse $stage
  $pkgSha=(Get-FileHash -LiteralPath (Join-Path $sourceDir 'package.json') -Algorithm SHA256).Hash
  $packedPkgSha=(Get-FileHash -LiteralPath (Join-Path $stage 'package.json') -Algorithm SHA256).Hash
  if($pkgSha -cne $packedPkgSha){throw 'AI01_STAGE_PACKAGED_MANIFEST_MISMATCH'}
  Copy-Item -LiteralPath (Join-Path $sourceDir 'package-lock.json') -Destination (Join-Path $stage 'package-lock.json') -ErrorAction Stop
  Push-Location -LiteralPath $stage
  try {
    Invoke-Checked 'npm.cmd' @('ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund') 'AI01_STAGE_PRODUCTION_INSTALL_FAILED'
    Invoke-Checked 'node.exe' @('dist/src/cli.js','--version') 'AI01_STAGE_CLI_VERSION_FAILED'
    Invoke-Checked 'node.exe' @('dist/src/cli.js','--help') 'AI01_STAGE_CLI_HELP_FAILED'
  } finally {Pop-Location}
  Assert-NoReparse $stage
  if((Get-FileHash -LiteralPath (Join-Path $stage 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lockSha){
    throw 'AI01_STAGE_LOCKFILE_CHANGED'
  }
  $planText=(& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoLogo -NoProfile -NonInteractive -File $installer -Action Plan -SourceDirectory $stage -ExpectedTreeSha256 ('0'*64) | Out-String)
  if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_INSTALLER_PLAN_FAILED'}
  $firstPlan=$planText|ConvertFrom-Json
  $treeSha=[string]$firstPlan.treeSha256
  if($treeSha -notmatch '^[0-9a-f]{64}$'){throw 'AI01_STAGE_TREE_DIGEST_UNVERIFIED'}
  $planText=(& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoLogo -NoProfile -NonInteractive -File $installer -Action Plan -SourceDirectory $stage -ExpectedTreeSha256 $treeSha | Out-String)
  if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_RECHECK_PLAN_FAILED'}
  $finalPlan=$planText|ConvertFrom-Json
  if([string]$finalPlan.treeSha256 -cne $treeSha){throw 'AI01_STAGE_TREE_DIGEST_CHANGED'}
  $sourceBlockers=@($finalPlan.blockers|Where-Object {$_ -notin @('TARGET_ALREADY_EXISTS','TARGET_EXISTENCE_UNVERIFIED')})
  if($sourceBlockers.Count -gt 0){throw ('AI01_STAGE_SOURCE_PREFLIGHT_BLOCKED: '+($sourceBlockers -join ', '))}
  if(Test-Path -LiteralPath $output){throw 'AI01_STAGE_OUTPUT_RACE'}
  Move-Item -LiteralPath $stage -Destination $output -ErrorAction Stop
  # Verify again at the *published* path, not only the temporary path. If
  # any byte changes during promotion, do not issue a provenance receipt.
  $publishedText=(& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoLogo -NoProfile -NonInteractive -File $installer -Action Plan -SourceDirectory $output -ExpectedTreeSha256 $treeSha | Out-String)
  if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_PUBLISHED_PLAN_FAILED'}
  $publishedPlan=$publishedText|ConvertFrom-Json
  if([string]$publishedPlan.treeSha256 -cne $treeSha -or
     [int]$publishedPlan.files -ne [int]$finalPlan.files -or
     [long]$publishedPlan.bytes -ne [long]$finalPlan.bytes){
    throw 'AI01_STAGE_PUBLISHED_TREE_MISMATCH'
  }
  $publishedBlockers=@($publishedPlan.blockers|Where-Object {$_ -notin @('TARGET_ALREADY_EXISTS','TARGET_EXISTENCE_UNVERIFIED')})
  if($publishedBlockers.Count -gt 0){throw ('AI01_STAGE_PUBLISHED_BLOCKED: '+($publishedBlockers -join ', '))}
  $record['treeSha256']=$treeSha
  $record['files']=[int]$finalPlan.files
  $record['bytes']=[long]$finalPlan.bytes
  $record['lockfileSha256']=$lockSha
  $record['tarballSha256']=(Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
  $record['installerPlanBlockers']=@($finalPlan.blockers)
  $record['sourceReadyForElevatedInstallerPlan']=$true
  $record['productionInstalled']=$false
  $record['taskChanged']=$false
  $record['sqliteChanged']=$false
  $record['version']=[string]$packages[0].version
  $record['provenanceFormat']=1
  $recordJson=[pscustomobject]$record|ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($output+'.provenance.json',$recordJson,(New-Object Text.UTF8Encoding($false)))
  $recordJson
} finally {
  if(Test-Path -LiteralPath $work){
    $item=Get-Item -LiteralPath $work -Force -ErrorAction SilentlyContinue
    if($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}