import {promises as fs,constants as flags} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

const CUSTODY_ERROR='Cloudflare tunnel credential custody unsafe';
const MAX_CREDENTIAL_BYTES=16*1024;
function deny():never {throw Error(CUSTODY_ERROR);}
function sameIdentity(a:import('node:fs').Stats,b:import('node:fs').Stats){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
}
async function parents(file:string){
  let current=path.dirname(file);
  const uid=typeof process.getuid==='function'?process.getuid():-1;
  for(;;){
    const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())deny();
    if(process.platform!=='win32'){
      if(stat.uid!==0&&stat.uid!==uid)deny();
      const stickyRoot=stat.uid===0&&(stat.mode&0o1000)!==0;
      if((stat.mode&0o022)!==0&&!stickyRoot)deny();
    }
    const next=path.dirname(current);
    if(next===current)break;
    current=next;
  }
}
/** Windows read-only SID/DACL audit; does not by itself guarantee launch identity. */
function windowsCredentialAcl(file:string){
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$p=$env:NEXOWIRE_CUSTODY_PATH",
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$trusted=@($me,'S-1-5-18','S-1-5-32-544')",
    "$cur=[System.IO.Path]::GetFullPath($p)",
    "$file=$true",
    "while($true){",
    "  $item=Get-Item -LiteralPath $cur -Force -ErrorAction Stop",
    "  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE'}",
    "  $acl=Get-Acl -LiteralPath $cur -ErrorAction Stop",
    "  if($file){",
    "    $owner=$acl.Owner",
    "    try{$owner=([Security.Principal.NTAccount]$owner).Translate([Security.Principal.SecurityIdentifier]).Value}catch{}",
    "    if($owner -ne $me){throw 'FOREIGN_OWNER'}",
    "  }",
    "  foreach($ace in $acl.Access){",
    "    if($ace.AccessControlType -ne 'Allow'){continue}",
    "    try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{throw 'UNRESOLVED_ACE'}",
    "    if($trusted -contains $sid){continue}",
    "    $rights=[int64]$ace.FileSystemRights",
    "    $read=[int64]0x120089",
    "    $mutate=[int64]0x2 -bor [int64]0x4 -bor [int64]0x10 -bor [int64]0x40 -bor [int64]0x100 -bor [int64]0x10000 -bor [int64]0x40000 -bor [int64]0x80000 -bor [int64]0x40000000 -bor [int64]0x10000000",
    "    $danger=if($file){$read -bor $mutate}else{$mutate}",
    "    if(($rights -band $danger) -ne 0){throw 'UNTRUSTED_ACE'}",
    "  }",
    "  $up=[IO.Directory]::GetParent($cur)",
    "  if($null -eq $up){break}",
    "  $cur=$up.FullName;$file=$false",
    "}",
    "[Console]::Out.Write('OK')",
  ].join('\n');
  const b64=Buffer.from(ps,'utf16le').toString('base64');
  const env={...windowsDpapiChildEnvironment(),NEXOWIRE_CUSTODY_PATH:file};
  const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',b64],
    {env,encoding:'utf8',timeout:25000,maxBuffer:1024,windowsHide:true});
  if(child.error||child.status!==0||child.stdout.trim()!=='OK')deny();
}
/** Open without following links; fstat and pathname identity must stay fixed. */
export async function readCloudflareTunnelCredential(file:string):Promise<Buffer>{
  if(!path.isAbsolute(file)||path.resolve(file)!==file||/[\r\n\0]/.test(file))deny();
  try{
    await parents(file);
    if(process.platform==='win32')windowsCredentialAcl(file);
    const prior=await fs.lstat(file);
    if(!prior.isFile()||prior.isSymbolicLink()||prior.nlink!==1||
       prior.size<1||prior.size>MAX_CREDENTIAL_BYTES)deny();
    if(process.platform!=='win32'){
      const uid=typeof process.getuid==='function'?process.getuid():-1;
      if(prior.uid!==uid||(prior.mode&0o077)!==0)deny();
    }
    const fd=await fs.open(file,flags.O_RDONLY|(process.platform==='win32'?0:flags.O_NOFOLLOW));
    try{
      const opened=await fd.stat();
      if(!sameIdentity(prior,opened))deny();
      const data=await fd.readFile();
      if(data.length!==prior.size||data.length>MAX_CREDENTIAL_BYTES)deny();
      if(!sameIdentity(opened,await fd.stat())||
         !sameIdentity(opened,await fs.lstat(file)))deny();
      await parents(file);
      if(process.platform==='win32')windowsCredentialAcl(file);
      return data;
    }finally{await fd.close();}
  }catch{deny();}
}
