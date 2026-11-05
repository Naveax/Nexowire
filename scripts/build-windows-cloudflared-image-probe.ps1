# Build disposable CLEAN-13 native FileIdInfo/CREATE_SUSPENDED probe.
# NEVER ship this binary as an executable custodian or enable Windows tunnels.
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'Windows-only disposable test helper'}
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source=Join-Path $root 'native\windows-cloudflared-image-probe.c'
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
if(!(Test-Path -LiteralPath $source)){throw 'Missing reviewed native image probe source'}
$vswhere=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if(!(Test-Path -LiteralPath $vswhere)){throw 'MSVC discovery missing: fail closed'}
$install=(& $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath | Select-Object -First 1)
if(!$install){throw 'MSVC C++ tools unavailable'}
$vcvars=Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
if(!(Test-Path -LiteralPath $vcvars)){throw 'Missing vcvars64'}
$obj=Join-Path $env:RUNNER_TEMP 'nw-clean13-native-image-probe.obj'
# No arbitrary build path, no download, no secrets and no PATH-based compiler.
$cmd='"'+$vcvars+'" >nul && cl.exe /nologo /W4 /WX /O2 /utf-8 /DUNICODE /D_UNICODE /Fo:"'+$obj+'" /Fe:"'+$OutputPath+'" "'+$source+'" kernel32.lib bcrypt.lib'
& cmd.exe /d /s /c $cmd
if($LASTEXITCODE -ne 0){throw "Native probe compilation failed: $LASTEXITCODE"}
if(!(Test-Path -LiteralPath $OutputPath)){throw 'Compiled native probe is missing'}
Write-Host 'NEXOWIRE_C13_NATIVE_BUILD=PASS compiler=MSVC disposable=true launcher=false'
