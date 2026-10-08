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
try {
  $task = Get-ScheduledTask -TaskName 'Nexowire Privileged Broker' -ErrorAction Stop
  $taskState = [string]$task.State
  try {
    $taskInfo = Get-ScheduledTaskInfo -TaskName 'Nexowire Privileged Broker' -ErrorAction Stop
    $taskLastResult = [int]$taskInfo.LastTaskResult
  } catch { }
} catch { }

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
  brokerTaskLastResult = $taskLastResult
  classification = $classification
  privilegedHealthVerified = $false
  nextStep = 'Only a separately authorized Broker probe with its protected token can verify reachable/elevated/version. Do not kill Hub, Agent or durable workers. Stage a verified Broker and use an approved isolated port handoff.'
}
$report | ConvertTo-Json -Depth 3 -Compress
