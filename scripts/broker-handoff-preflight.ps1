#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only Nexowire Broker handoff gate. Does NOT perform a handoff.
.DESCRIPTION
  Inspects the current loopback listeners, supervised legacy package, protected
  task metadata and staged release hashes. No task/process or secret is changed.
  This command NEVER authorizes a privileged cutover on its own.
#>
[CmdletBinding()]
param(
  [ValidateRange(1,65535)][int]$BrokerPort = 43112,
  [ValidateRange(1,65535)][int]$HubPort = 43110,
  [ValidateNotNullOrEmpty()][string]$TaskName = 'Nexowire Privileged Broker',
  [ValidateNotNullOrEmpty()][string]$StackRoot = 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire',
  [string]$StackSupervisor = "$env:LOCALAPPDATA\NexowireStack\run-stack.ps1",
  [string]$Staging = "$env:USERPROFILE\NexowireWork\broker-stage-v105-20261008"
)
$ErrorActionPreference = 'Stop'
function Get-Listener([int]$Port) {
  try {
    $matches = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' })
    if ($matches.Count -eq 1) { return [int]$matches[0].OwningProcess }
  } catch { }
  return $null
}
function Get-RouteCode([int]$Port) {
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create("http://127.0.0.1:$Port/health")
    $request.Method = 'GET'
    $request.Timeout = 4000
    $request.Proxy = $null
    $response = $request.GetResponse()
    return [int]$response.StatusCode
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $response = $_.Exception.Response
      return [int]$response.StatusCode
    }
    return $null
  } catch { return $null }
  finally { if ($response) { $response.Close() } }
}
function Get-VerifiedRelease([string]$FileName,[string]$SumsName) {
  $file = Join-Path $Staging $FileName
  $sums = Join-Path $Staging $SumsName
  if (!(Test-Path -LiteralPath $file -PathType Leaf) -or !(Test-Path -LiteralPath $sums -PathType Leaf)) { return $false }
  try {
    $expectedLine = @(Get-Content -LiteralPath $sums | Where-Object {
      $_ -match ('^[0-9a-fA-F]{64}\s+\*?' + [regex]::Escape($FileName) + '\s*$')
    })
    if ($expectedLine.Count -ne 1) { return $false }
    $expected = ($expectedLine[0] -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    return $actual -eq $expected
  } catch { return $false }
}
$brokerPid = Get-Listener $BrokerPort
$hubPid = Get-Listener $HubPort
$brokerIsExpectedProcess = $false
$brokerParentPid = $null
if ($null -ne $brokerPid) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$brokerPid" -ErrorAction Stop
    if ($process) {
      $brokerParentPid = [int]$process.ParentProcessId
      $brokerIsExpectedProcess =
        $process.Name -eq 'node.exe' -and
        [bool]($process.CommandLine -match '(?i)privileged-broker\s+run')
    }
  } catch { }
}
$stackVersion = $null
$stackHasHealth = $null
try {
  $manifest = Join-Path $StackRoot 'package.json'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) {
    $stackVersion = [string](Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
  }
  $brokerCode = Join-Path $StackRoot 'dist\src\agent\privileged-broker.js'
  if (Test-Path -LiteralPath $brokerCode -PathType Leaf) {
    $stackHasHealth = [bool](Select-String -LiteralPath $brokerCode -SimpleMatch -Pattern "'/health'" -Quiet)
  }
} catch { }
$supervisorGuard = $null
if (Test-Path -LiteralPath $StackSupervisor -PathType Leaf) {
  try {
    $guard = Get-Content -LiteralPath $StackSupervisor -Encoding UTF8
    $supervisorGuard = [bool]($guard | Where-Object {
      $_ -match 'Get-ScheduledTask\s+-TaskName' -and
      $_ -match [regex]::Escape($TaskName) -and
      $_ -match 'Test-Port' -and $_ -match [string]$BrokerPort
    })
  } catch { }
}
$taskFound = $false
$taskState = $null
$taskLastResult = $null
$taskHighest = $false
$taskLauncherHashReadable = $false
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $taskFound = $true
  $taskState = [string]$task.State
  $taskHighest = [string]$task.Principal.RunLevel -eq 'Highest'
  try {
    $taskLastResult = [int](Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop).LastTaskResult
  } catch { }
  # Only metadata. No launcher contents, protected secrets or arguments returned.
  $argsText = [string]$task.Actions[0].Arguments
  if ($argsText -match '(?i)-File\s+"([^"]+\.ps1)"') {
    try { $null = Get-FileHash -LiteralPath $Matches[1] -Algorithm SHA256 -ErrorAction Stop; $taskLauncherHashReadable = $true }
    catch { }
  }
} catch { }

$archiveOK = Get-VerifiedRelease 'nexowire-1.0.5.tgz' 'SHA256SUMS'
$windowsBundleOK = Get-VerifiedRelease 'Nexowire-Windows-x64.zip' 'SHA256SUMS-Windows'
$stagedVersion = $null
$stagedHealthRoute = $false
try {
  $stageManifest = Join-Path $Staging 'package\package.json'
  $stageBroker = Join-Path $Staging 'package\dist\src\agent\privileged-broker.js'
  if ((Test-Path -LiteralPath $stageManifest -PathType Leaf) -and
      (Test-Path -LiteralPath $stageBroker -PathType Leaf)) {
    $stagedVersion = [string](Get-Content -LiteralPath $stageManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $stagedHealthRoute = [bool](Select-String -LiteralPath $stageBroker -SimpleMatch -Pattern "'/health'" -Quiet)
  }
} catch { }
$httpStatus = Get-RouteCode $BrokerPort
$report = [ordered]@{
  schemaVersion = 1
  observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  device = $env:COMPUTERNAME
  brokerPort = $BrokerPort
  brokerPid = $brokerPid
  brokerParentPid = $brokerParentPid
  brokerCommandLooksExpected = $brokerIsExpectedProcess
  hubPid = $hubPid
  distinctHubAndBrokerPids = $null -ne $hubPid -and $null -ne $brokerPid -and $hubPid -ne $brokerPid
  unauthenticatedHealthStatus = $httpStatus
  legacyStackVersion = $stackVersion
  legacyStackHasHealthRoute = $stackHasHealth
  legacySupervisorWillAvoidRespawnWhenTaskPresent = $supervisorGuard
  brokerTaskExists = $taskFound
  brokerTaskState = $taskState
  brokerTaskHighest = $taskHighest
  brokerTaskLastResult = $taskLastResult
  brokerTaskLauncherHashReadable = $taskLauncherHashReadable
  stagedArchiveChecksumMatches = $archiveOK
  stagedWindowsBundleChecksumMatches = $windowsBundleOK
  stagedPackageVersion = $stagedVersion
  stagedCodeHasHealthRoute = $stagedHealthRoute
  safeToChangeProcesses = $false
  blocker = 'AUTHENTICATED_ELEVATED_TASK_AND_ROLLBACK_NOT_YET_VERIFIED'
  actionsPerformed = 'READ_ONLY'
}
$report | ConvertTo-Json -Depth 4 -Compress
