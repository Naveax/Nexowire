import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_SYSTEM32='C:\\Windows\\System32';
const WINDOWS_POWERSHELL=WINDOWS_SYSTEM32+'\\WindowsPowerShell\\v1.0';
const WINDOWS_ICACLS=WINDOWS_SYSTEM32+'\\icacls.exe';

/** Deliberately exclude inherited caller-controlled PATH and module hooks. */
export function protectedWindowsAclEnvironment(target?:string):NodeJS.ProcessEnv {
  return {
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:WINDOWS_SYSTEM32+'\\cmd.exe',
    PATH:[WINDOWS_SYSTEM32,'C:\\Windows',WINDOWS_POWERSHELL].join(';'),
    PSModulePath:WINDOWS_POWERSHELL+'\\Modules',
    ...(target?{NEXOWIRE_PROTECTED_ACL_TARGET:target}:{}),
  };
}

/**
 * Apply a private Windows ProgramData DACL without recursively stripping
 * inherited ACEs from children. An icacls /inheritance:r /T combination
 * can leave existing child files with no access entries at all.
 */
export function windowsProgramDataAclArguments(
  target: string,
  directory: boolean,
): string[] {
  const permission = directory ? '(OI)(CI)F' : 'F';
  return [
    target,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:' + permission,
    '*S-1-5-32-544:' + permission,
    '/remove:g',
    '*S-1-5-32-545', // Users
    '*S-1-5-11',     // Authenticated Users
    '*S-1-1-0',      // Everyone
    '*S-1-5-4',      // INTERACTIVE
  ];
}

function applyAcl(target: string, directory: boolean): void {
  const result = spawnSync(
    WINDOWS_ICACLS,
    windowsProgramDataAclArguments(target, directory),
    {
      windowsHide: true,
      encoding: 'utf8',
      shell:false,
      cwd:WINDOWS_SYSTEM32,
      env:protectedWindowsAclEnvironment(),
      timeout:20000,
      maxBuffer:512*1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
      result.stdout.trim() ||
      'Failed to harden Windows ProgramData ACL: ' + target,
    );
  }
}

/**
 * Read-only integrity check AFTER a protected ACL operation.
 * Broad /remove:g cleanup is necessary but insufficient if an unknown
 * explicit SID remains. A user-owned file is untrusted even with a private DACL.
 */
export function verifyWindowsPrivateAcl(target:string):void {
  if(process.platform!=='win32'){
    throw new Error('Protected Windows ACL verification requires Windows.');
  }
  const script=String.raw`
$ErrorActionPreference='Stop'
# Load only trusted Windows inbox modules, not user-provided PSModulePath.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$target=$env:NEXOWIRE_PROTECTED_ACL_TARGET
$item=Get-Item -LiteralPath $target -Force -ErrorAction Stop
if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT'}
$acl=Get-Acl -LiteralPath $target -ErrorAction Stop
$allowed=@{'S-1-5-18'=$true;'S-1-5-32-544'=$true;'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true}
if(-not $allowed.ContainsKey($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)){throw 'UNTRUSTED_OWNER'}
$rights=[System.Security.AccessControl.FileSystemRights]
$writeMask=([int]$rights::WriteData -bor [int]$rights::AppendData -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes -bor [int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership -bor [int64]0x40000000 -bor [int64]0x10000000)
foreach($ace in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
  # CREATOR OWNER with InheritOnly is a non-effective child template.
  # Actual current owner is checked above; effective user grants still fail.
  if($ace.IdentityReference.Value -eq 'S-1-3-0' -and
     (($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)){continue}
  if($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
     ([int64]$ace.FileSystemRights -band $writeMask) -ne 0 -and
     -not $allowed.ContainsKey($ace.IdentityReference.Value)){throw 'UNTRUSTED_WRITE_ACE'}
}
Write-Output 'PRIVATE_ACL_VERIFIED'
`;
  // Never select a privileged interpreter from caller-controlled PATH/SystemRoot.
  const powershell=WINDOWS_POWERSHELL+'\\powershell.exe';
  const result=spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64'),
  ],{
    windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    shell:false,cwd:WINDOWS_SYSTEM32,
    env:protectedWindowsAclEnvironment(target),
    timeout:20000,
    maxBuffer:512*1024,
  });
  if(result.error||result.status!==0||
     result.stdout.trim()!=='PRIVATE_ACL_VERIFIED'){
    throw new Error('PROTECTED_ACL_INTEGRITY_FAILURE: Windows protected runtime has unsafe owner or write permissions.');
  }
}

/**
 * P0 legacy Stack read-only outer-ancestor gate. Shared Windows directories
 * can legitimately grant creation of unrelated siblings; unlike private
 * source files, only replacement/delete/DACL/owner rights are dangerous here.
 * Never select a caller-supplied path or a shell from the process PATH.
 */
export function verifyWindowsStackOuterAncestorAcl(target:string):void {
  if(process.platform!=='win32')throw new Error('STACK_OUTER_ANCESTOR_WINDOWS_ONLY');
  if(target!=='C:\\' && target!=='C:\\ProgramData'){
    throw new Error('STACK_OUTER_ANCESTOR_NONCANONICAL');
  }
  const script=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$target=$env:NEXOWIRE_PROTECTED_ACL_TARGET
if($target -cne 'C:\' -and $target -cne 'C:\ProgramData'){throw 'STACK_OUTER_ANCESTOR_NONCANONICAL'}
$item=Get-Item -LiteralPath $target -Force -ErrorAction Stop
if(-not $item.PSIsContainer -or
   (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){
  throw 'STACK_OUTER_ANCESTOR_REPARSE_OR_TYPE'
}
$acl=Get-Acl -LiteralPath $target -ErrorAction Stop
$trusted=@{'S-1-5-18'=$true;'S-1-5-32-544'=$true;'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true}
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if(-not $trusted.ContainsKey($owner)){throw 'STACK_OUTER_ANCESTOR_OWNER_UNTRUSTED'}
$rights=[Security.AccessControl.FileSystemRights]
$mask=([int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership -bor [int64]0x10000000)
foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  # Inherit-only ACEs do not apply to the inspected ancestor itself.
  if((([int]$ace.PropagationFlags -band [int][Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)){continue}
  if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
     ([int64]$ace.FileSystemRights -band $mask) -ne 0 -and
     -not $trusted.ContainsKey($ace.IdentityReference.Value)){
    throw 'STACK_OUTER_ANCESTOR_REPLACEMENT_RIGHTS'
  }
}
Write-Output 'STACK_OUTER_ANCESTOR_ACL_VERIFIED'
`;
  const result=spawnSync(WINDOWS_POWERSHELL+'\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64'),
  ],{
    windowsHide:true,encoding:'utf8',
    stdio:['ignore','pipe','pipe'],
    shell:false,cwd:WINDOWS_SYSTEM32,
    env:protectedWindowsAclEnvironment(target),
    timeout:20000,maxBuffer:512*1024,
  });
  if(result.error||result.status!==0||
     result.stdout.trim()!=='STACK_OUTER_ANCESTOR_ACL_VERIFIED'){
    throw new Error('STACK_OUTER_ANCESTOR_UNTRUSTED');
  }
}

/**
 * Read-only file inventory; test fixture readers are NOT Windows ACL authority.
 * These lifecycle roots are intentionally flat and must never contain links.
 */
export function snapshotFlatProgramDataChildrenReadOnly(root:string):ReadonlyArray<{
  readonly name:string;
  readonly dev:number;
  readonly ino:number;
  readonly nlink:number;
  readonly size:number;
  readonly mtimeMs:number;
  readonly birthtimeMs:number;
}> {
  const parent=lstatSync(root);
  if (!parent.isDirectory()||parent.isSymbolicLink()) {
    throw new Error('PROTECTED_ACL_DIRECTORY_UNTRUSTED');
  }
  const entries=readdirSync(root,{withFileTypes:true});
  const snapshot=entries.map(entry=>{
    const child=path.join(root,entry.name);
    const stat=lstatSync(child);
    if(!entry.isFile()||entry.isSymbolicLink()||
        !stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1) {
      throw new Error('PROTECTED_ACL_CHILD_TYPE_OR_HARDLINK_UNTRUSTED');
    }
    return Object.freeze({
      name:entry.name,dev:stat.dev,ino:stat.ino,nlink:stat.nlink,
      size:stat.size,mtimeMs:stat.mtimeMs,birthtimeMs:stat.birthtimeMs,
    });
  });
  snapshot.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  return Object.freeze(snapshot);
}

export function hardenWindowsProgramDataAcl(root:string):void {
  if (process.platform !== 'win32') return;

  const originalRoot=lstatSync(root);
  const original=snapshotFlatProgramDataChildrenReadOnly(root);
  applyAcl(root, true);
  verifyWindowsPrivateAcl(root);
  for(const entry of original) {
    const child=path.join(root,entry.name);
    // Never apply an elevated ACL to a new link/alias substituted after
    // enumeration. The final inventory also rejects files added mid-loop.
    const current=lstatSync(child);
    if(!current.isFile()||current.isSymbolicLink()||
        current.dev!==entry.dev||current.ino!==entry.ino||
        current.nlink!==entry.nlink||
        current.size!==entry.size||current.mtimeMs!==entry.mtimeMs||
        current.birthtimeMs!==entry.birthtimeMs) {
      throw new Error('PROTECTED_ACL_CHILD_CHANGED_DURING_HARDENING');
    }
    applyAcl(child, false);
    verifyWindowsPrivateAcl(child);
  }
  const finalRoot=lstatSync(root);
  if(!finalRoot.isDirectory()||finalRoot.isSymbolicLink()||
      finalRoot.dev!==originalRoot.dev||finalRoot.ino!==originalRoot.ino||
      JSON.stringify(snapshotFlatProgramDataChildrenReadOnly(root))!==
        JSON.stringify(original)) {
    throw new Error('PROTECTED_ACL_CHILD_INVENTORY_CHANGED');
  }
  verifyWindowsPrivateAcl(root);
}
