# Diagnostic-only, non-mutating Windows Broker task/process/TCP inventory.
# Does NOT authorize any privileged action, attest protected source, or
# certify completed ON/OFF operations.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$taskName='Nexowire Privileged Broker'
$port=43112
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Write-BoundedReport {
  param(
    [string]$Status,
    [string]$TaskState='Unknown',
    [bool]$TaskLookupVerified=$false,
    [bool]$ProcessAuditComplete=$false,
    [bool]$PortAuditComplete=$false,
    [int]$BrokerCandidates=0,
    [int]$ListenerOwners=0
  )
  [pscustomobject]@{
    auditOnly=$true
    privilegedOperationPerformed=$false
    status=$Status
    taskName=$taskName
    taskState=$TaskState
    taskLookupVerified=$TaskLookupVerified
    localProcessAuditComplete=$ProcessAuditComplete
    localPortAuditComplete=$PortAuditComplete
    potentialBrokerProcessCount=$BrokerCandidates
    uniqueListenerOwnerCount=$ListenerOwners
    listenerPort=$port
    sourceAclVerified=$false
    taskActionVerified=$false
    brokerProcessImageAndOwnerVerified=$false
    guardianTransportVerified=$false
    remoteActuationAuthorized=$false
  } | ConvertTo-Json -Compress -Depth 4
}

# An unprivileged service account may not enumerate elevated Windows tasks,
# owner command lines or protected process paths reliably. Do not guess absence.
$admin=[Security.Principal.WindowsPrincipal]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-BoundedReport -Status 'UNVERIFIED'
  exit 0
}

try {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1' -ErrorAction Stop
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetTCPIP\NetTCPIP.psd1' -ErrorAction Stop
  $tasks=@(Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
  if($tasks.Count -ne 1) {
    Write-BoundedReport -Status 'UNVERIFIED'
    exit 0
  }
  $state=[string]$tasks[0].State
  if($state -notin @('Running','Ready','Disabled')) {$state='Unknown'}

  $connections=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
    [int]$_.LocalPort -eq $port
  })
  # Only a distinct owner count is exposed; no process list, token, path,
  # command line, environment, URL, or executable bytes leave this audit.
  $owners=@($connections | ForEach-Object {
    [int]$_.OwningProcess
  } | Sort-Object -Unique)
  $owners=@($owners | Where-Object {$_ -gt 0})

  $allProcesses=@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $candidateCount=0
  $unverifiable=$false
  foreach($proc in $allProcesses) {
    $name=[string]$proc.Name
    if ($name -notmatch '(?i)^(node|nexowire)(\.exe)?$') {continue}
    if ($null -eq $proc.CommandLine) {
      # Could be a protected elevated Broker. Never claim it is absent.
      $unverifiable=$true
      continue
    }
    $cmd=[string]$proc.CommandLine
    if ($cmd -match '(?i)privileged-broker[\x27\x22]?\s+[\x27\x22]?run([\x27\x22\s]|$)') {
      $candidateCount++
    }
  }

  if($unverifiable) {
    Write-BoundedReport -Status 'UNVERIFIED' -TaskState $state -TaskLookupVerified $true
    exit 0
  }

  # This report is NOT a trusted postcondition: it does not establish
  # executable integrity, per-process owner SID, or protected Guardian origin.
  Write-BoundedReport -Status 'SNAPSHOT_ONLY' -TaskState $state `
    -TaskLookupVerified $true -ProcessAuditComplete $true `
    -PortAuditComplete $true -BrokerCandidates $candidateCount `
    -ListenerOwners $owners.Count
} catch {
  Write-BoundedReport -Status 'UNVERIFIED'
}
