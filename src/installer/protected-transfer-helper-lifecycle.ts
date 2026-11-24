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
  stage(sourcePath:string,pin:HelperPin,allowProvisionEmptyRoot:boolean):Promise<void>;
}
function pin(value:HelperPin):HelperPin {
  if(!value||typeof value.sha256!=='string'||value.sha256.length!==64||!sha.test(value.sha256)||
     typeof value.signerSha256!=='string'||value.signerSha256.length!==64||!sha.test(value.signerSha256))return deny('TRANSFER_HELPER_PIN_REQUIRED');
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
/** Read-only handoff to the protected publisher bootstrap. The caller must
 * keep an independent startup/selection lease until activation completes.
 * Double-read detects a changed selection; it does not create that lease. */
export async function readVerifiedTransferHelperBinding(authority:Pick<TransferHelperDeploymentAuthority,'readSelection'>,store:TransferHelperArtifactStore){
  const before=selection(await authority.readSelection());
  if(!before.pin)return deny('TRANSFER_HELPER_NOT_SELECTED');
  await store.verifyInstalled(before.pin);
  const after=selection(await authority.readSelection());
  if(after.revision!==before.revision||!samePin(after.pin,before.pin))return deny('TRANSFER_HELPER_SELECTION_CHANGED');
  return Object.freeze({revision:before.revision,flushHelper:installedTransferHelperPath(before.pin),
    flushHelperSha256:before.pin.sha256,flushHelperSignerSha256:before.pin.signerSha256});
}
function validate(input:HelperRequest):Readonly<HelperRequest>{
  if(!input||typeof input.requestId!=='string'||input.requestId.length!==36||!uuid.test(input.requestId))return deny('TRANSFER_HELPER_REQUEST_INVALID');
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
  let active=true,entered=false,dispatched=false,completed=false;
  let result:Readonly<{operation:HelperOperation;selection:HelperSelection;previous:HelperSelection;binariesRetained:true;userDataMutationRequested:false}>|undefined;
  const assertScope=()=>{
    if(!active)return deny(dispatched?'TRANSFER_HELPER_COMMIT_UNKNOWN':'TRANSFER_HELPER_DEPLOYMENT_LEASE_RELEASED');
  };
  try{
    await authority.withExclusiveQuiescedDeployment(req,async()=>{
      assertScope();
      if(entered)return deny('TRANSFER_HELPER_ADMISSION_REENTERED');
      entered=true;
      const current=selection(await authority.readSelection());
      assertScope();
      if(current.revision!==req.expected.revision||!samePin(current.pin,req.expected.pin))return deny('TRANSFER_HELPER_STALE_SELECTION');
      if(current.pin&&req.operation==='upgrade'){
        await store.verifyInstalled(current.pin);
        assertScope();
      }
      if(req.desired){
        if(req.sourcePath!==undefined){
          await store.stage(req.sourcePath,req.desired,req.operation==='clean-install');
          assertScope();
        }
        await store.verifyInstalled(req.desired);
        assertScope();
      }
      // A premature return from a faulty authority cannot initiate a later
      // commit after an awaited staging/verification step has completed.
      assertScope();
      dispatched=true;
      let outcome:HelperCommit;
      try{outcome=await authority.commitSelection(req);}catch{return deny('TRANSFER_HELPER_COMMIT_UNKNOWN');}
      assertScope();
      if(outcome==='REJECTED')return deny('TRANSFER_HELPER_COMMIT_REJECTED');
      if(outcome!=='COMMITTED')return deny('TRANSFER_HELPER_COMMIT_UNKNOWN');
      let after:HelperSelection;
      try{after=selection(await authority.readSelection());}catch{return deny('TRANSFER_HELPER_COMMIT_READBACK_UNKNOWN');}
      assertScope();
      if(after.revision===current.revision||!samePin(after.pin,req.desired))return deny('TRANSFER_HELPER_COMMIT_READBACK_UNKNOWN');
      result=Object.freeze({operation:req.operation,selection:after,previous:current,binariesRetained:true,userDataMutationRequested:false});
      completed=true;
      return result;
    });
    // Never return a result manufactured by the authority instead of the
    // actual callback. Once commit was dispatched, loss of scope is UNKNOWN.
    if(!entered||!completed||!result)return deny(dispatched?'TRANSFER_HELPER_COMMIT_UNKNOWN':'TRANSFER_HELPER_ADMISSION_UNCONFIRMED');
    return result;
  }finally{active=false;}
}

const run=promisify(execFile);
const MAX_BYTES=8*1024*1024;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Fixed path; no caller-controlled shell text or ACL changes to existing roots.
const provisionScript=String.raw`
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Nexowire-TransferRuntime'
$parent=[IO.DirectoryInfo]::new('C:\ProgramData')
if(-not $parent.Exists -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'TRANSFER_HELPER_ROOT_PARENT_UNTRUSTED'}
if([IO.Directory]::Exists($root) -or [IO.File]::Exists($root)){throw 'TRANSFER_HELPER_ROOT_ALREADY_EXISTS'}
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.SetOwner($admin)
foreach($sid in @($admin,$system)){
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
# .NET Framework's security-descriptor overload applies the private ACL at
# directory creation, never creates a user-writable staging namespace.
[void][IO.Directory]::CreateDirectory($root,$acl)
Write-Output 'TRANSFER_HELPER_ROOT_PROVISIONED_VERIFY_REQUIRED'
`;
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
  if(!/^[A-Za-z]:\\/.test(file)||file!==path.win32.resolve(file)||file.includes('/')||file.slice(2).includes(':')||
     file.split('\\').slice(1).some(part=>!part||/[. ]$/.test(part)||/[\x00-\x1f]/.test(part)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))return deny('TRANSFER_HELPER_PATH_INVALID');
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
/** Real Windows storage adapter. An independently witnessed trusted signed
 * runtime is prerequisite. Only clean-install can provision a
 * missing fixed root with a private ACL at creation. No ACL repair, auto-elevation,
 * helper execution, remote download, active-pointer file or key access. */
export function createWindowsTransferHelperArtifactStore(assertInstalledRuntime:()=>Promise<void>):TransferHelperArtifactStore{
  if(process.platform!=='win32'||typeof assertInstalledRuntime!=='function')return deny('TRANSFER_HELPER_WINDOWS_RUNTIME_REQUIRED');
  async function runtime(){
    assertNoPrivilegedNodeStartupFlags(process.execArgv);
    assertWindowsPrivilegedRuntimeTrusted({executable:process.execPath,cliEntrypoint:process.argv[1]??'',env:process.env});
    await assertInstalledRuntime();
  }
  async function root(allowProvision=false){
    await runtime();
    verifyWindowsStackOuterAncestorAcl('C:\\');
    verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
    try{await fs.lstat(TRANSFER_HELPER_ROOT);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT'||!allowProvision)throw error;
      const result=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
        '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(provisionScript,'utf16le').toString('base64'),
      ],{cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(),windowsHide:true,timeout:30000,maxBuffer:16384});
      if(result.stderr.trim()||result.stdout.trim()!=='TRANSFER_HELPER_ROOT_PROVISIONED_VERIFY_REQUIRED')return deny('TRANSFER_HELPER_ROOT_PROVISION_UNVERIFIED');
    }
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
    async stage(sourcePath:string,value:HelperPin,allowProvisionEmptyRoot:boolean){
      const p=pin(value);await runtime();
      // Verify the signed offline input before creating even a fresh root.
      const bytes=await verifiedBytes(sourcePath,p,false);
      await root(allowProvisionEmptyRoot===true);
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
