#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only health and version compatibility preflight for the Nexowire Windows Broker.
.DESCRIPTION
  Does not read bearer tokens, access protected launcher contents, start or stop
  tasks, restart services, or attempt elevation. HTTP probes are unauthenticated
  and restricted to 127.0.0.1. A 401 indicates route compatibility, NOT elevation.
#>
[CmdletBinding()]
param(
  [ValidateRange(1,65535)][int]$Port = 43112,
  [ValidateNotNullOrEmpty()][string]$StackPackageRoot = 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire'
)
$ErrorActionPreference = 'Stop'

function Get-LocalHttpStatus([string]$Path) {
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create(
      ('http://127.0.0.1:{0}{1}' -f $Port, $Path)
    )
    $request.Method = 'GET'
    $request.Timeout = 4000
    $request.ReadWriteTimeout = 4000
    $request.Proxy = $null
    $response = $request.GetResponse()
    return [int]$response.StatusCode
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $response = $_.Exception.Response
      return [int]$response.StatusCode
    }
    return $null
  } catch {
    return $null
  } finally {
    if ($response) { $response.Close() }
  }
}

$stackRoot = $StackPackageRoot
$manifest = Join-Path $stackRoot 'package.json'
$brokerFile = Join-Path $stackRoot 'dist\src\agent\privileged-broker.js'
$stackVersion = $null
$stackHasHealth = $null
if (Test-Path -LiteralPath $manifest) {
  try { $stackVersion = [string](Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version }
  catch { $stackVersion = $null }
}
if (Test-Path -LiteralPath $brokerFile) {
  try { $stackHasHealth = [bool](Select-String -LiteralPath $brokerFile -SimpleMatch -Pattern "'/health'" -Quiet) }
  catch { $stackHasHealth = $null }
}

$listenerPid = $null
$listenerName = $null
try {
  $listener = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' }) |
    Select-Object -First 1
  if ($listener) {
    $listenerPid = [int]$listener.OwningProcess
    try { $listenerName = [string](Get-Process -Id $listenerPid -ErrorAction Stop).ProcessName }
    catch { $listenerName = $null }
  }
} catch { }

$taskState = $null
$taskLastResult = $null
$taskMultipleInstances = $null
try {
  $task = Get-ScheduledTask -TaskName 'Nexowire Privileged Broker' -ErrorAction Stop
  $taskState = [string]$task.State
  if ($null -ne $task.Settings -and $null -ne $task.Settings.MultipleInstances) {
    $taskMultipleInstances = [string]$task.Settings.MultipleInstances
  }
  try {
    $taskInfo = Get-ScheduledTaskInfo -TaskName 'Nexowire Privileged Broker' -ErrorAction Stop
    # Windows ScheduledTasks exposes LastTaskResult as UInt32. HRESULT
    # 0x800710E0 is above Int32.MaxValue: [int] throws and our compatibility
    # report silently loses the result. Keep the complete unsigned value.
    if ($null -ne $taskInfo.LastTaskResult) {
      $taskLastResult = [long]$taskInfo.LastTaskResult
    }
  } catch { }
} catch { }

# Task Scheduler may reject a duplicate start of an already-running IgnoreNew
# singleton (0x800710E0). This is ONLY a possible task-result explanation;
# it does not prove Broker authentication, elevation, or effect admission.
$taskResultClassification = 'TASK_FAILURE_OR_UNVERIFIED'
if ($null -eq $taskLastResult) {
  $taskResultClassification = 'NO_LAST_RESULT'
} elseif ($taskLastResult -eq 0) {
  $taskResultClassification = 'SUCCESS'
} elseif ($taskLastResult -eq 2147946720 -and
          $taskState -eq 'Running' -and $taskMultipleInstances -eq 'IgnoreNew') {
  $taskResultClassification = 'POSSIBLE_IGNORE_NEW'
}

$healthStatus = Get-LocalHttpStatus '/health'
$executeStatus = Get-LocalHttpStatus '/execute'

$classification = 'UNVERIFIED'
if ($null -eq $listenerPid) {
  $classification = 'NO_LOOPBACK_LISTENER'
} elseif ($healthStatus -eq 401) {
  $classification = 'ROUTE_COMPATIBLE_AUTH_REQUIRED'
} elseif ($healthStatus -eq 404 -and $executeStatus -eq 404 -and $stackHasHealth -eq $false) {
  $classification = 'LEGACY_STACK_BROKER_INCOMPATIBLE'
} elseif ($healthStatus -eq 404) {
  $classification = 'HEALTH_ENDPOINT_MISSING'
}

$report = [ordered]@{
  schemaVersion = 1
  observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  device = $env:COMPUTERNAME
  loopbackPort = $Port
  listenerPid = $listenerPid
  listenerName = $listenerName
  unauthenticatedHealthStatus = $healthStatus
  unauthenticatedExecuteStatus = $executeStatus
  stackPackageVersion = $stackVersion
  stackCodeHasHealthRoute = $stackHasHealth
  brokerTaskState = $taskState
  brokerTaskMultipleInstances = $taskMultipleInstances
  brokerTaskLastResult = $taskLastResult
  brokerTaskLastResultClassification = $taskResultClassification
  classification = $classification
  privilegedHealthVerified = $false
  nextStep = 'Only a separately authorized Broker probe with its protected token can verify reachable/elevated/version. Do not kill Hub, Agent or durable workers. Stage a verified Broker and use an approved isolated port handoff.'
}
$report | ConvertTo-Json -Depth 3 -Compress
