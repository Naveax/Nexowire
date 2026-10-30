/** User-runtime readiness only. This snapshot never grants CORE, enrollment,
 * Broker trust or authenticated Hub connectivity. The installed Agent must
 * report successful local initialization for this exact cutover and live PID. */
export function renderWindowsAgentStartupGuard(): string[] {
  return String.raw`
function Get-AgentStartupDiagnosticPath {
  $text=Get-Content -LiteralPath $AgentLauncher -Raw -ErrorAction Stop
  $pattern='(?m)^\$env:NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE=''((?:[^'']|'''')*)''\r?$'
  $assignments=[regex]::Matches($text,$pattern)
  if($assignments.Count -gt 1){throw 'UPDATE_AGENT_JOURNAL_CONFIG_AMBIGUOUS'}
  if($assignments.Count -eq 1){
    $journal=$assignments[0].Groups[1].Value.Replace("''", "'")
    if(-not [IO.Path]::IsPathRooted($journal)){throw 'UPDATE_AGENT_JOURNAL_CONFIG_NOT_ABSOLUTE'}
    return Join-Path ([IO.Path]::GetDirectoryName($journal)) 'native-agent\startup-diagnostic.json'
  }
  if($text -match '\$env:NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE\s*='){
    throw 'UPDATE_AGENT_JOURNAL_CONFIG_UNSUPPORTED'
  }
  return Join-Path (Split-Path -Parent $AgentLauncher) 'startup-diagnostic.json'
}
function Test-AgentStartupSnapshot($value,[int]$processId) {
  if($null -eq $value){return $false}
  foreach($name in @('automaticJournalRepair','activeConnectionVerified','coreAuthorityVerified','restartLoopDetected')){
    if($value.$name -isnot [bool] -or $value.$name){return $false}
  }
  return (($value.schemaVersion -is [int] -or $value.schemaVersion -is [long]) -and $value.schemaVersion -eq 1 -and
    ($value.processId -is [int] -or $value.processId -is [long]) -and $value.processId -eq $processId -and
    $value.version -ceq $TargetVersion -and $value.startupNonce -ceq $StartupNonce -and
    $value.phase -ceq 'local-state-ready' -and $null -eq $value.failureCode -and
    ($value.consecutiveFailures -is [int] -or $value.consecutiveFailures -is [long]) -and $value.consecutiveFailures -eq 0)
}
function Test-CandidateAgentProcess($candidate) {
  if($null -eq $candidate -or $null -eq $candidate.ExecutablePath){return $false}
  $expectedNode=Join-Path $NewRoot 'runtime\node.exe'
  if(-not [string]::Equals([string]$candidate.ExecutablePath,$expectedNode,[StringComparison]::OrdinalIgnoreCase)){return $false}
  $expectedCli=Join-Path $NewRoot 'app\dist\src\cli.js'
  $pattern='(?:^|\s)"?'+[regex]::Escape($expectedCli)+'"?\s+agent\s+run(?:\s|$)'
  return [regex]::IsMatch([string]$candidate.CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Read-AgentStartupSnapshot {
  if(-not (Test-Path -LiteralPath $AgentStartupDiagnostic -PathType Leaf)){return $null}
  $item=Get-Item -LiteralPath $AgentStartupDiagnostic -Force -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 4096){return $null}
  $stream=[IO.File]::Open($AgentStartupDiagnostic,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    $bytes=New-Object byte[] 4097
    $length=$stream.Read($bytes,0,$bytes.Length)
    if($length -gt 4096){return $null}
    return [Text.Encoding]::UTF8.GetString($bytes,0,$length) | ConvertFrom-Json -ErrorAction Stop
  } finally {$stream.Dispose()}
}
function Wait-Agent([int]$seconds) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  $previousPid=0
  while($timer.Elapsed.TotalSeconds -lt $seconds){
    try {
      $candidates=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 5 -ErrorAction Stop |
        Where-Object {Test-CandidateAgentProcess $_})
      $snapshot=Read-AgentStartupSnapshot
      if($candidates.Count -eq 1 -and (Test-AgentStartupSnapshot $snapshot ([int]$candidates[0].ProcessId))){
        $candidatePid=[int]$candidates[0].ProcessId
        if($previousPid -eq $candidatePid){return $true}
        $previousPid=$candidatePid
      } else {$previousPid=0}
    } catch {$previousPid=0}
    Start-Sleep -Milliseconds 500
  }
  return $false
}`.trim().split('\n');
}
