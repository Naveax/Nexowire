import {promises as fs,constants as flags} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

const CUSTODY_ERROR='Cloudflare tunnel credential custody unsafe';
const MAX_CREDENTIAL_BYTES=16*1024;
export class CloudflareCredentialCustodyError extends Error {
  constructor(
    public readonly code:string='CUSTODY_UNSAFE',
    public readonly elapsedMs:number=0,
    public readonly childExitCode:number|null=null,
  ){
    super(CUSTODY_ERROR);
    this.name='CloudflareCredentialCustodyError';
  }
}
function deny(code='CUSTODY_UNSAFE'):never {throw new CloudflareCredentialCustodyError(code);}
function sameIdentity(a:import('node:fs').BigIntStats,b:import('node:fs').BigIntStats){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
async function parents(file:string){
  let current=path.dirname(file);
  const uid=BigInt(typeof process.getuid==='function'?process.getuid():-1);
  for(;;){
    const stat=await fs.lstat(current,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())deny();
    if(process.platform!=='win32'){
      if(stat.uid!==0n&&stat.uid!==uid)deny();
      const stickyRoot=stat.uid===0n&&(stat.mode&0o1000n)!==0n;
      if((stat.mode&0o022n)!==0n&&!stickyRoot)deny();
    }
    const next=path.dirname(current);
    if(next===current)break;
    current=next;
  }
}
/** Read-only SID and DACL verification. Failure reasons are fixed enums and
 * durations, not paths, SIDs, credentials, or raw PowerShell stderr.
 * An ordinary parent directory may allow creation but MUST NOT allow foreign
 * delete, replacement or permission ownership of the protected file.
 */
function windowsCredentialAcl(file:string){
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$stage='START'",
    "try {",
    "  $p=$env:NEXOWIRE_CUSTODY_PATH",
    "  $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  $trusted=@($me,'S-1-5-18','S-1-5-32-544')",
    "  $cur=[System.IO.Path]::GetFullPath($p)",
    "  $file=$true",
    "  $depth=0",
    "  while($true){",
    "    $stage='ITEM'",
    "    $item=Get-Item -LiteralPath $cur -Force -ErrorAction Stop",
    "    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){[Console]::Error.Write('C13:REPARSE');exit 21}",
    "    $stage='ACL'",
    "    $acl=Get-Acl -LiteralPath $cur -ErrorAction Stop",
    "    if($file){",
    "      $stage='OWNER'",
    "      $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
    "      if($owner -ne $me){[Console]::Error.Write('C13:FOREIGN_OWNER');exit 22}",
    "    }",
    "    $stage='ACE'",
    "    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){",
    "      if($ace.AccessControlType -ne 'Allow'){continue}",
    "      $sid=$ace.IdentityReference.Value",
    "      if($trusted -contains $sid){continue}",
    "      $rights=[int64]$ace.FileSystemRights",
    "      $read=[int64]0x120089",
    "      $fileMutate=[int64]0x2 -bor [int64]0x4 -bor [int64]0x10 -bor [int64]0x40 -bor [int64]0x100 -bor [int64]0x10000 -bor [int64]0x40000 -bor [int64]0x80000 -bor [int64]0x40000000 -bor [int64]0x10000000",
    "      $parentReplace=[int64]0x40 -bor [int64]0x10000 -bor [int64]0x40000 -bor [int64]0x80000 -bor [int64]0x40000000 -bor [int64]0x10000000",
    "      $danger=if($file){$read -bor $fileMutate}else{$parentReplace}",
    "      if(($rights -band $danger) -ne 0){",
    "        if($file){[Console]::Error.Write('C13:FILE_UNTRUSTED_ACE');exit 23}",
    "        [Console]::Error.Write('C13:PARENT_REPLACE_ACE');exit 24",
    "      }",
    "    }",
    "    $up=[IO.Directory]::GetParent($cur)",
    "    if($null -eq $up){break}",
    "    $cur=$up.FullName;$file=$false;$depth++",
    "    if($depth -gt 32){[Console]::Error.Write('C13:PARENT_DEPTH');exit 25}",
    "  }",
    "  [Console]::Out.Write('OK')",
    "} catch {",
    "  [Console]::Error.Write('C13:ERROR_'+$stage)",
    "  exit 29",
    "}",
  ].join('\n');
  const b64=Buffer.from(ps,'utf16le').toString('base64');
  const env={...windowsDpapiChildEnvironment(),NEXOWIRE_CUSTODY_PATH:file};
  const started=Date.now();
  const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',b64],
    {env,encoding:'utf8',timeout:45000,maxBuffer:4096,windowsHide:true});
  if(child.error||child.status!==0||child.stdout.trim()!=='OK'){
    const childCode=(child.error as NodeJS.ErrnoException|undefined)?.code;
    const marker=/C13:(REPARSE|FOREIGN_OWNER|FILE_UNTRUSTED_ACE|PARENT_REPLACE_ACE|PARENT_DEPTH|ERROR_(?:START|ITEM|ACL|OWNER|ACE))/.exec(child.stderr??'');
    const code=childCode==='ETIMEDOUT'?'POWERSHELL_51_TIMEOUT':
      childCode==='ENOBUFS'?'POWERSHELL_OUTPUT_BOUND':
      childCode?'POWERSHELL_SPAWN_'+(childCode==='ENOENT'?'MISSING':'FAILED'):
      marker?.[1]??(child.status===0?'INVALID_RESULT':'POWERSHELL_UNCLASSIFIED_EXIT');
    throw new CloudflareCredentialCustodyError(code,Date.now()-started,child.status);
  }
}
/** Open without following links; fstat and pathname identity must stay fixed. */
export async function readCloudflareTunnelCredential(file:string):Promise<Buffer>{
  if(!path.isAbsolute(file)||path.resolve(file)!==file||/[\r\n\0]/.test(file))deny();
  try{
    await parents(file);
    if(process.platform==='win32')windowsCredentialAcl(file);
    const prior=await fs.lstat(file,{bigint:true});
    if(!prior.isFile()||prior.isSymbolicLink()||prior.nlink!==1n||
       prior.size<1n||prior.size>BigInt(MAX_CREDENTIAL_BYTES))deny();
    if(process.platform!=='win32'){
      const uid=BigInt(typeof process.getuid==='function'?process.getuid():-1);
      if(prior.uid!==uid||(prior.mode&0o077n)!==0n)deny();
    }
    const fd=await fs.open(file,flags.O_RDONLY|(process.platform==='win32'?0:flags.O_NOFOLLOW));
    try{
      const opened=await fd.stat({bigint:true});
      if(!sameIdentity(prior,opened))deny();
      const data=await fd.readFile();
      if(BigInt(data.length)!==prior.size||data.length>MAX_CREDENTIAL_BYTES)deny();
      if(!sameIdentity(opened,await fd.stat({bigint:true}))||
         !sameIdentity(opened,await fs.lstat(file,{bigint:true})))deny();
      await parents(file);
      if(process.platform==='win32')windowsCredentialAcl(file);
      return data;
    }finally{await fd.close();}
  }catch(error){
    if(error instanceof CloudflareCredentialCustodyError)throw error;
    deny('CUSTODY_FILESYSTEM_REJECTED');
  }
}
