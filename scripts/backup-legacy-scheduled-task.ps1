#Requires -Version 5.1
<#
.SYNOPSIS
 Create and verify an encrypted, CURRENT-USER-only backup of one Windows Scheduled Task.
.DESCRIPTION
 Never exports plaintext XML to disk or console. This is recovery evidence, not
 an elevated restore or authorization to replace a running task.
#>
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Backup','Verify')][string]$Mode='Inspect',
 [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,126}$')][string]$TaskName='Nexowire Stack',
 [string]$BackupFile
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$entropy=[Text.Encoding]::UTF8.GetBytes('Nexowire.LegacyTask.Recovery.CurrentUser.v1')
$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
$local=$env:LOCALAPPDATA
if(!$local -or -not [IO.Path]::IsPathRooted($local)){throw 'RECOVERY_LOCALAPPDATA_REQUIRED'}
$root=Join-Path (Join-Path $local 'Nexowire') 'recovery'
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@{
 'S-1-5-18'=$true
 'S-1-5-32-544'=$true
 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true
}
$trusted[$me]=$true
$rights=[Security.AccessControl.FileSystemRights]
$writeMask=([int]$rights::WriteData -bor [int]$rights::AppendData -bor
 [int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor
 [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership)
function Check-SafePath([string]$p){
 $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'RECOVERY_REPARSE_POINT'}
 $acl=Get-Acl -LiteralPath $p -ErrorAction Stop
 if(-not $trusted.ContainsKey($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)){
  throw 'RECOVERY_OWNER_UNTRUSTED'
 }
 foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
   ([int]$ace.FileSystemRights -band $writeMask) -ne 0 -and
   -not $trusted.ContainsKey($ace.IdentityReference.Value)){
   throw 'RECOVERY_UNTRUSTED_WRITE_GRANT'
  }
 }
}
function Check-Root(){
 $base=Join-Path $local 'Nexowire'
 if(-not (Test-Path -LiteralPath $base -PathType Container)){throw 'NEXOWIRE_LOCAL_ROOT_NOT_PRESENT'}
 Check-SafePath $local
 Check-SafePath $base
 if(Test-Path -LiteralPath $root){Check-SafePath $root}
}
function Digest([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
 finally{$sha.Dispose()}
}
function Read-Task(){
 $task=Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
 if(-not $task -or @($task.Actions).Count -eq 0){throw 'RECOVERY_TASK_INVALID'}
 return $task
}
function Current-Task-Xml(){
 $xml=[string](Export-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop)
 if($xml.Length -lt 30 -or $xml.Length -gt 2MB){throw 'RECOVERY_XML_LENGTH_INVALID'}
 [xml]$parsed=$xml
 if(-not $parsed.Task -or -not $parsed.Task.Actions){throw 'RECOVERY_XML_INVALID'}
 return $xml
}
function WriteNew([string]$file,[byte[]]$bytes){
 $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}
 finally{$stream.Dispose()}
}
function ReadBackup([string]$file){
 if(-not (Test-Path -LiteralPath $root -PathType Container)){throw 'RECOVERY_BACKUP_NOT_FOUND'}
 Check-Root
 $name=[IO.Path]::GetFileName($file)
 if($name -ne $file -or $name -notmatch '^legacy-stack-task-[a-zA-Z0-9-]+\.dpapi$'){throw 'RECOVERY_BACKUP_NAME_INVALID'}
 $blob=Join-Path $root $name
 if(-not (Test-Path -LiteralPath $blob -PathType Leaf)){throw 'RECOVERY_BACKUP_NOT_FOUND'}
 Check-SafePath $blob
 $manifestFile=$blob+'.json'
 Check-SafePath $manifestFile
 $metadata=(Get-Content -LiteralPath $manifestFile -Raw -ErrorAction Stop |ConvertFrom-Json -ErrorAction Stop)
 $cipher=[IO.File]::ReadAllBytes($blob)
 if($cipher.Length -lt 60 -or $cipher.Length -gt 3MB -or (Digest $cipher) -ne $metadata.encryptedSha256){throw 'RECOVERY_CIPHERTEXT_INTEGRITY_FAILURE'}
 $plain=$null
 try{
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,$scope)
  if((Digest $plain) -ne $metadata.sourceXmlSha256){throw 'RECOVERY_XML_INTEGRITY_FAILURE'}
  $xmlText=[Text.Encoding]::UTF8.GetString($plain)
  [xml]$parsed=$xmlText
  if(-not $parsed.Task -or -not $parsed.Task.Actions){throw 'RECOVERY_XML_INVALID'}
 }finally{
  if($plain){[array]::Clear($plain,0,$plain.Length)}
  [array]::Clear($cipher,0,$cipher.Length)
 }
 return [pscustomobject]@{mode='VERIFY';taskName=[string]$metadata.taskName;backupFile=$name;ciphertextIntegrityVerified=$true;dpapiCurrentUserRoundtrip=$true;taskRestored=$false;safeToCutover=$false;plaintextWrittenToDisk=$false}
}
if($Mode -eq 'Inspect'){
 $task=Read-Task
 [pscustomobject]@{mode='INSPECT';taskName=$TaskName;state=[string]$task.State;runLevel=[string]$task.Principal.RunLevel;taskDefinitionObserved=$true;taskRestored=$false;safeToCutover=$false;secretUnsealPerformed=$false}|ConvertTo-Json -Compress
 exit 0
}
if($Mode -eq 'Verify'){
 if(!$BackupFile){throw 'RECOVERY_BACKUP_FILE_REQUIRED'}
 ReadBackup $BackupFile|ConvertTo-Json -Compress
 exit 0
}
if($BackupFile){throw 'RECOVERY_BACKUP_FILE_NOT_ALLOWED_IN_BACKUP_MODE'}
Check-Root
$task=Read-Task
$taskXml=Current-Task-Xml
$plain=[Text.Encoding]::UTF8.GetBytes($taskXml)
try{
 $plainHash=Digest $plain
 $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,$scope)
 $recovered=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,$scope)
 try{if((Digest $recovered) -ne $plainHash){throw 'RECOVERY_DPAPI_ROUNDTRIP_FAILURE'}}
 finally{[array]::Clear($recovered,0,$recovered.Length)}
}finally{[array]::Clear($plain,0,$plain.Length)}
if(-not (Test-Path -LiteralPath $root -PathType Container)){
 New-Item -ItemType Directory -Path $root -ErrorAction Stop|Out-Null
}
Check-Root
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
$name='legacy-stack-task-'+$stamp+'-'+[Guid]::NewGuid().ToString('N')+'.dpapi'
$file=Join-Path $root $name
$manifest=[ordered]@{
 schemaVersion=1;taskName=$TaskName;taskPath='\'
 createdUtc=[DateTime]::UtcNow.ToString('o')
 encryption='windows-dpapi-current-user';purpose='Nexowire.LegacyTask.Recovery.CurrentUser.v1'
 sourceXmlSha256=$plainHash;encryptedSha256=(Digest $cipher)
 encryptedBytes=$cipher.Length
 ownerApprovedRestore=$false;taskRestored=$false
 safeToCutover=$false;plaintextWrittenToDisk=$false
}
try{
 WriteNew $file $cipher
 Check-SafePath $file
 $manifestBytes=[Text.Encoding]::UTF8.GetBytes(($manifest|ConvertTo-Json -Compress))
 try{WriteNew ($file+'.json') $manifestBytes}
 finally{[array]::Clear($manifestBytes,0,$manifestBytes.Length)}
 Check-SafePath ($file+'.json')
 $checked=ReadBackup $name
 if(-not $checked.dpapiCurrentUserRoundtrip){throw 'RECOVERY_VERIFY_FAILED'}
}catch{
 # Remove only files just created by this invocation, never existing backups.
 Remove-Item -LiteralPath ($file+'.json') -Force -ErrorAction SilentlyContinue
 Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
 throw
}finally{[array]::Clear($cipher,0,$cipher.Length)}
[pscustomobject]@{
 mode='BACKUP';taskName=$TaskName;backupFile=$name
 encryptedBytes=$manifest.encryptedBytes
 ciphertextIntegrityVerified=$true;dpapiCurrentUserRoundtrip=$true
 secretUnsealPerformed=$false;taskRestored=$false;safeToCutover=$false
 plaintextWrittenToDisk=$false
}|ConvertTo-Json -Compress
