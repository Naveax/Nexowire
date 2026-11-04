import {promises as fs,constants as flags} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

const LIMIT=256*1024*1024;
/** Independently reviewed official cloudflare/cloudflared 2026.10.1 release
 * artifact SHA256; the owner-controlled profile is not a trust root.
 * Updating this allowlist requires source review and exact release provenance. */
export const OFFICIAL_CLOUDFLARED_SHA256=Object.freeze({
  'linux-x64':'3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586',
  'win32-x64':'4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
});
const sha256=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function sameFile(a:import('node:fs').BigIntStats,b:import('node:fs').BigIntStats){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
function deny(message:string):never{throw Error(message);}
export interface TrustedCloudflared{
  /** Linux-only executable file descriptor; NEVER reopen profile.binary to exec. */
  command:string;
  imageFd:number;
  dispose():Promise<void>;
}
/** Only bounded, non-secret diagnostic classes are exposed to tests. */
export class CloudflaredPublisherAuditError extends Error{
  constructor(
    public readonly reason:string,
    public readonly childExitCode:number|null,
    public readonly elapsedMs:number,
  ){
    super('Cloudflared publisher/signature provenance rejected');
    this.name='CloudflaredPublisherAuditError';
  }
}
/** Windows read-only publisher audit. No certificate or credential is logged.
 * The independent official SHA pin remains mandatory. This is not a native
 * image handle/section identity proof and never authorizes CreateProcess.
 */
function windowsPublisherSignature(file:string){
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$stage='START'",
    "try {",
    "  $path=$env:NEXOWIRE_CLOUDFLARED_IMAGE",
    "  $stage='ITEM'",
    "  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop",
    "  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){[Console]::Error.Write('C13:REPARSE');exit 21}",
    "  $stage='SIGNATURE'",
    "  $sig=Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop",
    "  if($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate){[Console]::Error.Write('C13:INVALID_SIGNATURE');exit 22}",
    "  $stage='PUBLISHER'",
    "  if($sig.SignerCertificate.Subject -notmatch 'Cloudflare'){[Console]::Error.Write('C13:WRONG_PUBLISHER');exit 23}",
    "  [Console]::Out.Write('OK')",
    "} catch {",
    "  [Console]::Error.Write('C13:ERROR_'+$stage)",
    "  exit 29",
    "}",
  ].join('\\n');
  const started=Date.now();
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:25000,maxBuffer:4096,
      env:{...windowsDpapiChildEnvironment(),NEXOWIRE_CLOUDFLARED_IMAGE:file}});
  if(result.error||result.status!==0||result.stdout.trim()!=='OK'){
    const childCode=(result.error as NodeJS.ErrnoException|undefined)?.code;
    const marker=/C13:(REPARSE|INVALID_SIGNATURE|WRONG_PUBLISHER|ERROR_(?:START|ITEM|SIGNATURE|PUBLISHER))/.exec(result.stderr??'');
    const reason=childCode==='ETIMEDOUT'?'POWERSHELL_51_TIMEOUT':
      childCode==='ENOBUFS'?'POWERSHELL_OUTPUT_BOUND':
      childCode?'POWERSHELL_SPAWN_'+(childCode==='ENOENT'?'MISSING':'FAILED'):
      marker?.[1]??(result.status===0?'INVALID_RESULT':'POWERSHELL_UNCLASSIFIED_EXIT');
    throw new CloudflaredPublisherAuditError(reason,result.status,Date.now()-started);
  }
}
/** Trust verified bytes and execute via an inherited descriptor on Linux.
 * Windows intentionally denies execution until a native immutable-image
 * launch helper supplies held file/section identity and OS signature readback. */
export async function prepareTrustedCloudflared(binary:string,profileDigest:string):Promise<TrustedCloudflared>{
  const expected=OFFICIAL_CLOUDFLARED_SHA256[
    (process.platform+'-'+process.arch) as keyof typeof OFFICIAL_CLOUDFLARED_SHA256];
  if(!expected)deny('Cloudflared platform has no approved official binary provenance');
  if(!path.isAbsolute(binary)||path.resolve(binary)!==binary||/[\r\n\0]/.test(binary))
    deny('Cloudflared binary must have an absolute safe path');
  const original=await fs.lstat(binary,{bigint:true});
  if(!original.isFile()||original.isSymbolicLink()||original.nlink!==1n||
     original.size<1n||original.size>BigInt(LIMIT))
    deny('Cloudflared binary path, hardlink or size is unsafe');
  const source=await fs.open(binary,flags.O_RDONLY|(process.platform==='win32'?0:flags.O_NOFOLLOW));
  let bytes:Buffer;
  try{
    if(!sameFile(original,await source.stat({bigint:true})))
      deny('Cloudflared binary changed during verification');
    bytes=await source.readFile();
    if(BigInt(bytes.length)!==original.size||!sameFile(original,await source.stat({bigint:true})))
      deny('Cloudflared binary changed while reading');
  }finally{await source.close();}
  const digest=sha256(bytes);
  if(digest!==profileDigest)deny('Cloudflare connector binary checksum mismatch');
  if(digest!==expected)deny('Cloudflared publisher/provenance rejected: not an approved official release');
  // A profile-selected pathname or another file with the same owner is NEVER
  // used for execution. Trust originates from the reviewed official digest.
  if(process.platform==='win32'){
    windowsPublisherSignature(binary);
    deny('Cloudflared Windows immutable image launch requires native signed handle custodian');
  }
  return stageDescriptorBoundImage(bytes,expected,true);
}

/** Standalone low-level launch primitive for disposable tests; callers must
 * independently authorize provenance before invoking this primitive. */
export async function stageDescriptorBoundImage(bytes:Buffer,expectedDigest:string,unlinkAfterSeal=false):Promise<TrustedCloudflared>{
  if(process.platform!=='linux')
    deny('Cloudflared immutable file-descriptor launch is unavailable on this platform');
  if(bytes.length<1||bytes.length>LIMIT||sha256(bytes)!==expectedDigest)
    deny('Cloudflared staging input digest rejected');
  let directory:string|undefined;
  let descriptor:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-cloudflared-sealed-'));
    await fs.chmod(directory,0o700);
    const stage=path.join(directory,'cloudflared');
    const out=await fs.open(stage,flags.O_CREAT|flags.O_EXCL|flags.O_WRONLY|flags.O_NOFOLLOW,0o600);
    try{await out.writeFile(bytes);await out.sync();}finally{await out.close();}
    await fs.chmod(stage,0o500);
    descriptor=await fs.open(stage,flags.O_RDONLY|flags.O_NOFOLLOW);
    const observed=await descriptor.stat({bigint:true});
    const named=await fs.lstat(stage,{bigint:true});
    const dirStat=await fs.lstat(directory,{bigint:true});
    const uid=BigInt(typeof process.getuid==='function'?process.getuid():-1);
    if(!observed.isFile()||observed.nlink!==1n||observed.uid!==uid||
       (observed.mode&0o222n)!==0n||!sameFile(observed,named)||
       !dirStat.isDirectory()||dirStat.isSymbolicLink()||dirStat.uid!==uid||
       (dirStat.mode&0o077n)!==0n)
      deny('Cloudflared sealed staging custody rejected');
    const verified=await descriptor.readFile();
    if(sha256(verified)!==expectedDigest||!sameFile(observed,await descriptor.stat({bigint:true})))
      deny('Cloudflared staged image verification failed');
    // Production unlinks the verified stage immediately: only the open FD
    // remains and a pathname/hardlink cannot be swapped in before exec.
    if(unlinkAfterSeal){await fs.unlink(stage);await fs.rmdir(directory);}
    // Inherited fd 3 names the already-open inode in the child. Renaming or
    // replacing a test-stage pathname cannot redirect execve to another image.
    const retained=descriptor;const ownedDirectory=unlinkAfterSeal?undefined:directory;
    return {command:'/proc/self/fd/3',imageFd:retained.fd,
      dispose:async()=>{try{await retained.close();}
        finally{if(ownedDirectory)await fs.rm(ownedDirectory,{recursive:true,force:true});}}};
  }catch(error){
    await descriptor?.close().catch(()=>{});
    if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}
