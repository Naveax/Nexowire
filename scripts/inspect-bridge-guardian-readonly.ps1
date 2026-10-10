# Read-only diagnostic for a future independently installed Bridge Guardian.
# Does not register, start, stop, disable, enable or change Windows tasks.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$module = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name $module -ErrorAction Stop

$name = 'Nexowire Bridge Guardian'
$root = 'C:\ProgramData\Nexowire\bridge-guardian'
$launcher = $root + '\launch.ps1'
$expectedExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '"'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Resolve-SidBounded {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $resolved = $null
  try {
    if ($Value -match '^S-1-[0-9-]+$') {
      $resolved = ([System.Security.Principal.SecurityIdentifier]::new($Value)).Value
    } else {
      $resolved = ([System.Security.Principal.NTAccount]::new($Value)).Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    }
  } catch {
    # Unexpected identity is never treated as matching the current user.
    return 'OTHER'
  }
  if ($resolved -eq $currentSid) { return $currentSid }
  return 'OTHER'
}

try {
  # Request only the known task name/path. Enumeration errors are NOT proof of absence.
  $matches = @(Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop)
} catch {
  [pscustomobject]@{
    auditOnly = $true
    privilegedOperationPerformed = $false
    installed = $false
    lookupVerified = $false
    status = 'UNVERIFIED'
    currentUserSid = $currentSid
    snapshot = $null
  } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

if ($matches.Count -ne 1) {
  [pscustomobject]@{
    auditOnly = $true
    privilegedOperationPerformed = $false
    installed = $false
    lookupVerified = ($matches.Count -eq 0)
    status = if ($matches.Count -eq 0) { 'ABSENT' } else { 'AMBIGUOUS' }
    currentUserSid = $currentSid
    snapshot = $null
  } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

$task = $matches[0]
$actions = @(
  foreach ($action in @($task.Actions)) {
    # Redact every unexpected string to avoid leaking secrets from a tampered task.
    $exe = if ([string]$action.Execute -ieq $expectedExe) { $expectedExe } else { 'NONCANONICAL' }
    $args = if ([string]$action.Arguments -ceq $expectedArgs) { $expectedArgs } else { 'NONCANONICAL' }
    $cwd = if ([string]$action.WorkingDirectory -ieq $root) { $root } else { 'NONCANONICAL' }
    [pscustomobject]@{
      execute = $exe
      arguments = $args
      workingDirectory = $cwd
    }
  }
)
$triggers = @(
  foreach ($trigger in @($task.Triggers)) {
    $className = [string]$trigger.CimClass.CimClassName
    $kind = if ($className -eq 'MSFT_TaskLogonTrigger') { 'Logon' }
      elseif ($className -eq 'MSFT_TaskTimeTrigger') { 'Time' }
      else { 'Other' }
    $sid = if ($kind -eq 'Logon') { Resolve-SidBounded ([string]$trigger.UserId) }
      else { $null }
    [pscustomobject]@{
      type = $kind
      userSid = $sid
      enabled = ($trigger.Enabled -eq $true)
    }
  }
)
$state = if ([string]$task.State -in @('Running','Ready','Disabled')) {
  [string]$task.State
} else { 'Unknown' }
$runLevel = if ([string]$task.Principal.RunLevel -eq 'Highest') { 'Highest' } else { 'Limited' }
$logonType = if ([string]$task.Principal.LogonType -eq 'Interactive') {
  'Interactive'
} elseif ([string]$task.Principal.LogonType -eq 'ServiceAccount') {
  'ServiceAccount'
} else { 'Password' }

[pscustomobject]@{
  auditOnly = $true
  privilegedOperationPerformed = $false
  installed = $true
  lookupVerified = $true
  status = 'SNAPSHOT_ONLY'
  currentUserSid = $currentSid
  snapshot = [pscustomobject]@{
    name = [string]$task.TaskName
    taskPath = [string]$task.TaskPath
    state = $state
    principal = [pscustomobject]@{
      userSid = Resolve-SidBounded ([string]$task.Principal.UserId)
      runLevel = $runLevel
      logonType = $logonType
    }
    actions = $actions
    triggers = $triggers
  }
} | ConvertTo-Json -Compress -Depth 8
