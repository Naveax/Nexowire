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
$writeMask=([int]$rights::WriteData -bor [int]$rights::AppendData -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes -bor [int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership)
foreach($ace in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
  if($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
     ([int]$ace.FileSystemRights -band $writeMask) -ne 0 -and
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

export function hardenWindowsProgramDataAcl(
  root: string,
): void {
  if (process.platform !== 'win32') return;

  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'Refusing to harden non-directory or reparse-point ProgramData root.',
    );
  }

  // These protected lifecycle directories contain only flat files.
  // Fail closed instead of traversing a junction or unexpected subdirectory.
  const entries = readdirSync(root, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        'Unexpected object in protected ProgramData directory: ' +
          entry.name,
      );
    }
  }

  applyAcl(root, true);
  verifyWindowsPrivateAcl(root);
  for (const entry of entries) {
    const child=path.join(root,entry.name);
    applyAcl(child, false);
    verifyWindowsPrivateAcl(child);
  }
}
