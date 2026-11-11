#Requires -Version 5.1
<#
.SYNOPSIS
  Explicitly authorized reconciliation of a legacy protected SYSTEM Hub task.
  Does not stop the interactive Hub, modify SQLite, or bypass UAC/CORE.
.DESCRIPTION
  Inspect is read-only. Backup snapshots the exact task XML, task security
  descriptor and old launcher tree into a protected ProgramData directory.
  Rehearse validates XML registration using a disposable DISABLED task.
  Retire is allowed only with a pinned receipt, rehearsed rollback, unchanged
  task/runtime, a healthy interactive Hub task, and staged Program Files code.
  Restore never overwrites an existing or hidden task.
#>
[CmdletBinding()]
param(
  [ValidateSet('Inspect','Backup','Verify','Rehearse','Retire','Restore')]
  [string]$Action='Inspect',
  [ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$BackupId='',
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedReceiptSha256='',
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedRuntimeTreeSha256='',
  [switch]$ApproveRetirement
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='Nexowire Hub Boot'
$userTaskName='Nexowire Hub'
$taskPath='\'
$legacyRoot='C:\ProgramData\Nexowire\hub-boot'
$launcher=Join-Path $legacyRoot 'launch.ps1'
$backupParent='C:\ProgramData\Nexowire\hub-boot-reconciliation'
$trustedRuntime='C:\Program Files\Nexowire\SystemHub'
$pwsh='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcher+'"'
$trustedSids=@('S-1-5-18','S-1-5-32-544')
$writeRights=[Security.AccessControl.FileSystemRights](
  [int][Security.AccessControl.FileSystemRights]::Write -bor
  [int][Security.AccessControl.FileSystemRights]::Modify -bor
  [int][Security.AccessControl.FileSystemRights]::FullControl -bor
  [int][Security.AccessControl.FileSystemRights]::Delete -bor
  [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [int][Security.AccessControl.FileSystemRights]::TakeOwnership
)

function Assert-Admin {
  $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'AI01_RECONCILE_ELEVATED_TOKEN_REQUIRED'
  }
}
function Resolve-Sid([System.Security.Principal.IdentityReference]$identity) {
  try { return $identity.Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { throw 'AI01_RECONCILE_UNRESOLVED_ACL_IDENTITY' }
}
function Assert-PlainPath([string]$p,[bool]$private=$false) {
  $obj=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(($obj.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'AI01_RECONCILE_REPARSE_PATH_DENIED'
  }
  if($private) {
    $acl=Get-Acl -LiteralPath $p -ErrorAction Stop
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedSids){throw 'AI01_RECONCILE_UNTRUSTED_OWNER'}
    foreach($rule in $acl.Access) {
      $sid=Resolve-Sid $rule.IdentityReference
      if($sid -notin $trustedSids -and
         $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
         (($rule.FileSystemRights -band $writeRights) -ne 0)){
        throw 'AI01_RECONCILE_UNTRUSTED_WRITE_ACL'
      }
    }
  }
  return $obj
}
function Assert-ToolTrusted {
  $expected=Join-Path $trustedRuntime 'scripts\Resolve-Nexowire-LegacySystemHubTask.ps1'
  $actual=[IO.Path]::GetFullPath($PSCommandPath)
  if([string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)){
    $null=Assert-PlainPath 'C:\Program Files'
    $null=Assert-PlainPath 'C:\Program Files\Nexowire' $true
    $null=Assert-PlainPath $trustedRuntime $true
    $null=Assert-PlainPath (Join-Path $trustedRuntime 'scripts') $true
    $null=Assert-PlainPath $PSCommandPath $true
    return
  }
  # Emergency restoration must remain possible when Program Files is damaged.
  # Only the receipt-pinned private backup copy can execute this path.
  if($Action -eq 'Restore' -and $BackupId){
    $backupRoot=Join-Path $backupParent $BackupId
    $expectedCopy=Join-Path $backupRoot 'Restore-Task.ps1'
    if([string]::Equals($actual,$expectedCopy,[StringComparison]::OrdinalIgnoreCase)){
      $null=Assert-PlainPath $backupParent $true
      $null=Assert-PlainPath $backupRoot $true
      $null=Assert-PlainPath $PSCommandPath $true
      return
    }
  }
  throw 'AI01_RECONCILE_TRUSTED_INSTALLED_TOOL_REQUIRED'
}
function Assert-PrivateAncestors {
  $null=Assert-PlainPath 'C:\'
  $null=Assert-PlainPath 'C:\ProgramData'
  $parent='C:\ProgramData\Nexowire'
  $null=Assert-PlainPath $parent $true
  if(-not (Get-Acl -LiteralPath $parent -ErrorAction Stop).AreAccessRulesProtected){
    throw 'AI01_RECONCILE_PARENT_INHERITED_ACL_UNVERIFIED'
  }
}
function Make-PrivateDirectory([string]$p) {
  if(Test-Path -LiteralPath $p){throw 'AI01_RECONCILE_BACKUP_ALREADY_EXISTS'}
  $null=New-Item -ItemType Directory -Path $p -ErrorAction Stop
  & 'C:\Windows\System32\icacls.exe' $p '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_BACKUP_ACL_FAILED'}
  & 'C:\Windows\System32\icacls.exe' $p '/setowner' '*S-1-5-32-544' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_BACKUP_OWNER_FAILED'}
  $null=Assert-PlainPath $p $true
}
function Hash([string]$p) {
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Get-TaskOrVisibility {
  try {
    $svc=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop
    $svc.Connect()
    $folder=$svc.GetFolder('\')
    $registered=$folder.GetTask($taskName)
    if($null -eq $registered){throw 'AI01_RECONCILE_TASK_VISIBILITY_UNVERIFIED'}
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    return [pscustomobject]@{Visibility='found';Task=$task;Registered=$registered}
  } catch {
    if([int]$_.Exception.HResult -eq -2147024894){
      return [pscustomobject]@{Visibility='not-installed';Task=$null;Registered=$null}
    }
    if([int]$_.Exception.HResult -eq -2147024891) {
      return [pscustomobject]@{Visibility='access-denied';Task=$null;Registered=$null}
    }
    throw
  }
}
function Assert-LegacyIdentity($found) {
  if($found.Visibility -ne 'found'){throw 'AI01_RECONCILE_TASK_IDENTITY_UNVERIFIED'}
  $t=$found.Task
  if([string]$t.TaskName -cne $taskName -or [string]$t.TaskPath -cne $taskPath){
    throw 'AI01_RECONCILE_FOREIGN_TASK_PATH'
  }
  $sid=[string]$t.Principal.UserId
  try {$sid=(New-Object Security.Principal.NTAccount($sid)).Translate([Security.Principal.SecurityIdentifier]).Value}catch {}
  $actions=@($t.Actions)
  if($sid -cne 'S-1-5-18' -or
     [string]$t.Principal.RunLevel -cne 'Highest' -or
     [string]$t.Principal.LogonType -cne 'ServiceAccount' -or
     $actions.Count -ne 1 -or
     ([string]$actions[0].Execute).Trim('"') -ine $pwsh -or
     [string]$actions[0].Arguments -cne $expectedArgs) {
    throw 'AI01_RECONCILE_FOREIGN_TASK_IDENTITY'
  }
  if(@($t.Triggers).Count -ne 1 -or
     @($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -ne 1){
    throw 'AI01_RECONCILE_UNTRUSTED_BOOT_TRIGGER_SET'
  }
  $xml=[xml]$found.Registered.Xml
  $uri=$xml.Task.RegistrationInfo.URI
  if($uri -and [string]$uri -cne '\Nexowire Hub Boot'){
    throw 'AI01_RECONCILE_FOREIGN_TASK_URI'
  }
  return $xml
}
function Get-RuntimeHashes([string]$root) {
  $null=Assert-PlainPath $root $true
  $files=@()
  foreach($item in @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)){
    $null=Assert-PlainPath $item.FullName
    if($item.PSIsContainer){continue}
    if($item.FullName.Substring($root.Length+1) -match '(^|\\)\.\.($|\\)'){
      throw 'AI01_RECONCILE_TRAVERSAL_DENIED'
    }
    $files+=([pscustomobject]@{
      Relative=$item.FullName.Substring($root.Length+1)
      Sha256=(Hash $item.FullName)
    })
  }
  return @($files | Sort-Object Relative)
}
function Read-Receipt {
  if(-not $BackupId){throw 'AI01_RECONCILE_BACKUP_ID_REQUIRED'}
  $root=Join-Path $backupParent $BackupId
  $null=Assert-PlainPath $backupParent $true
  $null=Assert-PlainPath $root $true
  $receiptFile=Join-Path $root 'receipt.json'
  $null=Assert-PlainPath $receiptFile $true
  $sha=Hash $receiptFile
  if($ExpectedReceiptSha256 -and $ExpectedReceiptSha256.ToLowerInvariant() -cne $sha){
    throw 'AI01_RECONCILE_RECEIPT_HASH_MISMATCH'
  }
  $receipt=Get-Content -LiteralPath $receiptFile -Raw -ErrorAction Stop | ConvertFrom-Json
  if($receipt.Version -ne 1 -or $receipt.Host -cne $env:COMPUTERNAME -or
     $receipt.TaskName -cne $taskName -or $receipt.Id -cne $BackupId){
    throw 'AI01_RECONCILE_FOREIGN_RECEIPT'
  }
  $taskXml=Join-Path $root 'task.xml'
  $sddlFile=Join-Path $root 'task.sddl'
  $restoreScript=Join-Path $root 'Restore-Task.ps1'
  foreach($f in @($taskXml,$sddlFile,$restoreScript)){$null=Assert-PlainPath $f $true}
  if((Hash $taskXml) -cne $receipt.XmlSha256 -or
     (Hash $sddlFile) -cne $receipt.SddlSha256 -or
     (Hash $restoreScript) -cne $receipt.RestoreScriptSha256){
    throw 'AI01_RECONCILE_BACKUP_TAMPERED'
  }
  $runtimeCopy=Join-Path $root 'runtime'
  $entries=Get-RuntimeHashes $runtimeCopy
  if($entries.Count -ne @($receipt.Runtime).Count){throw 'AI01_RECONCILE_BACKUP_RUNTIME_CHANGED'}
  foreach($entry in $entries) {
    $baseline=@($receipt.Runtime | Where-Object { $_.Relative -ceq $entry.Relative })
    if($baseline.Count -ne 1 -or $baseline[0].Sha256 -cne $entry.Sha256){
      throw 'AI01_RECONCILE_BACKUP_RUNTIME_CHANGED'
    }
  }
  return [pscustomobject]@{
    Root=$root;Receipt=$receipt;Sha256=$sha;Xml=$taskXml;Sddl=$sddlFile
  }
}
function Confirm-OldTaskUnchanged($backup) {
  $current=Get-TaskOrVisibility
  $xml=Assert-LegacyIdentity $current
  $canonical=$xml.OuterXml
  if($canonical -cne $backup.Receipt.TaskXmlCanonical){
    throw 'AI01_RECONCILE_TASK_CHANGED_AFTER_BACKUP'
  }
  $sd=[string]$current.Registered.GetSecurityDescriptor(7)
  if($sd -cne [string](Get-Content -LiteralPath $backup.Sddl -Raw).Trim()){
    throw 'AI01_RECONCILE_TASK_SECURITY_CHANGED'
  }
  $now=Get-RuntimeHashes $legacyRoot
  if($now.Count -ne @($backup.Receipt.Runtime).Count){throw 'AI01_RECONCILE_RUNTIME_CHANGED'}
  foreach($entry in $now){
    $baseline=@($backup.Receipt.Runtime | Where-Object {$_.Relative -ceq $entry.Relative})
    if($baseline.Count -ne 1 -or $baseline[0].Sha256 -cne $entry.Sha256){
      throw 'AI01_RECONCILE_RUNTIME_CHANGED'
    }
  }
  return $current
}
function Write-PrivateText([string]$p,[string]$text) {
  $text | Set-Content -LiteralPath $p -Encoding UTF8 -ErrorAction Stop
  & 'C:\Windows\System32\icacls.exe' $p '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_BACKUP_FILE_ACL_FAILED'}
  & 'C:\Windows\System32\icacls.exe' $p '/setowner' '*S-1-5-32-544' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_BACKUP_FILE_OWNER_FAILED'}
  $null=Assert-PlainPath $p $true
}
function Assert-UserHubStillRunning {
  $task=Get-ScheduledTask -TaskName $userTaskName -TaskPath '\' -ErrorAction Stop
  if([string]$task.State -cne 'Running'){
    throw 'AI01_RECONCILE_USER_HUB_NOT_RUNNING'
  }
  $sid=[string]$task.Principal.UserId
  try {$sid=(New-Object Security.Principal.NTAccount($sid)).Translate([Security.Principal.SecurityIdentifier]).Value}
  catch {throw 'AI01_RECONCILE_USER_HUB_IDENTITY_UNVERIFIED'}
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # The trusted human administrator must be the same owner as the interactive Hub.
  if($sid -cne $owner -or [string]$task.Principal.RunLevel -cne 'Limited' -or
     [string]$task.Principal.LogonType -cne 'Interactive' -or
     [string]$task.Description -cne 'Nexowire first-party Hub'){
    throw 'AI01_RECONCILE_USER_HUB_IDENTITY_UNVERIFIED'
  }
  $actions=@($task.Actions)
  $expectedUserLauncher=Join-Path $env:USERPROFILE '.nexowire\hub-service\launch.ps1'
  $expectedUserArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$expectedUserLauncher+'"'
  if($actions.Count -ne 1 -or [string]$actions[0].Arguments -cne $expectedUserArgs -or
    ([string]$actions[0].Execute).Trim('"') -notin @('powershell.exe',$pwsh)){
    throw 'AI01_RECONCILE_USER_HUB_ACTION_UNTRUSTED'
  }
}
function Assert-RuntimeStaged {
  if(-not $ExpectedRuntimeTreeSha256){
    throw 'AI01_RECONCILE_PINNED_RUNTIME_TREE_SHA256_REQUIRED'
  }
  $null=Assert-PlainPath 'C:\Program Files'
  $null=Assert-PlainPath 'C:\Program Files\Nexowire' $true
  $null=Assert-PlainPath $trustedRuntime $true
  $files=@()
  $items=@(Get-Item -LiteralPath $trustedRuntime -Force)
  $items+=@(Get-ChildItem -LiteralPath $trustedRuntime -Force -Recurse -ErrorAction Stop)
  if($items.Count -gt 30000){throw 'AI01_RECONCILE_RUNTIME_TREE_LIMIT'}
  foreach($item in $items){
    $null=Assert-PlainPath $item.FullName $true
    if($item.PSIsContainer){continue}
    $relative=$item.FullName.Substring($trustedRuntime.Length+1).Replace('\','/')
    $files+=([pscustomobject]@{Relative=$relative;FullName=$item.FullName})
  }
  foreach($needed in @('package.json','package-lock.json','dist/src/cli.js')){
    if(@($files | Where-Object {$_.Relative -ceq $needed}).Count -ne 1){
      throw 'AI01_RECONCILE_RUNTIME_REQUIRED_FILE_MISSING'
    }
  }
  if(-not @($files | Where-Object {$_.Relative.StartsWith('node_modules/',[StringComparison]::Ordinal)}).Count){
    throw 'AI01_RECONCILE_RUNTIME_NODE_MODULES_MISSING'
  }
  $lines=@()
  foreach($file in @($files | Sort-Object Relative)){
    $lines+=($file.Relative+'  '+(Hash $file.FullName))
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    $bytes=[Text.Encoding]::UTF8.GetBytes([string]::Join([char]10,$lines))
    $digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
  } finally {$sha.Dispose()}
  if($digest -cne $ExpectedRuntimeTreeSha256.ToLowerInvariant()){
    throw 'AI01_RECONCILE_PINNED_RUNTIME_TREE_MISMATCH'
  }
  $node='C:\Program Files\nodejs\node.exe'
  $signature=Get-AuthenticodeSignature -LiteralPath $node -ErrorAction Stop
  if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -cne 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'){
    throw 'AI01_RECONCILE_SIGNED_NODE_UNVERIFIED'
  }
}
function Rehearse($b) {
  $task=[xml](Get-Content -LiteralPath $b.Xml -Raw)
  $ns=New-Object Xml.XmlNamespaceManager($task.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $settings=$task.SelectSingleNode('/t:Task/t:Settings',$ns)
  if($null -eq $settings){throw 'AI01_RECONCILE_XML_NO_SETTINGS'}
  $enabled=$settings.SelectSingleNode('t:Enabled',$ns)
  if($null -eq $enabled){
    $enabled=$task.CreateElement('Enabled',$ns.LookupNamespace('t'))
    $null=$settings.AppendChild($enabled)
  }
  $enabled.InnerText='false'
  $probeName='Nexowire Hub Restore Probe '+[guid]::NewGuid().ToString('N')
  $probeUri=$task.SelectSingleNode('/t:Task/t:RegistrationInfo/t:URI',$ns)
  if($null -ne $probeUri){$probeUri.InnerText='\'+$probeName}
  try {
    Register-ScheduledTask -TaskName $probeName -TaskPath '\' -Xml $task.OuterXml -Force:$false -ErrorAction Stop | Out-Null
    $probe=Get-ScheduledTask -TaskName $probeName -TaskPath '\' -ErrorAction Stop
    if($probe.Settings.Enabled -or
       [string]$probe.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')){
      throw 'AI01_RECONCILE_REHEARSAL_UNSAFE'
    }
  } finally {
    $existing=Get-ScheduledTask -TaskName $probeName -TaskPath '\' -ErrorAction SilentlyContinue
    if($existing){Unregister-ScheduledTask -TaskName $probeName -TaskPath '\' -Confirm:$false -ErrorAction Stop}
    $left=Get-ScheduledTask -TaskName $probeName -TaskPath '\' -ErrorAction SilentlyContinue
    if($left){throw 'AI01_RECONCILE_REHEARSAL_CLEANUP_FAILED'}
  }
  Write-PrivateText (Join-Path $b.Root 'rehearsal.txt') $b.Sha256
  return $true
}

if($Action -eq 'Inspect'){
  $r=Get-TaskOrVisibility
  $result=[ordered]@{action='Inspect';visibility=$r.Visibility;taskName=$taskName;
    elevated=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
  if($r.Visibility -eq 'found'){
    try{
      $null=Assert-LegacyIdentity $r
      $result.identity='legacy-system-matching'
      $result.state=[string]$r.Task.State
      $result.principal=[string]$r.Task.Principal.UserId
    }catch{$result.identity='unverified'}
  }
  [pscustomobject]$result | ConvertTo-Json -Depth 5
  return
}
Assert-Admin
Assert-ToolTrusted
Assert-PrivateAncestors
if($Action -eq 'Backup'){
  $found=Get-TaskOrVisibility
  $xml=Assert-LegacyIdentity $found
  $null=Assert-PlainPath $legacyRoot $true
  $sddl=[string]$found.Registered.GetSecurityDescriptor(7)
  if([string]::IsNullOrWhiteSpace($sddl)){throw 'AI01_RECONCILE_TASK_SD_UNAVAILABLE'}
  $null=Assert-PlainPath $launcher $true
  $runtimeFiles=Get-RuntimeHashes $legacyRoot
  if(-not (Test-Path -LiteralPath $backupParent)){
    Make-PrivateDirectory $backupParent
  }else{$null=Assert-PlainPath $backupParent $true}
  $id=[guid]::NewGuid().ToString()
  $root=Join-Path $backupParent $id
  Make-PrivateDirectory $root
  $runtimeCopy=Join-Path $root 'runtime'
  Make-PrivateDirectory $runtimeCopy
  Get-ChildItem -LiteralPath $legacyRoot -Force | Copy-Item -Destination $runtimeCopy -Recurse -ErrorAction Stop
  & 'C:\Windows\System32\icacls.exe' $runtimeCopy '/setowner' '*S-1-5-32-544' '/T' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_RUNTIME_BACKUP_OWNER_FAILED'}
  & 'C:\Windows\System32\icacls.exe' $runtimeCopy '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_RUNTIME_BACKUP_ACL_FAILED'}
  foreach($item in @(Get-Item $runtimeCopy)+@(Get-ChildItem -LiteralPath $runtimeCopy -Force -Recurse)){
    $null=Assert-PlainPath $item.FullName $true
  }
  Write-PrivateText (Join-Path $root 'task.xml') $found.Registered.Xml
  Write-PrivateText (Join-Path $root 'task.sddl') $sddl
  $restoreScript=Join-Path $root 'Restore-Task.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $restoreScript -ErrorAction Stop
  & 'C:\Windows\System32\icacls.exe' $restoreScript '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_RESTORE_SCRIPT_ACL_FAILED'}
  & 'C:\Windows\System32\icacls.exe' $restoreScript '/setowner' '*S-1-5-32-544' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_RECONCILE_RESTORE_SCRIPT_OWNER_FAILED'}
  $null=Assert-PlainPath $restoreScript $true
  $copyHashes=Get-RuntimeHashes $runtimeCopy
  if($runtimeFiles.Count -ne $copyHashes.Count){throw 'AI01_RECONCILE_BACKUP_COPY_MISMATCH'}
  for($i=0;$i -lt $runtimeFiles.Count;$i++){
    if($runtimeFiles[$i].Relative -cne $copyHashes[$i].Relative -or
       $runtimeFiles[$i].Sha256 -cne $copyHashes[$i].Sha256){
      throw 'AI01_RECONCILE_BACKUP_COPY_MISMATCH'
    }
  }
  $receipt=[ordered]@{Version=1;Host=$env:COMPUTERNAME;Id=$id;TaskName=$taskName;
    TaskState=[string]$found.Task.State;CreatedAt=[DateTime]::UtcNow.ToString('o');
    XmlSha256=(Hash (Join-Path $root 'task.xml'));
    SddlSha256=(Hash (Join-Path $root 'task.sddl'));
    RestoreScriptSha256=(Hash $restoreScript);
    TaskXmlCanonical=$xml.OuterXml;Runtime=$runtimeFiles}
  Write-PrivateText (Join-Path $root 'receipt.json') ($receipt | ConvertTo-Json -Depth 9)
  $BackupId=$id
  $b=Read-Receipt
  [pscustomobject]@{action='Backup';id=$id;receiptSha256=$b.Sha256;
    verified=$true;rehearsed=$false;taskChanged=$false;userHubChanged=$false} | ConvertTo-Json
  return
}
if(-not $ExpectedReceiptSha256){throw 'AI01_RECONCILE_EXPLICIT_RECEIPT_DIGEST_REQUIRED'}
$b=Read-Receipt
if($Action -eq 'Verify'){
  [pscustomobject]@{action='Verify';backupId=$BackupId;receiptSha256=$b.Sha256;
    verified=$true;rehearsed=(Test-Path -LiteralPath (Join-Path $b.Root 'rehearsal.txt'))} | ConvertTo-Json
  return
}
if($Action -eq 'Rehearse'){
  $null=Confirm-OldTaskUnchanged $b
  $null=Rehearse $b
  [pscustomobject]@{action='Rehearse';backupId=$BackupId;receiptSha256=$b.Sha256;restoreRegistrationTest='PASS'} | ConvertTo-Json
  return
}
if(-not $ExpectedReceiptSha256){throw 'AI01_RECONCILE_EXPLICIT_RECEIPT_DIGEST_REQUIRED'}
if($Action -eq 'Retire'){
  if(-not $ApproveRetirement){throw 'AI01_RECONCILE_OWNER_APPROVAL_REQUIRED'}
  $proofFile=Join-Path $b.Root 'rehearsal.txt'
  if(-not (Test-Path -LiteralPath $proofFile)){throw 'AI01_RECONCILE_REHEARSAL_REQUIRED'}
  $null=Assert-PlainPath $proofFile $true
  if(([string](Get-Content -LiteralPath $proofFile -Raw)).Trim() -cne $b.Sha256){
    throw 'AI01_RECONCILE_REHEARSAL_RECEIPT_MISMATCH'
  }
  $current=Confirm-OldTaskUnchanged $b
  if([string]$current.Task.State -notin @('Ready','Disabled')){
    throw 'AI01_RECONCILE_OLD_SYSTEM_TASK_NOT_QUIESCENT'
  }
  Assert-UserHubStillRunning
  Assert-RuntimeStaged
  # Do not continue if the latest task XML changed between verification and mutation.
  $null=Confirm-OldTaskUnchanged $b
  try {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
    $after=Get-TaskOrVisibility
    if($after.Visibility -cne 'not-installed'){
      throw 'AI01_RECONCILE_REMOVAL_NOT_PROVEN'
    }
  } catch {
    # A restoration attempt is deliberately conditional on exact proven absence.
    # Never overwrite a task that appeared concurrently.
    $after=Get-TaskOrVisibility
    if($after.Visibility -eq 'not-installed'){
      Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml (Get-Content -LiteralPath $b.Xml -Raw) -Force:$false -ErrorAction Stop | Out-Null
      $restored=Get-TaskOrVisibility
      $null=Assert-LegacyIdentity $restored
      $restored.Registered.SetSecurityDescriptor(([string](Get-Content -LiteralPath $b.Sddl -Raw)).Trim(),0)
      throw 'AI01_RECONCILE_REMOVAL_FAILED_TASK_RESTORED'
    }
    throw
  }
  [pscustomobject]@{action='Retire';taskRemoved=$true;userHubChanged=$false;
    backupId=$BackupId;receiptSha256=$b.Sha256;rollbackScript=(Join-Path $b.Root 'Restore-Task.ps1')} | ConvertTo-Json
  return
}
if($Action -eq 'Restore'){
  Assert-UserHubStillRunning
  $current=Get-TaskOrVisibility
  if($current.Visibility -cne 'not-installed'){
    throw 'AI01_RECONCILE_RESTORE_WOULD_OVERWRITE_OR_HIDE_TASK'
  }
  $taskXml=Get-Content -LiteralPath $b.Xml -Raw
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $taskXml -Force:$false -ErrorAction Stop | Out-Null
  $recreated=Get-TaskOrVisibility
  $null=Assert-LegacyIdentity $recreated
  $recreated.Registered.SetSecurityDescriptor(([string](Get-Content -LiteralPath $b.Sddl -Raw)).Trim(),0)
  $recreated=Get-TaskOrVisibility
  $null=Assert-LegacyIdentity $recreated
  if([string]$recreated.Registered.GetSecurityDescriptor(7) -cne
     ([string](Get-Content -LiteralPath $b.Sddl -Raw)).Trim()){
    throw 'AI01_RECONCILE_RESTORED_ACL_MISMATCH'
  }
  [pscustomobject]@{action='Restore';restored=$true;backupId=$BackupId;
    userHubChanged=$false;receiptSha256=$b.Sha256} | ConvertTo-Json
}
