import {spawnSync} from 'node:child_process';

export const TRUSTED_MACHINE_UPDATE_TREE='C:\\ProgramData\\Nexowire';
const WINDOWS_SYSTEM32='C:\\Windows\\System32';
const WINDOWS_POWERSHELL=WINDOWS_SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Never inherit a process-selected PowerShell, modules, preload hooks or
 * execution search path into an elevated candidate-root audit. */
export function isolatedMachineUpdateAuditEnv(root:string):NodeJS.ProcessEnv{
  return {
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:WINDOWS_SYSTEM32+'\\cmd.exe',
    PATH:WINDOWS_SYSTEM32+';C:\\Windows',
    PSModulePath:WINDOWS_SYSTEM32+'\\WindowsPowerShell\\v1.0\\Modules',
    NEXOWIRE_MACHINE_AUDIT_ROOT:root,
  };
}

const readOnlyAuditScript=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$root=$env:NEXOWIRE_MACHINE_AUDIT_ROOT
if([string]::IsNullOrWhiteSpace($root)){throw 'MACHINE_UPDATE_ROOT_MISSING'}
$trusted=@{
  'S-1-5-18'=$true
  'S-1-5-32-544'=$true
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true
}
$rights=[System.Security.AccessControl.FileSystemRights]
$writeMask=([int]$rights::WriteData -bor [int]$rights::AppendData -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes -bor [int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership)
# First reject reparse/junction ancestors before entering the update tree.
$cur=$root
while($cur){
  $item=Get-Item -LiteralPath $cur -Force -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'MACHINE_UPDATE_REPARSE_ANCESTOR'}
  $parent=[IO.Path]::GetDirectoryName($cur.TrimEnd('\'))
  if(!$parent -or $parent -eq $cur){break}
  $cur=$parent
}
$dirs=New-Object 'System.Collections.Generic.Stack[string]'
$dirs.Push($root)
$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$count=0
while($dirs.Count -gt 0){
  $dir=$dirs.Pop()
  if(-not $seen.Add($dir)){continue}
  foreach($item in @((Get-Item -LiteralPath $dir -Force -ErrorAction Stop)) + @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)){
    $count++
    if($count -gt 25000){throw 'MACHINE_UPDATE_AUDIT_OBJECT_CAP'}
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'MACHINE_UPDATE_TREE_REPARSE_POINT'}
    $acl=Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if(-not $trusted.ContainsKey($owner)){throw 'MACHINE_UPDATE_UNTRUSTED_OWNER'}
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
         ([int]$ace.FileSystemRights -band $writeMask) -ne 0 -and
         -not $trusted.ContainsKey($ace.IdentityReference.Value)){
        throw 'MACHINE_UPDATE_UNTRUSTED_WRITE_ACE'
      }
    }
    if($item.PSIsContainer -and $item.FullName -ne $dir){$dirs.Push($item.FullName)}
  }
}
Write-Output 'PROTECTED_MACHINE_UPDATE_TREE'
`;

export function machineUpdateRootAuditSucceeded(input:{
  error?:Error|null;
  status:number|null;
  stdout:string|null;
}):boolean{
  return !input.error&&input.status===0&&
    input.stdout?.trim()==='PROTECTED_MACHINE_UPDATE_TREE';
}

/** Diagnostic only; not an approval for caller-selected roots. */
export function inspectExistingMachineUpdateTreeReadOnly(root:string):boolean{
  if(process.platform!=='win32')return false;
  if(!root||root.length>1024)return false;
  const command=Buffer.from(readOnlyAuditScript,'utf16le').toString('base64');
  const result=spawnSync(WINDOWS_POWERSHELL,[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command,
  ],{
    cwd:WINDOWS_SYSTEM32,
    env:isolatedMachineUpdateAuditEnv(root),
    shell:false,
    windowsHide:true,
    encoding:'utf8',
    timeout:120_000,
    maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe'],
  });
  return machineUpdateRootAuditSucceeded(result);
}

/** Fail closed BEFORE the first network/staging/ACL action on the machine
 * update root. Only a separate Administrator-owned installer can fix it. */
export function assertMachineUpdateTreeProtectedBeforeWrite():void{
  if(!inspectExistingMachineUpdateTreeReadOnly(TRUSTED_MACHINE_UPDATE_TREE)){
    throw new Error('MACHINE_UPDATE_UNPROTECTED_TREE: existing machine update root is not proven owner-protected, non-reparse and non-user-writable.');
  }
}
