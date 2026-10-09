import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

export const PRIVILEGED_NODE_INJECTION_ENV = [
  'NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE',
  'NODE_ICU_DATA','NODE_EXTRA_CA_CERTS',
] as const;

export function assertNoPrivilegedNodeStartupFlags(args:readonly string[]):void {
  if(args.length!==0){
    throw new Error('PRIVILEGED_RUNTIME_NODE_FLAGS: Node startup flags are forbidden for SYSTEM Hub.');
  }
}

export interface PrivilegedRuntimeSource {
  executable: string;
  cliEntrypoint: string;
  env?: NodeJS.ProcessEnv;
}

function inside(parent:string,child:string):boolean {
  const p=path.win32.resolve(parent).replace(/[\\/]+$/,'').toLowerCase();
  const c=path.win32.resolve(child).toLowerCase();
  return c===p || c.startsWith(p+'\\');
}

/** Static location filter; this is NOT a substitute for the actual DACL audit. */
export function validatePrivilegedRuntimePaths(input:PrivilegedRuntimeSource):{
  executable:string;cliEntrypoint:string;codeRoot:string;
} {
  const env=input.env??process.env;
  if(!path.win32.isAbsolute(input.executable) || !path.win32.isAbsolute(input.cliEntrypoint)) {
    throw new Error('PRIVILEGED_RUNTIME_UNTRUSTED_PATH: Absolute paths required.');
  }
  const exe=path.win32.resolve(input.executable);
  const cli=path.win32.resolve(input.cliEntrypoint);
  // Do not choose an elevated PowerShell interpreter using a caller-controlled
  // SystemRoot/WINDIR variable. Only the fixed, OS-provided C: installation
  // layout is currently accepted; other layouts explicitly fail closed.
  const sysroot='C:\\Windows';
  const disk='C:';
  for(const target of [exe,cli]) {
    if(!path.win32.isAbsolute(target) || target.startsWith('\\\\') ||
      target.startsWith('\\\\?\\') || target.includes('..\\')) {
      throw new Error('PRIVILEGED_RUNTIME_UNTRUSTED_PATH: Non-local runtime path rejected.');
    }
    const userPaths=[env.USERPROFILE,env.LOCALAPPDATA,env.APPDATA,env.TEMP,env.TMP]
      .filter((s):s is string=>Boolean(s));
    if(userPaths.some(p=>inside(p,target))){
      throw new Error('PRIVILEGED_RUNTIME_USER_WRITABLE: User-profile or temporary runtime rejected.');
    }
    // Environment-provided ProgramFiles/ProgramData may be spoofed by a
    // caller. Only the verified Windows system-drive roots may anchor code.
    const allowed=[disk+'\\Program Files',disk+'\\Program Files (x86)',disk+'\\ProgramData'];
    if(!allowed.some(p=>inside(p,target))){
      throw new Error('PRIVILEGED_RUNTIME_UNTRUSTED_PATH: Runtime is outside protected install roots.');
    }
  }
  if(!existsSync(exe) || !existsSync(cli)){
    throw new Error('PRIVILEGED_RUNTIME_MISSING: Executable or CLI file not found.');
  }
  // Detect enclosing package without assuming scripts live next to the executable.
  let candidate=path.win32.dirname(cli);
  let pkg:string|null=null;
  for(let i=0;i<30;i++){
    if(existsSync(path.win32.join(candidate,'package.json'))){pkg=candidate;break}
    const next=path.win32.dirname(candidate);
    if(next===candidate)break;
    candidate=next;
  }
  if(!pkg)throw new Error('PRIVILEGED_RUNTIME_NO_PACKAGE: Cannot identify CLI package root.');
  const normalized=pkg.toLowerCase();
  const marker='\\node_modules\\';
  // Anchor at the OUTERMOST node_modules directory. Node imports may
  // resolve sibling packages above a nested dependency's own package.json.
  const index=normalized.indexOf(marker);
  const codeRoot=index>=0 ? pkg.slice(0,index):pkg;
  if(!codeRoot || !inside(codeRoot,cli)){
    throw new Error('PRIVILEGED_RUNTIME_INVALID_ROOT');
  }
  return {executable:exe,cliEntrypoint:cli,codeRoot};
}

/**
 * Fixed environment for the privileged read-only Windows ACL audit.
 * Never inherit PSModulePath, PATH, profile, preload hooks or app vars from
 * the caller: PowerShell module auto-loading can execute module code.
 */
export function buildPrivilegedPowerShellAuditEnv(paths:{
  executable:string;cliEntrypoint:string;codeRoot:string;
}):NodeJS.ProcessEnv{
  const windows='C:\\Windows';
  const system32=windows+'\\System32';
  const powershellDir=system32+'\\WindowsPowerShell\\v1.0';
  return {
    SystemRoot:windows,
    windir:windows,
    ComSpec:system32+'\\cmd.exe',
    PATH:[system32,windows,powershellDir].join(';'),
    PSModulePath:powershellDir+'\\Modules',
    NEXOWIRE_TRUST_EXE:paths.executable,
    NEXOWIRE_TRUST_CLI:paths.cliEntrypoint,
    NEXOWIRE_TRUST_ROOT:paths.codeRoot,
  };
}

const auditScript=String.raw`
$ErrorActionPreference='Stop'
# PowerShell may add machine/global module paths on startup. Reassert the
# Windows inbox module root before any module lookup. No user modules.
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$allow=@{'S-1-5-18'=$true;'S-1-5-32-544'=$true;'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true}
$rights=[System.Security.AccessControl.FileSystemRights]
$mask=([int]$rights::WriteData -bor [int]$rights::AppendData -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes -bor [int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership)
$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$scanned=0
function CheckItem([string]$p){
  if(-not $seen.Add($p)){return}
  $script:scanned++
  if($script:scanned -gt 20000){throw 'RUNTIME_OBJECT_CAP'}
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'RUNTIME_REPARSE_POINT'}
  $acl=Get-Acl -LiteralPath $p -ErrorAction Stop
  if(-not $allow.ContainsKey($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)){throw 'RUNTIME_OWNER_UNTRUSTED'}
  foreach($ace in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
    if($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
       ([int]$ace.FileSystemRights -band $mask) -ne 0 -and
       -not $allow.ContainsKey($ace.IdentityReference.Value)){throw 'RUNTIME_UNTRUSTED_WRITE_ACE'}
  }
}
foreach($p in @($env:NEXOWIRE_TRUST_EXE,$env:NEXOWIRE_TRUST_CLI,$env:NEXOWIRE_TRUST_ROOT)){
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  $cur=$item.FullName
  while($cur){
    CheckItem $cur
    $next=[System.IO.Path]::GetDirectoryName($cur.TrimEnd('\\'))
    if(!$next -or $next -eq $cur){break}
    $cur=$next
  }
}
$pending=New-Object 'System.Collections.Generic.Stack[string]'
$pending.Push($env:NEXOWIRE_TRUST_ROOT)
$pending.Push([System.IO.Path]::GetDirectoryName($env:NEXOWIRE_TRUST_EXE))
$scannedDirs=New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
while($pending.Count -gt 0){
  $dir=$pending.Pop()
  if(-not $scannedDirs.Add($dir)){continue}
  foreach($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)){
    CheckItem $item.FullName
    if($item.PSIsContainer){$pending.Push($item.FullName)}
  }
}
Write-Output 'TRUSTED_RUNTIME_CODE_TREE'
`;

/**
 * Reject persistent Highest/SYSTEM tasks pointing at user-writable code.
 * Read-only ACL preflight, performed BEFORE reading/storing DPAPI secrets.
 * This does not attest a code signature or immunize against post-check races.
 */
export function assertWindowsPrivilegedRuntimeTrusted(input:PrivilegedRuntimeSource):void {
  if(process.platform!=='win32'){
    throw new Error('Privileged Windows runtime preflight requires Windows.');
  }
  const paths=validatePrivilegedRuntimePaths(input);
  // Avoid executing attacker-selected powershell.exe from PATH/SystemRoot.
  const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if(!existsSync(powershell)) {
    throw new Error('PRIVILEGED_RUNTIME_OS_LAYOUT_UNSUPPORTED: Trusted system PowerShell not available.');
  }
  const command=Buffer.from(auditScript,'utf16le').toString('base64');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command],{
    env:buildPrivilegedPowerShellAuditEnv(paths),
    cwd:'C:\\Windows\\System32',
    windowsHide:true,timeout:120000,maxBuffer:1024*1024,
    encoding:'utf8',stdio:['ignore','pipe','pipe'],
  });
  if(result.error || result.status!==0 || !result.stdout.includes('TRUSTED_RUNTIME_CODE_TREE')){
    throw new Error('PRIVILEGED_RUNTIME_ACL_UNTRUSTED: Protected runtime tree and ancestors did not pass read-only Windows ACL validation.');
  }
}
