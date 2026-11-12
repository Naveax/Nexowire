# AI-06, Windows-only, READ-ONLY Hub SQLite rollback/cutover preflight.
# This script never installs, starts, stops, upgrades or removes a Hub or Task.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$StateDir,
  [Parameter(Mandatory=$true)][ValidateSet('sqlite','json-only')][string]$TargetReader,
  [string]$ExpectedOwnerSid,
  [switch]$AllowFirstMigration,
  [string]$ExpectedLegacySha256,
  [switch]$RequireTaskAbsent
)
$ErrorActionPreference='Stop'
# An inaccessible task is not a missing task. The cutover preflight must
# establish absence with an independent Windows Scheduler COM not-found.
function Assert-HubTaskAbsent([scriptblock]$TaskLookup,[scriptblock]$ComLookup) {
  $task=$null
  try {$task=& $TaskLookup} catch {$task=$null}
  if($null -ne $task) {
    throw 'IDEMPOTENCY_HUB_TASK_ALREADY_PRESENT'
  }
  $registered=$null
  $provenAbsent=$false
  try {$registered=& $ComLookup} catch {
    $e=$_.Exception
    while($null -ne $e.InnerException){$e=$e.InnerException}
    if([int]$e.HResult -eq -2147024894) {
      $provenAbsent=$true
    } else {
      throw 'IDEMPOTENCY_HUB_TASK_VISIBILITY_UNVERIFIED'
    }
  }
  if(-not $provenAbsent) {
    throw 'IDEMPOTENCY_HUB_TASK_STILL_REGISTERED_OR_HIDDEN'
  }
}
try {
  # Explicitly forbid JSON-only targets. Once an operation exists only in
  # SQLite, the legacy JSON reader can execute it a second time.
  if($TargetReader -eq 'json-only') {
    throw 'IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED: JSON-only Hub reader is forbidden.'
  }
  $full=[System.IO.Path]::GetFullPath($StateDir)
  if($full.StartsWith('\\')) {
    throw 'IDEMPOTENCY_REMOTE_STATE_DIR_DENIED: journal must be on local storage.'
  }
  if(!(Test-Path -LiteralPath $full -PathType Container)) {
    throw 'IDEMPOTENCY_STATE_DIR_MISSING: no implicit state directory creation.'
  }
  $state=Get-Item -LiteralPath $full -Force
  if(([int]$state.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'IDEMPOTENCY_REPARSE_STATE_DIR_DENIED'
  }
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  if($ExpectedOwnerSid -and $identity.User.Value -cne $ExpectedOwnerSid) {
    throw 'IDEMPOTENCY_OWNER_SID_MISMATCH'
  }
  # Reject unexpected write principals. Read-only inherited ACEs are permitted.
  $trusted=@($identity.User.Value,'S-1-5-18','S-1-5-32-544')
  # Do NOT OR with FullControl/Modify: their masks contain Read bits and
  # would incorrectly classify inherited read-only permissions as writers.
  $writeMask=[int][System.Security.AccessControl.FileSystemRights]::Write -bor
    [int][System.Security.AccessControl.FileSystemRights]::Delete -bor
    [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $acl=Get-Acl -LiteralPath $full
  foreach($entry in $acl.Access) {
    if($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if(([int]$entry.FileSystemRights -band $writeMask) -eq 0) { continue }
    try {
      $sid=$entry.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      throw 'IDEMPOTENCY_UNKNOWN_ACL_PRINCIPAL_DENIED'
    }
    if($trusted -notcontains $sid) {
      throw 'IDEMPOTENCY_UNTRUSTED_WRITER_ACL'
    }
  }
  if($RequireTaskAbsent) {
    Assert-HubTaskAbsent -TaskLookup {
      Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\' -ErrorAction Stop
    } -ComLookup {
      $service=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop
      $service.Connect()
      $folder=$service.GetFolder('\')
      $folder.GetTask('Nexowire Hub')
    }
  }
  $sqlite=Join-Path $full 'idempotency-records.sqlite'
  $legacy=Join-Path $full 'idempotency-records.json'
  $exists=Test-Path -LiteralPath $sqlite -PathType Leaf
  if($exists) {
    $stream=[System.IO.File]::Open($sqlite,
      [System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite)
    try {
      if($stream.Length -lt 16) {throw 'IDEMPOTENCY_SQLITE_HEADER_INVALID'}
      $header=New-Object byte[] 16
      [void]$stream.Read($header,0,16)
      $signature=[System.Text.Encoding]::ASCII.GetString($header,0,15)
      if($signature -cne 'SQLite format 3') {
        throw 'IDEMPOTENCY_SQLITE_HEADER_INVALID'
      }
    } finally { $stream.Dispose() }
  } else {
    if(!$AllowFirstMigration) {
      throw 'IDEMPOTENCY_SQLITE_MISSING: existing SQLite required for rollback.'
    }
    if(!$ExpectedLegacySha256 -or $ExpectedLegacySha256 -cnotmatch '^[a-fA-F0-9]{64}$') {
      throw 'IDEMPOTENCY_LEGACY_HASH_REQUIRED'
    }
    if(!(Test-Path -LiteralPath $legacy -PathType Leaf)) {
      throw 'IDEMPOTENCY_LEGACY_JOURNAL_MISSING'
    }
    $hash=(Get-FileHash -LiteralPath $legacy -Algorithm SHA256).Hash
    if($hash -cne $ExpectedLegacySha256.ToUpperInvariant()) {
      throw 'IDEMPOTENCY_LEGACY_HASH_MISMATCH'
    }
  }
  [pscustomobject]@{
    ok=$true
    reader='sqlite'
    sqliteExists=$exists
    firstMigration=(!$exists)
    readOnly=$true
    # Positive return means **preflight only**; full quick_check, owner/lease
    # and ACL/Task execution evidence remain separate release gates.
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 2
}
