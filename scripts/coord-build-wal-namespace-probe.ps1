# Local, disposable Windows FileId/rename-sharing source proof. No live journals.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows host required.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'native\windows-journal-namespace-probe.c'
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Reviewed source missing.' }
$x86 = (Get-Item 'Env:ProgramFiles(x86)').Value
$vswhere = Join-Path $x86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'MSVC locator missing.' }
$install = (& $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath | Select-Object -First 1)
if (!$install) { throw 'MSVC C++ tools missing.' }
$vcvars = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw 'vcvars64.bat missing.' }
$staging = Join-Path ([IO.Path]::GetTempPath()) ('nexowire-wal-namespace-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
$exe = Join-Path $staging 'journal-probe.exe'
$obj = Join-Path $staging 'journal-probe.obj'
try {
  $cmd = '"' + $vcvars + '" >nul && cl.exe /nologo /W4 /WX /O2 /utf-8 /Fo:"' + $obj + '" /Fe:"' + $exe + '" "' + $source + '" kernel32.lib'
  & cmd.exe /d /s /c $cmd
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Native probe MSVC compilation failed.' }
  & $exe --selftest
  if ($LASTEXITCODE -ne 0) { throw 'Native probe failed; no kernel acceptance evidence.' }
  Write-Output 'Read-only disposable Windows FileId probe passed; CORE and SQLite checked-open remain NO-GO.'
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
