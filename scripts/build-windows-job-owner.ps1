# Build Windows Job owner from reviewed source. No binary is committed.
param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows build only.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'native\windows-job-owner.c'
if (!$OutputPath) { $OutputPath = Join-Path $root 'native\windows-job-owner.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$zig = Get-Command 'zig.exe' -ErrorAction SilentlyContinue
if ($zig) {
  & $zig.Source cc -O2 -target x86_64-windows-gnu -o $OutputPath $source -lshell32 -lkernel32
  if ($LASTEXITCODE -ne 0) { throw "Zig helper build failed: $LASTEXITCODE" }
} else {
  $x86 = (Get-Item 'Env:ProgramFiles(x86)').Value
  $vswhere = Join-Path $x86 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (!(Test-Path $vswhere)) { throw 'Neither Zig nor Microsoft Visual C++ is available.' }
  $installs = @(& $vswhere -all -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath)
  if ($installs.Count -eq 0) { throw 'MSVC C++ tools not installed.' }
  $obj = Join-Path $root 'native\windows-job-owner.obj'
  # A batch file avoids nested cmd.exe quoting rewritten by Windows PowerShell 5.1.
  # Reject batch metacharacters in paths; do not reinterpret user paths as commands.
  foreach ($item in @($source, $obj, $OutputPath, $root)) {
    if ($item -match '[%"!^\r\n]') { throw 'MSVC build path contains unsafe batch syntax.' }
  }
  $compiled = $false
  $failedInstalls = @()
  foreach ($install in $installs) {
    $vcvars = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
    if (!(Test-Path -LiteralPath $vcvars -PathType Leaf)) { $failedInstalls += 'Missing vcvars: ' + $install; continue }
    if ($vcvars -match '[%"!^\r\n]') { $failedInstalls += 'Unsafe vcvars path: ' + $install; continue }
    $batchPath = Join-Path $root ('native\job-build-' + [guid]::NewGuid().ToString('N') + '.cmd')
    $batch = @(
      '@echo off'
      ('call "' + $vcvars + '" >nul')
      'if errorlevel 1 exit /b 11'
      ('cl.exe /nologo /O2 /W4 /WX /utf-8 /Fo:"' + $obj + '" /Fe:"' + $OutputPath + '" "' + $source + '" shell32.lib kernel32.lib')
      'exit /b %errorlevel%'
    )
    try {
      [IO.File]::WriteAllLines($batchPath, $batch, [Text.Encoding]::ASCII)
      & cmd.exe /d /c $batchPath
      $result = $LASTEXITCODE
      if ($result -eq 0 -and (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
        Write-Output "MSVC helper built using: $install"
        $compiled = $true
        break
      }
      $failedInstalls += ($install + ' (exit ' + $result + ')')
    } finally {
      if (Test-Path -LiteralPath $batchPath) { Remove-Item -LiteralPath $batchPath -Force }
    }
  }
  if (!$compiled) { throw ('MSVC helper build failed for every discovered toolchain: ' + ($failedInstalls -join '; ')) }
}
if (!(Test-Path $OutputPath)) { throw 'Native helper output missing.' }
Write-Output "Windows Job helper built: $OutputPath"
