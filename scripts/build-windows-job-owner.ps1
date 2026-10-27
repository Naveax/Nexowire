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
  & $zig.Source cc -O2 -target x86_64-windows-gnu -o $OutputPath $source -lshell32 -lkernel32 -ladvapi32
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
    $obj + '" /Fe:"' + $OutputPath + '" "' + $source + '" shell32.lib kernel32.lib advapi32.lib'
  & cmd.exe /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw "MSVC helper build failed: $LASTEXITCODE" }
}
if (!(Test-Path $OutputPath)) { throw 'Native helper output missing.' }
# A build-produced checksum detects helper-only replacement. It does not
# authenticate the publisher: the release signer gate remains required.
$sha = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [IO.Path]::ChangeExtension($OutputPath, '.sha256')
[IO.File]::WriteAllText($manifest, $sha + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
# Isolated test-only binary, NEVER included in the installed Agent bundle.
# The fixture may create one synthetic suspended cmd.exe and terminates
# it by the precise CreateProcessW handle if breakaway is unexpectedly allowed.
$fixture = Join-Path $root 'test\fixtures\windows-job-breakaway-attempt.c'
$fixtureExe = Join-Path $root 'test\fixtures\windows-job-breakaway-attempt.exe'
if ($zig) {
  & $zig.Source cc -O2 -target x86_64-windows-gnu -o $fixtureExe $fixture -lkernel32
  if ($LASTEXITCODE -ne 0) { throw "Windows breakaway test fixture compile failed: $LASTEXITCODE" }
} else {
  $obj = Join-Path $root 'test\fixtures\windows-job-breakaway-attempt.obj'
  $build = '"' + $vcvars + '" >nul && cl.exe /nologo /O2 /W4 /utf-8 /Fo:"' +
    $obj + '" /Fe:"' + $fixtureExe + '" "' + $fixture + '" kernel32.lib'
  & cmd.exe /d /s /c $build
  if ($LASTEXITCODE -ne 0) { throw "Windows breakaway MSVC fixture compile failed: $LASTEXITCODE" }
}
if (!(Test-Path -LiteralPath $fixtureExe)) { throw 'Windows breakaway test fixture missing' }

# Isolated hostile-nested parent Job fixture; no production binary changed.
$nestedSrc = Join-Path $root 'test\fixtures\windows-job-hostile-nested.c'
$nestedExe = Join-Path $root 'test\fixtures\windows-job-hostile-nested.exe'
if ($zig) {
  & $zig.Source cc -O2 -target x86_64-windows-gnu -o $nestedExe $nestedSrc -lkernel32
  if ($LASTEXITCODE -ne 0) { throw "Hostile nested Job fixture compiler failed: $LASTEXITCODE" }
} else {
  $nestedObj = Join-Path $root 'test\fixtures\windows-job-hostile-nested.obj'
  $nestedCmd = '"' + $vcvars + '" >nul && cl.exe /nologo /O2 /W4 /utf-8 /Fo:"' +
    $nestedObj + '" /Fe:"' + $nestedExe + '" "' + $nestedSrc + '" kernel32.lib'
  & cmd.exe /d /s /c $nestedCmd
  if ($LASTEXITCODE -ne 0) { throw "Hostile nested Job MSVC fixture failed: $LASTEXITCODE" }
}
if (!(Test-Path -LiteralPath $nestedExe)) { throw 'Hostile nested Job fixture missing' }

Write-Output "Windows Job helper built: $OutputPath"
