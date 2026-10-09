#Requires -Version 5.1
<#
.SYNOPSIS
  Rehearse DPAPI CurrentUser + Task Scheduler restoration using ONLY a new,
  disabled, triggerless fixture in the invoking user's task namespace.
.DESCRIPTION
  Never reads/mutates any existing Nexowire task, production task XML,
  credential, launcher, ACL, Agent, Hub or Broker.
  This does NOT prove elevated SYSTEM task or live secret restoration.
#>
[CmdletBinding()]
param()
if($args.Count -ne 0){throw 'FIXTURE_RESTORE_UNEXPECTED_ARGUMENTS'}
$ErrorActionPreference='Stop'
# Do not let caller-supplied PSModulePath select executable task modules.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1' -ErrorAction Stop
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows){
 throw 'FIXTURE_RESTORE_WINDOWS_REQUIRED'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]$identity
if($identity.User.Value -eq 'S-1-5-18' -or
   $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'FIXTURE_RESTORE_UNELEVATED_USER_REQUIRED'
}
$taskName='Nexowire-P0-Restore-Fixture-'+[Guid]::NewGuid().ToString('N')
if($taskName -cnotmatch '^Nexowire-P0-Restore-Fixture-[0-9a-f]{32}$'){
 throw 'FIXTURE_RESTORE_INVALID_NAME'
}
$taskPath='\'
$entropy=[Text.Encoding]::UTF8.GetBytes('Nexowire.P0.DisabledTask.CurrentUserDPAPI.v1')
$plain=$null;$cipher=$null;$unsealed=$null
$creationAttempted=$false;$restored=$false;$cleanupComplete=$false
$metadataVerified=$false;$exportedDigest=$null
$failure=$null;$phase='INITIAL'
function Digest([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
 finally{$sha.Dispose()}
}
function Validate-Fixture([object]$task,[string]$expectedName){
 if(!$task -or $task.TaskName -cne $expectedName){throw 'FIXTURE_TASK_ID_MISMATCH'}
 if($task.TaskPath -cne '\'){throw 'FIXTURE_TASK_PATH_MISMATCH'}
 if(@($task.Triggers|Where-Object {$null -ne $_}).Count -ne 0){throw 'FIXTURE_UNEXPECTED_TRIGGER'}
 if(@($task.Actions).Count -ne 1){throw 'FIXTURE_UNEXPECTED_ACTION'}
 if([string]$task.Actions[0].Execute -cne 'C:\Windows\System32\cmd.exe' -or
    [string]$task.Actions[0].Arguments -cne '/c exit 0'){
  throw 'FIXTURE_ACTION_CHANGED'
 }
 if([bool]$task.Settings.Enabled){throw 'FIXTURE_MUST_STAY_DISABLED'}
 if([string]$task.Principal.RunLevel -notin @('Limited','LeastPrivilege')){
  throw 'FIXTURE_PRIVILEGED_PRINCIPAL'
 }
 $observedPrincipal=[string]$task.Principal.UserId
 if([string]::IsNullOrWhiteSpace($observedPrincipal) -or
    $observedPrincipal -match '^(S-1-5-18|SYSTEM|NT AUTHORITY\\SYSTEM)$'){
  throw 'FIXTURE_UNEXPECTED_USER'
 }
 if([string]$task.Principal.LogonType -notin @('Interactive','InteractiveToken')){
  throw 'FIXTURE_UNEXPECTED_LOGON_TYPE'
 }
}
try{
 $prior=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
 if($prior){throw 'FIXTURE_NAME_COLLISION'}
 $phase='CREATE_FIXTURE'
 $action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument '/c exit 0'
 $settings=New-ScheduledTaskSettingsSet -Disable -Hidden
 $taskPrincipal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
 $creationAttempted=$true
 $phase='REGISTER_FIXTURE'
 Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Settings $settings -Principal $taskPrincipal -ErrorAction Stop|Out-Null
 $phase='VALIDATE_INITIAL'
 $initial=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
 Validate-Fixture $initial $taskName
 $expectedPrincipal=[string]$initial.Principal.UserId
 $phase='EXPORT_FIXTURE'
 $xml=[string](Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
 if($xml.Length -lt 80 -or $xml.Length -gt 1024KB){throw 'FIXTURE_XML_SIZE_INVALID'}
 [xml]$parsed=$xml
 if(!$parsed.Task -or !$parsed.Task.Actions -or $parsed.Task.Settings.Enabled -ne 'false'){
  throw 'FIXTURE_XML_NOT_DISABLED'
 }
 # Keep task XML, encrypted backup and restored XML only in process memory.
 # No BackupFile parameter and no plaintext XML written to the filesystem.
 $phase='DPAPI_ROUNDTRIP'
 Add-Type -AssemblyName System.Security
 $plain=[Text.Encoding]::UTF8.GetBytes($xml)
 $exportedDigest=Digest $plain
 $cipher=[Security.Cryptography.ProtectedData]::Protect(
  $plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $unsealed=[Security.Cryptography.ProtectedData]::Unprotect(
  $cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 if((Digest $unsealed) -cne $exportedDigest){throw 'FIXTURE_DPAPI_DIGEST_MISMATCH'}
 $restoredXml=[Text.Encoding]::UTF8.GetString($unsealed)
 [xml]$verifiedXml=$restoredXml
 if(!$verifiedXml.Task -or !$verifiedXml.Task.Actions -or
    $verifiedXml.Task.Settings.Enabled -ne 'false'){
  throw 'FIXTURE_RESTORED_XML_INVALID'
 }
 $metadataVerified=$true
 # The unique fixture is deliberately unregistered and restored in place.
 # Never invoke the task, and never change an existing production task.
 $phase='UNREGISTER_FIXTURE'
 Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
 $phase='RESTORE_FIXTURE'
 Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $restoredXml -ErrorAction Stop|Out-Null
 $phase='VALIDATE_RESTORED'
 $after=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
 Validate-Fixture $after $taskName
 if([string]$after.Principal.UserId -ine $expectedPrincipal){throw 'FIXTURE_USER_CHANGED'}
 $restored=$true
}catch{
 $reason=if($_.Exception.Message -cmatch '^FIXTURE_[A-Z_]+$'){$_.Exception.Message}else{'UNKNOWN_ERROR'}
 $failure='FIXTURE_RESTORE_REHEARSAL_FAILED_'+$phase+'_'+$reason
}finally{
 # Cleanup regardless of success/failure; only the unpredictable fixture name
 # created by this exact invocation can be targeted.
 try{
  if($creationAttempted){
   $remaining=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
   if($remaining){
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
   }
  }
  $cleanupComplete=(-not (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue))
 }catch{$failure='FIXTURE_RESTORE_CLEANUP_FAILED'}
 foreach($bytes in @($plain,$cipher,$unsealed)){
  if($null -ne $bytes){[array]::Clear($bytes,0,$bytes.Length)}
 }
}
if($failure -or -not $restored -or -not $metadataVerified -or -not $cleanupComplete){
 throw $(if($failure){$failure}else{'FIXTURE_RESTORE_UNVERIFIED'})
}
[pscustomobject]@{
 schemaVersion=1;mode='ISOLATED_DISABLED_TASK_FIXTURE'
 dpapiCurrentUserRoundtrip=$true;taskSchedulerXmlRestored=$true
 fixtureDisabled=$true;fixtureHadNoTriggers=$true
 fixtureRemovedAfterTest=$true;fixtureTaskExecuted=$false
 restoredRealStack=$false;protectedCredentialsRestored=$false
 productionTaskChanged=$false;productionFilesChanged=$false
 authorizedToElevate=$false;safeToCutover=$false
}|ConvertTo-Json -Compress
