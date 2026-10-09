#Requires -Version 5.1
<#
.SYNOPSIS
Read-only legacy Stack cutover readiness report. This script NEVER authorizes or performs a cutover.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$RuntimeRoot,
 [Parameter(Mandatory=$true)][string]$Entrypoint,
 [Parameter(Mandatory=$true)][string]$LauncherRoot,
 [Parameter(Mandatory=$true)][string]$Launcher,
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [string]$TaskName='Nexowire Stack',
 [ValidateRange(1,65535)][int]$HubPort=43110,
 [ValidateRange(1,65535)][int]$BrokerPort=43112,
 [ValidateRange(10,20000)][int]$MaxObjects=20000
)
$ErrorActionPreference='Stop'
# Caller-provided PSModulePath may point at executable untrusted modules.
# Resolve inbox Windows cmdlets only from the pinned Windows system module root.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1' -ErrorAction Stop
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetTCPIP\NetTCPIP.psd1' -ErrorAction Stop
$psExe='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$audit=Join-Path $PSScriptRoot 'audit-windows-runtime-acl.ps1'
if(!(Test-Path -LiteralPath $audit -PathType Leaf) -or !(Test-Path -LiteralPath $psExe -PathType Leaf)){throw 'READONLY_AUDITOR_UNAVAILABLE'}
function Under([string]$r,[string]$f){
 if(-not [IO.Path]::IsPathRooted($r) -or -not [IO.Path]::IsPathRooted($f)){return $false}
 $rr=[IO.Path]::GetFullPath($r).TrimEnd('\')
 $ff=[IO.Path]::GetFullPath($f)
 return $rr.Length -ge 4 -and $ff.StartsWith($rr+'\', [StringComparison]::OrdinalIgnoreCase)
}
if(-not (Under $RuntimeRoot $Entrypoint) -or -not (Under $LauncherRoot $Launcher)){throw 'CUTOVER_INVALID_SCOPE'}
if(!(Test-Path -LiteralPath $Entrypoint -PathType Leaf) -or !(Test-Path -LiteralPath $Launcher -PathType Leaf) -or !(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)){throw 'CUTOVER_REQUIRED_FILE_MISSING'}
$blockers=New-Object 'System.Collections.Generic.List[string]'
function Block([string]$id){if(-not $blockers.Contains($id)){$blockers.Add($id)}}
function InspectTree([string]$root,[string]$entry,[string]$name){
 $v=[ordered]@{name=$name;scope='ROOT_TREE_AND_PARENTS';completed=$false;objects=0;findings=0;unsafe=$true}
 try{
  $lines=& $psExe -NoProfile -NonInteractive -File $audit -RuntimeRoot $root -Entrypoint $entry -FullTree -MaxObjects $MaxObjects -MaxReportedFindings 1 2>$null
  if($LASTEXITCODE -ne 0){throw 'AUDIT_FAILED'}
  $j=($lines|Out-String|ConvertFrom-Json -ErrorAction Stop)
  if($j.mode -ne 'READ_ONLY' -or !$j.packageTreeAudited -or $j.productionFilesChanged -ne $false -or $j.scope -ne 'ROOT_TREE_AND_PARENTS' -or $j.componentsAudited -lt 1){throw 'AUDIT_INCOMPLETE'}
  $v.completed=$true
  $v.objects=[int]$j.componentsAudited
  $v.findings=[int]$j.totalFindings
  $v.unsafe=($j.totalFindings -gt 0)
 }catch{Block ('ACL_'+$name+'_SCAN_INCOMPLETE')}
 if($v.unsafe){Block ('ACL_'+$name+'_UNTRUSTED')}
 return [pscustomobject]$v
}
$pkg=InspectTree $RuntimeRoot $Entrypoint 'LEGACY_PACKAGE'
$launch=InspectTree $LauncherRoot $Launcher 'LEGACY_LAUNCHER'
$nodeRoot=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($NodeExecutable))
$node=InspectTree $nodeRoot $NodeExecutable 'NODE_HOST'
$task=$null
try{$task=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop}catch{Block 'LEGACY_SUPERVISOR_TASK_UNVERIFIED'}
$taskState=if($task){[string]$task.State}else{'not-found'}
$taskLevel=if($task){[string]$task.Principal.RunLevel}else{'unknown'}
$taskMatch=$false
if($task){
 $actions=@($task.Actions)
 if($actions.Count -eq 1){
  $action=$actions[0]
  $taskMatch=([IO.Path]::GetFileName([string]$action.Execute) -ieq 'powershell.exe') -and ([string]$action.Arguments).IndexOf($Launcher,[StringComparison]::OrdinalIgnoreCase) -ge 0
 }
 if(!$taskMatch){Block 'LEGACY_TASK_LAUNCHER_UNVERIFIED'}
 if($taskState -eq 'Running'){Block 'LEGACY_SUPERVISOR_RUNNING'}
}
function ReadPort([int]$port){
 # Query the listening table once and filter locally. Absence of a port is
 # an observed free port, not an inventory error. Permission/query failure
 # remains fail-closed via the surrounding catch.
 $owners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq $port} | Select-Object -ExpandProperty OwningProcess -Unique)
 $p=if($owners.Count -eq 1){[int]$owners[0]}else{$null}
 return [pscustomobject]@{port=$port;listening=($owners.Count -gt 0);ownerPid=$p;ambiguousOwners=($owners.Count -gt 1)}
}
try{$hub=ReadPort $HubPort}catch{Block 'HUB_PORT_INVENTORY_UNAVAILABLE';$hub=[pscustomobject]@{port=$HubPort;listening=$null;ownerPid=$null;ambiguousOwners=$null}}
try{$broker=ReadPort $BrokerPort}catch{Block 'BROKER_PORT_INVENTORY_UNAVAILABLE';$broker=[pscustomobject]@{port=$BrokerPort;listening=$null;ownerPid=$null;ambiguousOwners=$null}}
if($hub.listening){Block 'HUB_PORT_OCCUPIED'}
if($broker.listening){Block 'BROKER_PORT_OCCUPIED'}
if($hub.ambiguousOwners){Block 'HUB_PORT_AMBIGUOUS_OWNER'}
if($broker.ambiguousOwners){Block 'BROKER_PORT_AMBIGUOUS_OWNER'}
$sigStatus='unverified'
try{
 $sigStatus=[string](Get-AuthenticodeSignature -LiteralPath $NodeExecutable -ErrorAction Stop).Status
 if($sigStatus -ne 'Valid'){Block 'NODE_SIGNATURE_NOT_VALID'}
}catch{Block 'NODE_SIGNATURE_UNAVAILABLE'}
$hashes=[ordered]@{}
foreach($item in @(
 [pscustomobject]@{name='legacyCliSha256';file=$Entrypoint},
 [pscustomobject]@{name='legacyLauncherSha256';file=$Launcher},
 [pscustomobject]@{name='nodeExeSha256';file=$NodeExecutable}
)){
 try{$hashes[$item.name]=(Get-FileHash -LiteralPath $item.file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()}
 catch{$hashes[$item.name]=$null;Block 'FILE_HASH_UNAVAILABLE'}
}
foreach($pending in @('TRUSTED_REPLACEMENT_NOT_ACCEPTED','TASK_AND_SECRET_ROLLBACK_UNVERIFIED','OWNER_AUTH_AND_SESSION_ACCEPTANCE_PENDING')){Block $pending}
[pscustomobject]@{
 schemaVersion=1;mode='READ_ONLY';privilegedOperationPerformed=$false;safeToCutover=$false
 task=[pscustomobject]@{state=$taskState;runLevel=$taskLevel;expectedLauncherReferenced=$taskMatch}
 ports=[pscustomobject]@{hub=$hub;broker=$broker}
 audits=@($pkg,$launch,$node)
 nodeSignatureStatus=$sigStatus;sha256=[pscustomobject]$hashes
 blockers=@($blockers.ToArray())
 credentialsInspected=$false;taskXmlBackedUp=$false;protectedRollbackVerified=$false
} | ConvertTo-Json -Depth 7 -Compress
