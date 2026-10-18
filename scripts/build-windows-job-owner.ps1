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
  $install = (& $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath | Select-Object -First 1)
  if (!$install) { throw 'MSVC C++ tools not installed.' }
  $vcvars = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
  if (!(Test-Path $vcvars)) { throw "Missing vcvars64.bat: $vcvars" }
  $obj = Join-Path $root 'native\windows-job-owner.obj'
  $command = '"' + $vcvars + '" >nul && cl.exe /nologo /O2 /W4 /utf-8 /Fo:"' +
    $obj + '" /Fe:"' + $OutputPath + '" "' + $source + '" shell32.lib kernel32.lib'
  & cmd.exe /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw "MSVC helper build failed: $LASTEXITCODE" }
}
if (!(Test-Path $OutputPath)) { throw 'Native helper output missing.' }
# A build-produced checksum detects helper-only replacement. It does not
# authenticate the publisher: the release signer gate remains required.
$sha = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [IO.Path]::ChangeExtension($OutputPath, '.sha256')
[IO.File]::WriteAllText($manifest, $sha + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output "Windows Job helper built: $OutputPath"
