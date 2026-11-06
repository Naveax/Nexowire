# Build only. Never register a credential, show approval UI or install a service.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows build only.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'native\windows-core-webauthn-approval.c'
$output = Join-Path $root 'native\windows-core-webauthn-approval.exe'
$object = Join-Path $root 'native\windows-core-webauthn-approval.obj'
$vswhere = Join-Path (Get-Item 'Env:ProgramFiles(x86)').Value 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'MSVC tools unavailable.' }
$install = (& $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath | Select-Object -First 1)
if (!$install) { throw 'MSVC tools unavailable.' }
$vcvars = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw 'MSVC environment unavailable.' }
$command = '"' + $vcvars + '" >nul && cl.exe /nologo /std:c11 /O2 /W4 /WX /utf-8 /Fo:"' +
  $object + '" /Fe:"' + $output + '" "' + $source +
  '" /link /SUBSYSTEM:CONSOLE kernel32.lib user32.lib wtsapi32.lib'
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $output -PathType Leaf)) {
  throw 'Native WebAuthn component build failed.'
}
Write-Output 'WebAuthn component built; unsigned, uninstalled, no credential or CORE authority.'
