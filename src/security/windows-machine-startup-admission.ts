/**
 * The existing SYSTEM Hub and Highest Broker launchers share this admission
 * boundary. It does not launch a process, repair ACLs, delete a fence, or
 * grant a forward/rollback permission. Pending or unreviewed evidence is
 * deliberately denied until an independent positive authority exists.
 */
export const MACHINE_STARTUP_EVIDENCE_PS=String.raw`
function Assert-NxStartupDirectoryTrust([string]$directory,[bool]$outer){
  $attributes=[IO.File]::GetAttributes($directory)
  if(($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
     ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'MACHINE_STARTUP_STATE_PATH_UNTRUSTED'
  }
  # Same SID and write/replacement boundaries as the protected ACL checks.
  # Use inbox .NET APIs before any Node process or module lookup.
  $acl=[IO.Directory]::GetAccessControl($directory)
  $trusted=@{'S-1-5-18'=$true;'S-1-5-32-544'=$true;'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true}
  if(-not $trusted.ContainsKey($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)){
    throw 'MACHINE_STARTUP_STATE_OWNER_UNTRUSTED'
  }
  $rights=[Security.AccessControl.FileSystemRights]
  $mask=([int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership -bor [int64]0x10000000)
  if(-not $outer){
    $mask=($mask -bor [int]$rights::WriteData -bor [int]$rights::AppendData -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes -bor [int64]0x40000000)
  }
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    $inheritOnly=(($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
    if($inheritOnly -and ($outer -or $ace.IdentityReference.Value -eq 'S-1-3-0')){continue}
    if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
       ([int64]$ace.FileSystemRights -band $mask) -ne 0 -and
       -not $trusted.ContainsKey($ace.IdentityReference.Value)){
      throw 'MACHINE_STARTUP_STATE_WRITE_UNTRUSTED'
    }
  }
}
function Assert-NxStartupEvidence([string]$root){
  # Enumeration throws on inaccessible/missing roots. File.Exists and
  # Test-Path can collapse access failure to false; neither is used here.
  $children=@([IO.Directory]::GetFileSystemEntries($root))
  $updates=@()
  foreach($entry in $children){
    $name=[IO.Path]::GetFileName($entry)
    if($name -ieq 'hub-cutover-recovery'){
      # Even a terminal-looking journal needs independent live authority.
      throw 'MACHINE_STARTUP_HUB_RECOVERY_AUTHORITY_REQUIRED'
    }
    if($name -ieq 'update'){$updates+=,$entry}
  }
  if($updates.Count -gt 1){throw 'MACHINE_STARTUP_STATE_PATH_UNTRUSTED'}
  if($updates.Count -eq 1){
    $update=[IO.Path]::Combine($root,'update')
    if([string]$updates[0] -cne $update){throw 'MACHINE_STARTUP_STATE_PATH_UNTRUSTED'}
    Assert-NxStartupDirectoryTrust $update $false
    # v1 fence, missing fence with residual status/helper, torn/malformed
    # journal and unknown update artifacts are all unresolved evidence.
    # A self-described targetRoot or succeeded status is not permission.
    if(@([IO.Directory]::GetFileSystemEntries($update)).Count -ne 0){
      throw 'MACHINE_STARTUP_CUTOVER_AUTHORITY_REQUIRED'
    }
  }
}
function Test-NxRecoveryTaskNotFound([Exception]$failure){
  while($null -ne $failure.InnerException){$failure=$failure.InnerException}
  return ([int]$failure.HResult -eq -2147024894)
}
`;

/**
 * Only fixed paths and exact COM absence allow the clean-start case.
 * Historical scheduled recovery scripts and unguarded installed launchers
 * cannot be retroactively protected by this source. No normal online
 * updater is admitted until an independent installed-guard proof and a
 * serialized, forward-only authorization provider are provisioned.
 */
export const MACHINE_STARTUP_ADMISSION_PS=[
  MACHINE_STARTUP_EVIDENCE_PS,
  String.raw`
Assert-NxStartupDirectoryTrust 'C:\' $true
Assert-NxStartupDirectoryTrust 'C:\ProgramData' $true
Assert-NxStartupDirectoryTrust 'C:\ProgramData\Nexowire' $false
Assert-NxStartupEvidence 'C:\ProgramData\Nexowire'
# A scheduled historical recovery with missing journal is still unresolved.
# Only the exact root task COM not-found HRESULT is proof of absence.
$nxScheduler=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service'))
$nxScheduler.Connect()
$nxFolder=$nxScheduler.GetFolder('\')
$nxRecoveryAbsent=$false
try{$null=$nxFolder.GetTask('Nexowire Hub Cutover Recovery')}catch{
  if(Test-NxRecoveryTaskNotFound $_.Exception){$nxRecoveryAbsent=$true}
  else{throw 'MACHINE_STARTUP_RECOVERY_TASK_VISIBILITY_UNVERIFIED'}
}
if(-not $nxRecoveryAbsent){throw 'MACHINE_STARTUP_HUB_RECOVERY_AUTHORITY_REQUIRED'}
`,
].join('\r\n');

/** Same read-only admission before an installer overwrites a launcher or
 * changes a task. This does not authorize a migration or legacy recovery. */
export function assertMachineStartupStateReadOnly():void{
  if(process.platform!=='win32')throw Error('MACHINE_STARTUP_WINDOWS_ONLY');
  // The existing Job guardian only observes members of its own Job. It
  // cannot attest an external Schedule.Service COM activation or private
  // desktop identity. Deny standalone installer/start preflight rather
  // than launch on the owner desktop or substitute a generic executor.
  // The already canonical scheduled launcher retains its inline read-only
  // checks. Neither path provides a forward or recovery grant.
  throw Error('MACHINE_STARTUP_NATIVE_ISOLATION_REQUIRED');
}
/** No positive installed-guard or forward grant issuer is supplied by
 * #1352. Deny online admission for BOTH guarded and unguarded installations,
 * before staging, ACL changes or detached script creation. Not a rollback
 * verifier; no environment, caller flag or fixture key can bypass it. */
export function assertOnlineMachineCutoverAdmission():void{
  throw Error('MACHINE_UPDATE_CANONICAL_STARTUP_AUTHORITY_REQUIRED');
}

/** Direct boot-install is a legacy-to-SYSTEM cutover, not a normal boot.
 * It must not bypass AI-02's #1353 denial via a private offline receipt.
 * Keep the existing lifecycle implementation for a future independently
 * authorized admission, with no positive fallback or caller override. */
export function assertNewSystemHubCutoverAdmission():void{
  throw Error('AI04_SIGNED_SQLITE_RECOVERY_AUTHORITY_REQUIRED');
}
