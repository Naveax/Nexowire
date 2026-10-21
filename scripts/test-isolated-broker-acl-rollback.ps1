# Test fixture ONLY: no production ProgramData paths, tasks, or services.
# Creates a random folder under the current user's OS temporary directory.
[CmdletBinding()]
param([switch]$SimulateFailure)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$icacls='C:\Windows\System32\icacls.exe'
$root=$null
$restored=$false
$wasBroad=$false
$remainsBroad=$true
$status='unstarted'
$folderBackup=$null
$fileBackup=$null
$file=$null
$cleanupConfirmed=$false
$restoreRootOk=$false
$restoreFileOk=$false
$restoreExceptionType='none'
$rootAclMatched=$false
$fileAclMatched=$false
function Call-Icacls {
  param([string[]]$Arguments)
  & $icacls @Arguments | Out-Null
  if($LASTEXITCODE -ne 0){throw 'ISOLATED_ICACLS_FAILED'}
}
function BroadModify([string]$target) {
  $acl=Get-Acl -LiteralPath $target -ErrorAction Stop
  $sid='S-1-5-11'
  $writeMask=[int][System.Security.AccessControl.FileSystemRights]::Modify
  foreach($entry in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($entry.IdentityReference.Value -eq $sid -and
       $entry.AccessControlType -eq 'Allow' -and
       (([int]$entry.FileSystemRights -band $writeMask) -ne 0)){
       return $true
    }
  }
  return $false
}
try {
  if(-not [IO.File]::Exists($icacls)){throw 'PINNED_ICACLS_MISSING'}
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $name='nexowire-acl-fixture-'+[guid]::NewGuid().ToString('N')
  $root=Join-Path $temp $name
  if(-not $root.StartsWith(($temp+'\nexowire-acl-fixture-'),[StringComparison]::OrdinalIgnoreCase)){
    throw 'NOT_AN_ISOLATED_TEMP_FIXTURE'
  }
  [void](New-Item -Path $root -ItemType Directory -ErrorAction Stop)
  $file=Join-Path $root 'dummy-launch.ps1'
  [IO.File]::WriteAllText($file,'# synthetic fixture only')
  if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'FIXTURE_IS_REPARSE_POINT'
  }
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $folderBackup=Get-Acl -LiteralPath $root
  $fileBackup=Get-Acl -LiteralPath $file
  # Deliberate *test-only* unsafe ACL; this is NOT the production Broker path.
  Call-Icacls @($root,'/grant','*S-1-5-11:(OI)(CI)M')
  Call-Icacls @($file,'/grant','*S-1-5-11:M')
  $wasBroad=(BroadModify $root) -and (BroadModify $file)
  if(-not $wasBroad){throw 'UNSAFE_FIXTURE_NOT_REPRODUCED'}
  # Use the same pinned exact SID plan as private source ACLs, plus the
  # test user's SID so an unprivileged fixture can restore its own backup.
  Call-Icacls @($root,'/inheritance:r','/grant:r',
    '*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F',
    ('*'+$current+':(OI)(CI)F'),'/remove:g',
    '*S-1-5-11','*S-1-5-32-545','*S-1-1-0','*S-1-5-4')
  if($SimulateFailure){throw 'SIMULATED_FAILURE_AFTER_FOLDER_HARDENING'}
  Call-Icacls @($file,'/inheritance:r','/grant:r',
    '*S-1-5-18:F','*S-1-5-32-544:F',
    ('*'+$current+':F'),'/remove:g',
    '*S-1-5-11','*S-1-5-32-545','*S-1-1-0','*S-1-5-4')
  $remainsBroad=(BroadModify $root) -or (BroadModify $file)
  if($remainsBroad){throw 'UNSAFE_WRITE_ACE_REMAINS'}
  $status='isolated-hardened'
}catch {
  # No raw paths or elevated diagnostics are returned to the caller.
  $status=if($_.Exception.Message -eq 'SIMULATED_FAILURE_AFTER_FOLDER_HARDENING'){
    'simulated-failure'
  }else{'fixture-failed'}
}finally{
  if($root -and $folderBackup -and $fileBackup -and
     $root.StartsWith(($temp+'\nexowire-acl-fixture-'),[StringComparison]::OrdinalIgnoreCase)){
    try {
      # Restore the DACL only; Set-Acl of a full snapshot can demand
      # SeRestorePrivilege to rewrite owner or SACL on non-admin hosts.
      $access=[Security.AccessControl.AccessControlSections]::Access
      $restoreDir=New-Object Security.AccessControl.DirectorySecurity
      $restoreDir.SetSecurityDescriptorSddlForm(
        $folderBackup.GetSecurityDescriptorSddlForm($access),$access)
      [IO.Directory]::SetAccessControl($root,$restoreDir)
      $restoreRootOk=$true
      $restoreFile=New-Object Security.AccessControl.FileSecurity
      $restoreFile.SetSecurityDescriptorSddlForm(
        $fileBackup.GetSecurityDescriptorSddlForm($access),$access)
      [IO.File]::SetAccessControl($file,$restoreFile)
      $restoreFileOk=$true
      $rootAclMatched=((Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) -ceq
        $folderBackup.GetSecurityDescriptorSddlForm($access))
      $fileAclMatched=((Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm($access) -ceq
        $fileBackup.GetSecurityDescriptorSddlForm($access))
      $restored=$rootAclMatched -and $fileAclMatched
    }catch {
      $restoreExceptionType=$_.Exception.GetType().Name
      $restored=$false
    }
  }
  if($root -and $root.StartsWith(($temp+'\nexowire-acl-fixture-'),[StringComparison]::OrdinalIgnoreCase)){
    try {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
      $cleanupConfirmed=-not (Test-Path -LiteralPath $root)
    }catch {$cleanupConfirmed=$false}
  }
}
[pscustomobject]@{
  status=$status
  reproducedBroadModify=$wasBroad
  broadModifyAfterHardening=$remainsBroad
  originalAclRestored=$restored
  restoreRootOk=$restoreRootOk
  restoreFileOk=$restoreFileOk
  rootAclMatched=$rootAclMatched
  fileAclMatched=$fileAclMatched
  restoreExceptionType=$restoreExceptionType
  fixtureRemoved=$cleanupConfirmed
  productionAclModified=$false
  productionAccepted=$false
  serviceOrTaskTouched=$false
} | ConvertTo-Json -Compress
if(-not $wasBroad -or -not $restored -or -not $cleanupConfirmed -or
  ($status -ne 'isolated-hardened' -and $status -ne 'simulated-failure')){
  exit 1
}
