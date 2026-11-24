import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {protectedWindowsAclEnvironment,verifyWindowsPrivateAcl,verifyWindowsStackOuterAncestorAcl} from '../security/windows-programdata-acl.js';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted} from '../security/windows-privileged-runtime-trust.js';

/** Private binary-only namespace. Never store owner keys, receipts or databases here. */
export const TRANSFER_HELPER_ROOT='C:\\ProgramData\\Nexowire-TransferRuntime';
const sha=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deny=(code:string):never=>{throw new Error(code);};
export type HelperPin=Readonly<{sha256:string;signerSha256:string}>;
export type HelperSelection=Readonly<{revision:string;pin:HelperPin|null}>;
export type HelperOperation='clean-install'|'upgrade'|'uninstall'|'rollback';
export type HelperRequest=Readonly<{requestId:string;operation:HelperOperation;expected:HelperSelection;desired:HelperPin|null;sourcePath?:string}>;
export type HelperCommit='COMMITTED'|'REJECTED'|'UNKNOWN';
/** Authority must admit the original authenticated local deployment intent,
 * fence STOP/revoke, quiesce native use, exclude concurrent deployment,
 * and atomically CAS the durable selection. No auto retry on UNKNOWN.
 * This interface does not itself implement or confer that authority. */
export interface TransferHelperDeploymentAuthority {
  withExclusiveQuiescedDeployment<T>(request:Readonly<HelperRequest>,effect:()=>Promise<T>):Promise<T>;
  readSelection():Promise<HelperSelection>;
  commitSelection(request:Readonly<HelperRequest>):Promise<HelperCommit>;
}
export interface TransferHelperArtifactStore {
  verifyInstalled(pin:HelperPin):Promise<void>;
  stage(sourcePath:string,pin:HelperPin):Promise<void>;
}
function pin(value:HelperPin):HelperPin {
  if(!value||!sha.test(value.sha256)||!sha.test(value.signerSha256))return deny('TRANSFER_HELPER_PIN_REQUIRED');
  return Object.freeze({sha256:value.sha256,signerSha256:value.signerSha256});
}
function selection(value:HelperSelection):HelperSelection {
  if(!value||typeof value.revision!=='string'||!value.revision||value.revision.length>128||value.pin===undefined)return deny('TRANSFER_HELPER_SELECTION_INVALID');
  return Object.freeze({revision:value.revision,pin:value.pin===null?null:pin(value.pin)});
}
function samePin(a:HelperPin|null,b:HelperPin|null):boolean {
  return a===null||b===null?a===b:a.sha256===b.sha256&&a.signerSha256===b.signerSha256;
}
export function installedTransferHelperPath(value:HelperPin):string {
  return path.win32.join(TRANSFER_HELPER_ROOT,'windows-transfer-volume-flush-'+pin(value).sha256+'.exe');
}
function validate(input:HelperRequest):Readonly<HelperRequest>{
  if(!input||!uuid.test(input.requestId))return deny('TRANSFER_HELPER_REQUEST_INVALID');
  const expected=selection(input.expected),desired=input.desired===null?null:pin(input.desired);
  const source=input.sourcePath;
  switch(input.operation){
    case 'clean-install':
      if(expected.pin!==null||!desired||typeof source!=='string'||!source)return deny('TRANSFER_HELPER_CLEAN_INSTALL_INVALID');
      break;
    case 'upgrade':
      if(!expected.pin||!desired||samePin(expected.pin,desired)||typeof source!=='string'||!source)return deny('TRANSFER_HELPER_UPGRADE_INVALID');
      break;
    case 'rollback':
      if(!expected.pin||!desired||samePin(expected.pin,desired)||source!==undefined)return deny('TRANSFER_HELPER_ROLLBACK_INVALID');
      break;
    case 'uninstall':
      if(!expected.pin||desired!==null||source!==undefined)return deny('TRANSFER_HELPER_UNINSTALL_INVALID');
      break;
    default:return deny('TRANSFER_HELPER_OPERATION_INVALID');
  }
  return Object.freeze({requestId:input.requestId,operation:input.operation,expected,desired,...(source===undefined?{}:{sourcePath:source})});
}
/** Changes only the externally governed selection. Uninstall is a detach,
 * deliberately retains signed binaries for explicit rollback and never deletes
 * user files, secrets, SQLite, receipts or ambiguous staging artifacts. */
export async function runTransferHelperLifecycle(input:HelperRequest,authority:TransferHelperDeploymentAuthority,store:TransferHelperArtifactStore){
  const req=validate(input);
  return authority.withExclusiveQuiescedDeployment(req,async()=>{
    const current=selection(await authority.readSelection());
    if(current.revision!==req.expected.revision||!samePin(current.pin,req.expected.pin))return deny('TRANSFER_HELPER_STALE_SELECTION');
    if(current.pin)await store.verifyInstalled(current.pin);
    if(req.desired){
      if(req.sourcePath!==undefined)await store.stage(req.sourcePath,req.desired);
      await store.verifyInstalled(req.desired);
    }
    // Once dispatch starts, exceptions or UNKNOWN never cause another commit,
    // rollback, deletion or a fabricated success receipt.
    let outcome:HelperCommit;
    try{outcome=await authority.commitSelection(req);}catch{return deny('TRANSFER_HELPER_COMMIT_UNKNOWN');}
    if(outcome==='REJECTED')return deny('TRANSFER_HELPER_COMMIT_REJECTED');
    if(outcome!=='COMMITTED')return deny('TRANSFER_HELPER_COMMIT_UNKNOWN');
    let after:HelperSelection;
    try{after=selection(await authority.readSelection());}catch{return deny('TRANSFER_HELPER_COMMIT_READBACK_UNKNOWN');}
    if(after.revision===current.revision||!samePin(after.pin,req.desired))return deny('TRANSFER_HELPER_COMMIT_READBACK_UNKNOWN');
    return Object.freeze({operation:req.operation,selection:after,previous:current,binariesRetained:true,userDataChanged:false});
  });
}

const run=promisify(execFile);
const MAX_BYTES=8*1024*1024;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const signatureScript=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_PROTECTED_ACL_TARGET
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'INVALID_SIGNATURE'}
$h=[Security.Cryptography.SHA256]::Create()
try{[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
`;
async function inspectPlainFile(file:string,protectedFile:boolean){
  if(!/^[A-Za-z]:\\/.test(file)||file!==path.win32.resolve(file)||file.includes('/')||file.slice(2).includes(':'))return deny('TRANSFER_HELPER_PATH_INVALID');
  const stat=await fs.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size<1n||stat.size>BigInt(MAX_BYTES)||
      (await fs.realpath(file)).toLowerCase()!==file.toLowerCase())return deny('TRANSFER_HELPER_FILE_UNTRUSTED');
  // Realpath alone cannot detect every junction alias. Inspect all parents.
  for(let cursor=path.win32.dirname(file);;cursor=path.win32.dirname(cursor)){
    const parent=await fs.lstat(cursor);
    if(!parent.isDirectory()||parent.isSymbolicLink()||(await fs.realpath(cursor)).toLowerCase()!==cursor.toLowerCase())return deny('TRANSFER_HELPER_ANCESTOR_UNTRUSTED');
    if(cursor===path.win32.dirname(cursor))break;
  }
  if(protectedFile)verifyWindowsPrivateAcl(file);
  return stat;
}
async function verifiedBytes(file:string,p:HelperPin,protectedFile:boolean):Promise<Buffer>{
  const before=await inspectPlainFile(file,protectedFile);
  const handle=await fs.open(file,'r');
  let bytes:Buffer;
  try{
    const actual=await handle.stat({bigint:true});
    if(actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size||actual.nlink!==1n)return deny('TRANSFER_HELPER_FILE_CHANGED');
    bytes=Buffer.alloc(Number(actual.size));
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead!==bytes.length||digest(bytes)!==p.sha256)return deny('TRANSFER_HELPER_HASH_INVALID');
  }finally{await handle.close();}
  const sig=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(signatureScript,'utf16le').toString('base64'),
  ],{cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(file),windowsHide:true,timeout:20000,maxBuffer:16384});
  if(sig.stderr.trim()||sig.stdout.trim()!==p.signerSha256)return deny('TRANSFER_HELPER_SIGNATURE_INVALID');
  const after=await inspectPlainFile(file,protectedFile);
  if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)return deny('TRANSFER_HELPER_FILE_CHANGED');
  return bytes;
}
/** Real Windows storage adapter. An independently installed private root and
 * trusted signed runtime are prerequisites. No ACL repair, auto-elevation,
 * helper execution, remote download, active-pointer file or key access. */
export function createWindowsTransferHelperArtifactStore(assertInstalledRuntime:()=>Promise<void>):TransferHelperArtifactStore{
  if(process.platform!=='win32'||typeof assertInstalledRuntime!=='function')return deny('TRANSFER_HELPER_WINDOWS_RUNTIME_REQUIRED');
  async function root(){
    assertNoPrivilegedNodeStartupFlags(process.execArgv);
    assertWindowsPrivilegedRuntimeTrusted({executable:process.execPath,cliEntrypoint:process.argv[1]??'',env:process.env});
    await assertInstalledRuntime();
    const stat=await fs.lstat(TRANSFER_HELPER_ROOT);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(await fs.realpath(TRANSFER_HELPER_ROOT)).toLowerCase()!==TRANSFER_HELPER_ROOT.toLowerCase())return deny('TRANSFER_HELPER_ROOT_UNTRUSTED');
    verifyWindowsStackOuterAncestorAcl('C:\\');
    verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
    verifyWindowsPrivateAcl(TRANSFER_HELPER_ROOT);
  }
  async function verifyInstalled(value:HelperPin){
    const p=pin(value);await root();await verifiedBytes(installedTransferHelperPath(p),p,true);
  }
  return Object.freeze({
    verifyInstalled,
    async stage(sourcePath:string,value:HelperPin){
      const p=pin(value);await root();
      const bytes=await verifiedBytes(sourcePath,p,false);
      const dest=installedTransferHelperPath(p);
      await root();
      let file;
      try{file=await fs.open(dest,'wx');}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        // Never overwrite or repair an existing ambiguous/corrupt artifact.
        await verifyInstalled(p);return;
      }
      try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
      // An incomplete or ACL-untrusted file is deliberately retained but can
      // never be selected. No cleanup of uncertain namespace state.
      await verifyInstalled(p);
    },
  });
}
