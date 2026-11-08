# #11 disposable GitHub-hosted Windows CI only. Not production installation.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'GITHUB_HOSTED_WINDOWS_RUNNER_REQUIRED'
}
# The canonical builder selects Zig when present. This QA guard must not claim
# an MSVC diagnostic check if that different compiler was selected.
if (Get-Command 'zig.exe' -ErrorAction SilentlyContinue) {
  throw 'MSVC_FIXTURE_BUILD_NOT_SELECTED'
}
$builder = Join-Path $PSScriptRoot 'build-windows-job-owner.ps1'
$checker = Join-Path $PSScriptRoot 'qa-windows-job-msvc-log.ts'
$logFile = Join-Path $env:RUNNER_TEMP ('nexowire-msvc-qa-' + [guid]::NewGuid().ToString('N') + '.log')
try {
  # Preserve whole compiler lines; formatted output can truncate a diagnostic.
  $buildOutput = @(& $builder 2>&1)
  $buildExit = $LASTEXITCODE
  foreach ($line in $buildOutput) { Write-Output $line }
  if ($buildExit -ne 0) { throw 'WINDOWS_JOB_BUILD_FAILED' }
  [IO.File]::WriteAllLines($logFile, [string[]]$buildOutput, [Text.UTF8Encoding]::new($false))
  & node --import tsx $checker $logFile
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_JOB_MSVC_LOG_UNVERIFIED' }
} finally {
  if (Test-Path -LiteralPath $logFile) {
    Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
  }
}
