import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeTransferPublisher,type NativeTransferAdmission} from './native-transfer-publisher.js';
import {verifyWindowsPrivateAcl,verifyWindowsStackOuterAncestorAcl,protectedWindowsAclEnvironment} from '../security/windows-programdata-acl.js';
import {inspectProtectedSecretFile,readProtectedSecretFile} from '../security/protected-secret-files.js';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted} from '../security/windows-privileged-runtime-trust.js';
import type {LargeTransferBinding} from '../mcp/durable-large-transfer.js';
import {ProtectedTransferReceiptStore} from './protected-transfer-receipt-store.js';

const run=promisify(execFile),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const deny=(code:string):never=>{throw Error(code);};
const PURPOSE='native-transfer-ed25519-signer-v1';
export function canonicalProtectedTransferPath(input:string):string{
  if(typeof input!=='string'||!/^C:\\ProgramData\\/i.test(input)||
     input!==path.win32.resolve(input)||input.includes('/')||input.slice(2).includes(':')||
     input.split('\\').slice(1).some(s=>!s||/[. ]$/.test(s)||/[\x00-\x1f<>:"/|?*]/.test(s)||/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(s)))return deny('WINDOWS_TRANSFER_PATH_DENIED');
  return input;
}
async function protectedExisting(input:string,kind:'file'|'directory'){
  const target=canonicalProtectedTransferPath(input);
  if((await fs.realpath(target)).toLowerCase()!==target.toLowerCase())deny('WINDOWS_TRANSFER_REPARSE_DENIED');
  const s=await fs.lstat(target,{bigint:true});
  if(kind==='file'&&(!s.isFile()||s.nlink!==1n)||kind==='directory'&&!s.isDirectory())deny('WINDOWS_TRANSFER_PATH_DENIED');
  for(let cursor=target;cursor.toLowerCase()!=='c:\\programdata';cursor=path.win32.dirname(cursor))verifyWindowsPrivateAcl(cursor);
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');verifyWindowsStackOuterAncestorAcl('C:\\');
  return target;
}
const SIGNATURE_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_PROTECTED_ACL_TARGET
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'SIGNATURE_INVALID'}
$h=[System.Security.Cryptography.SHA256]::Create()
try{[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
`;
/** Exact installed helper and signer pins are provisioned by the independent
 * deployment authority, never by a Hub request or environment variable. */
async function trustedFlushHelper(file:string,blobSha256:string,signerSha256:string){
  if(!sha.test(blobSha256)||!sha.test(signerSha256))deny('WINDOWS_TRANSFER_HELPER_PIN_REQUIRED');
  await protectedExisting(file,'file');
  const st=await fs.stat(file);if(st.size<1||st.size>8*1024*1024)deny('WINDOWS_TRANSFER_HELPER_SIZE_INVALID');
  if(createHash('sha256').update(await fs.readFile(file)).digest('hex')!==blobSha256)deny('WINDOWS_TRANSFER_HELPER_HASH_INVALID');
  const result=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(SIGNATURE_SCRIPT,'utf16le').toString('base64')],{cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(file),windowsHide:true,timeout:20000,maxBuffer:16384});
  if(result.stderr.trim()||result.stdout.trim()!==signerSha256)deny('WINDOWS_TRANSFER_HELPER_SIGNATURE_INVALID');
}
export interface WindowsProtectedTransferConfig {
  deviceId:string;targetRoot:string;receiptRoot:string;signerEnvelope:string;enrolledPublicKeySha256:string;
  flushHelper:string;flushHelperSha256:string;flushHelperSignerSha256:string;
  /** Independent authority must serialize grant/STOP/revoke, original intent,
   * offset and namespace exclusion throughout the callback. */
  authority:Pick<NativeTransferAdmission,'admit'>;
  /** Native bootstrap/installed-signer witness, not an MCP input. */
  assertInstalledRuntime:()=>Promise<void>;
}
/** Production composition for the intentionally narrow private C: NTFS root.
 * No directory creation, ACL weakening, key generation, helper download or
 * elevation. All assets must already be independently installed/enrolled. */
export async function createWindowsProtectedTransferPublisher(config:Readonly<WindowsProtectedTransferConfig>){
  if(process.platform!=='win32'||!config.deviceId||typeof config.authority?.admit!=='function'||typeof config.assertInstalledRuntime!=='function')deny('WINDOWS_TRANSFER_PROTECTED_BOOTSTRAP_REQUIRED');
  const c=Object.freeze({...config});
  assertNoPrivilegedNodeStartupFlags(process.execArgv);
  assertWindowsPrivilegedRuntimeTrusted({executable:process.execPath,cliEntrypoint:process.argv[1]??'',env:process.env});
  await c.assertInstalledRuntime();
  const targetRoot=await protectedExisting(c.targetRoot,'directory'),receiptRoot=await protectedExisting(c.receiptRoot,'directory');
  const inside=(root:string,file:string)=>file.toLowerCase()===root.toLowerCase()||file.toLowerCase().startsWith(root.toLowerCase()+'\\');
  if(inside(targetRoot,receiptRoot)||inside(receiptRoot,targetRoot)||[c.signerEnvelope,c.flushHelper].some(file=>inside(targetRoot,file)||inside(receiptRoot,file)))deny('WINDOWS_TRANSFER_ROOTS_NOT_SEPARATE');
  await protectedExisting(c.signerEnvelope,'file');
  if(inspectProtectedSecretFile(c.signerEnvelope).protection!=='windows-dpapi-current-user')deny('WINDOWS_TRANSFER_SIGNER_SCOPE_INVALID');
  const key=createPrivateKey(readProtectedSecretFile(c.signerEnvelope,PURPOSE,'Protected Native transfer signer',{allowMultiline:true}));
  const pub=createPublicKey(key);
  if(key.asymmetricKeyType!=='ed25519'||!sha.test(c.enrolledPublicKeySha256)||createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex')!==c.enrolledPublicKeySha256)deny('WINDOWS_TRANSFER_SIGNER_NOT_ENROLLED');
  await trustedFlushHelper(c.flushHelper,c.flushHelperSha256,c.flushHelperSignerSha256);
  const flush=async(dir:string)=>{
    if(![targetRoot,receiptRoot].includes(dir))deny('WINDOWS_TRANSFER_FLUSH_SCOPE_DENIED');
    await protectedExisting(dir,'directory');
    await trustedFlushHelper(c.flushHelper,c.flushHelperSha256,c.flushHelperSignerSha256);
    const r=await run(c.flushHelper,[dir],{cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(),windowsHide:true,timeout:30000,maxBuffer:1024});
    if(r.stderr.trim()||r.stdout.trim()!=='NEXOWIRE_NTFS_VOLUME_FLUSH_OK')deny('WINDOWS_TRANSFER_FLUSH_UNVERIFIED');
  };
  const receipts=new ProtectedTransferReceiptStore(receiptRoot,pub,flush);
  const paths=async(b:Readonly<LargeTransferBinding>)=>{
    if(b.targetDeviceId!==c.deviceId||!uuid.test(b.id)||canonicalProtectedTransferPath(b.targetPath)!==b.targetPath||canonicalProtectedTransferPath(b.stagePath)!==b.stagePath||
      path.win32.dirname(b.targetPath)!==targetRoot||path.win32.dirname(b.stagePath)!==targetRoot||b.stagePath!==b.targetPath+'.nexowire-upload-'+b.id+'.part')deny('WINDOWS_TRANSFER_PATH_DENIED');
    await protectedExisting(targetRoot,'directory');
    // The authority holds protected namespace exclusion here. Reject existing
    // aliases and hardlinks; absent names may only be created exclusively.
    for(const file of [b.stagePath,b.targetPath]){try{await fs.lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}await protectedExisting(file,'file');}
    return {stage:b.stagePath,target:b.targetPath};
  };
  const publisher=new NativeTransferPublisher(c.deviceId,{
    admit:(b,l,p,effect)=>c.authority.admit(b,l,p,effect),
    resolveProtectedPaths:paths,flushDirectory:flush,
    async signFinal(data){return sign(null,data,key).toString('base64url');},
    persistFinalReceipt:(b,p,r)=>receipts.persist(b,p,r),
  });
  // Read-only recovery still needs current authenticated external grant before
  // the independent service calls this private lookup. Never expose as MCP.
  return Object.freeze({publisher,receipts});
}
