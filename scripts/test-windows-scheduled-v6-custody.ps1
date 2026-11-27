# Disposable hosted acceptance only; never build into a release bundle.
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'HOSTED_WINDOWS_FIXTURE_ONLY'}
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sha=(& git -C $root rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $sha -cne $env:NEXOWIRE_EXPECTED_COMMIT_SHA){throw 'EXACT_HEAD_REQUIRED'}
$fixture=Join-Path $root 'test\fixtures\windows-scheduled-v6-custody-native.c'
$native=Join-Path $root 'native\windows-scheduled-v6-custody.c'
$work=Join-Path $env:RUNNER_TEMP ('nx-v6-custody-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $work
try {
  $vswhere=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
  $vs=(& $vswhere -latest -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -property installationPath | Select-Object -First 1)
  if(!$vs){throw 'MSVC_REQUIRED'}
  $vcvars=Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  $exe=Join-Path $work 'custody-fixture.exe'
  $obj=Join-Path $work 'custody-fixture.obj'
  $libObj=Join-Path $work 'custody-native.obj'
  $bat=Join-Path $work 'build.cmd'
  foreach($p in @($vcvars,$exe,$obj,$libObj,$fixture,$native)){if($p -match '[%\"!^\r\n]'){throw 'UNSAFE_BUILD_PATH'}}
  [IO.File]::WriteAllLines($bat,@(
    '@echo off',
    ('call "'+$vcvars+'" >nul'),
    'if errorlevel 1 exit /b 11',
    ('cl.exe /nologo /W4 /WX /O2 /utf-8 /c /Fo:"'+$libObj+'" "'+$native+'"'),
    'if errorlevel 1 exit /b 12',
    ('cl.exe /nologo /W4 /WX /O2 /utf-8 /Fo:"'+$obj+'" /Fe:"'+$exe+'" "'+$fixture+'" bcrypt.lib psapi.lib'),
    'exit /b %errorlevel%'
  ),[Text.Encoding]::ASCII)
  & "$env:SystemRoot\System32\cmd.exe" /d /c $bat
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $libObj)){throw 'NATIVE_BUILD_FAILED'}
  Write-Host "NX_CUSTODY_BUILD=PASS exact=$sha native_sha256=$((Get-FileHash -LiteralPath $native).Hash) fixture_sha256=$((Get-FileHash -LiteralPath $exe).Hash)"
  $dir=Join-Path $work 'held'
  $null=New-Item -ItemType Directory -Path $dir
  $file=Join-Path $dir 'synthetic.exe'
  $linked=Join-Path $work 'linked.exe'
  Copy-Item -LiteralPath $exe -Destination $file
  Copy-Item -LiteralPath $exe -Destination $linked
  $null=New-Item -ItemType HardLink -Path (Join-Path $work 'extra-link.exe') -Target $linked
  $digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  # Capture both streams without losing the exact native exit or cold evidence.
  # The expected cold logical mismatch is stdout/stderr data, not a PS exception.
  function Invoke-CustodyFixture([string]$mode){
    # Windows PowerShell treats redirected native stderr as ErrorRecords.
    # Continue only within this native invocation; enforce exact exit below.
    $saved=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $global:LASTEXITCODE=-1
      $raw=@(& $exe $mode $file $digest $dir $linked 2>&1)
      $code=$global:LASTEXITCODE
    } finally {$ErrorActionPreference=$saved}
    @{Exit=$code;Lines=@($raw|ForEach-Object {$_.ToString()})}
  }
  $coldRun=Invoke-CustodyFixture '--fixture-cold'
  $coldExit=$coldRun.Exit
  $cold=@($coldRun.Lines)
  $cold|ForEach-Object {Write-Host "NX_CUSTODY_COLD $_"}
  $controlRun=Invoke-CustodyFixture '--fixture'
  $exit=$controlRun.Exit
  $output=@($controlRun.Lines)
  $output|ForEach-Object {Write-Host $_}
  if($coldExit -ne 0 -and $coldExit -ne 19){throw "COLD_FIXTURE_FAILED exit=$coldExit"}
  if($exit -ne 0){throw "NATIVE_FIXTURE_FAILED exit=$exit"}
  function Get-HandleDeltaSignature($lines,[string]$stage){
    $prefix='^NX_HANDLE_STAGE stage='+[regex]::Escape($stage)+' before=(\d+) after=(\d+) added=(\d+) removed=(\d+)$'
    $summary=@($lines|Where-Object {$_ -match $prefix})
    if($summary.Count -ne 1){throw "HANDLE_STAGE_MISSING $stage"}
    $m=[regex]::Match([string]$summary[0],$prefix)
    if(!$m.Success){throw "HANDLE_STAGE_INVALID $stage"}
    $added=[int]$m.Groups[3].Value;$removed=[int]$m.Groups[4].Value
    if(([int]$m.Groups[1].Value+$added-$removed) -ne [int]$m.Groups[2].Value){throw "HANDLE_STAGE_COUNT_INVALID $stage"}
    $entries=@($lines|ForEach-Object {
      if($_ -match ('^NX_HANDLE_DELTA stage='+[regex]::Escape($stage)+' op=(add|remove) type=(.+) access=([0-9a-f]+) attrs=([0-9a-f]+) value=')){
        "$($Matches[1])|$($Matches[2])|$($Matches[3])|$($Matches[4])"
      }
    }|Sort-Object)
    if(@($entries|Where-Object {$_ -like 'add|*'}).Count -ne $added -or
       @($entries|Where-Object {$_ -like 'remove|*'}).Count -ne $removed){throw "HANDLE_STAGE_DELTA_INCOMPLETE $stage"}
    $entries
  }
  function Assert-SameHandleDelta($left,$right,[string]$label){
    $a=@($left);$b=@($right)
    if($a.Count -ne $b.Count -or ($a -join "`n") -cne ($b -join "`n") -or
       @($a|Where-Object {$_ -like 'remove|*'}).Count -ne 0){
      throw "HANDLE_ATTRIBUTION_MISMATCH $label"
    }
  }
  # Require exact type/access/attribute multisets at the actual cold SHA and RNG
  # calls, plus the final table delta. No arbitrary count tolerance or type allowlist.
  Assert-SameHandleDelta @(Get-HandleDeltaSignature $cold 'wrong_digest_first') @(Get-HandleDeltaSignature $output 'control_sha') 'sha'
  Assert-SameHandleDelta @(Get-HandleDeltaSignature $cold 'ipc_rng') @(Get-HandleDeltaSignature $output 'control_rng') 'rng'
  Assert-SameHandleDelta @(Get-HandleDeltaSignature $cold 'cold_final') @(Get-HandleDeltaSignature $output 'control_final') 'final'
  $coldDelta=@(Get-HandleDeltaSignature $cold 'cold_final')
  if(($coldExit -eq 19) -ne ($coldDelta.Count -gt 0)){throw 'COLD_EXIT_DELTA_MISMATCH'}
  Write-Host "NX_CUSTODY_HANDLE_ATTRIBUTION=PASS independent_cng_delta=$($coldDelta.Count) product_residual=0"
  $expected=@('wrong_digest_denied','hardlink_denied','held_sha256_fileid_recheck','held_file_write_delete_ancestor_denied',
    'nonexecuted_image_mapping_path_matches','held_handles_released','anonymous_noninherited_endpoints',
    'explicit_handle_allowlist_excludes_inheritable_canary','held_peer_pid_filetime_nonce','wrong_peer_incarnation_denied',
    'exited_peer_denied','monotonic_initial_future_zero','monotonic_expiry_no_renewal','exact_handle_count_restored')
  $actual=@($output|Where-Object {$_ -match '^NX_CUSTODY_PASS '}|ForEach-Object {$_.Substring(16)})
  if($actual.Count -ne $expected.Count -or (Compare-Object $expected $actual)){throw 'NATIVE_CASE_INVENTORY_MISMATCH'}
  if(@($output|Where-Object {$_ -ceq 'NX_CUSTODY_RESULT pass=14 fail=0 production_authorized=false'}).Count -ne 1){throw 'NATIVE_RESULT_MISMATCH'}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $digest){throw 'HELD_FILE_CHANGED'}
  Write-Host "NX_CUSTODY_RECEIPT exact=$sha cases=14 native_build=PASS production_authorized=false"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop
  if(Test-Path -LiteralPath $work){throw 'FIXTURE_CLEANUP_FAILED'}
  Write-Host 'NX_CUSTODY_TEMP_CLEANUP=PASS'
}
