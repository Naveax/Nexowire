import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {protectedWindowsAclEnvironment,verifyWindowsPrivateAcl,verifyWindowsStackOuterAncestorAcl}
  from './windows-programdata-acl.js';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted}
  from './windows-privileged-runtime-trust.js';
import {createProtectedOwnerConsentAuthority,type ProtectedOwnerAssertionLauncher}
  from './protected-owner-consent-authority.js';

const run=promisify(execFile);
const SYSTEM32='C:\\Windows\\System32';
const POWERSHELL=SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const LAUNCHER='windows-core-owner-launcher.exe',HELPER='windows-core-webauthn-approval.exe';
const sha=/^[a-f0-9]{64}$/;
const deny=(code:string):never=>{throw Error('CORE_OWNER_LAUNCHER_'+code)};
export interface WindowsOwnerLauncherPins{
  readonly launcherPath:string;
  readonly launcherSha256:string;readonly launcherSignerSha256:string;
  readonly helperSha256:string;readonly helperSignerSha256:string;
}
/** The protected installer, never a request, provides exact artifact pins.
 * Only a pre-existing private C: ProgramData path is supported in v1.
 * No path discovery, installation, UAC, runas or fallback to user code. */
export function validateWindowsOwnerLauncherPins(input:WindowsOwnerLauncherPins){
  const c=Object.freeze({...input});
  if(typeof c.launcherPath!=='string'||!/^C:\\ProgramData\\/i.test(c.launcherPath)||
    c.launcherPath!==path.win32.resolve(c.launcherPath)||
    path.win32.basename(c.launcherPath)!==LAUNCHER||c.launcherPath.includes('/')||
    c.launcherPath.slice(2).includes(':')||c.launcherPath.length>240||
    c.launcherPath.split('\\').slice(1).some(x=>!x||/[. ]$/.test(x)||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x))||
    ![c.launcherSha256,c.launcherSignerSha256,c.helperSha256,c.helperSignerSha256].every(x=>typeof x==='string'&&sha.test(x)))
    deny('PROTECTED_PINS_REQUIRED');
  return c;
}
async function exactFile(file:string,digest:string){
  const real=await fs.realpath(file),before=await fs.lstat(file,{bigint:true});
  if(real.toLowerCase()!==file.toLowerCase()||!before.isFile()||before.nlink!==1n||
    before.size<1n||before.size>8388608n)deny('FILE_UNVERIFIED');
  const bytes=await fs.readFile(file);
  const after=await fs.lstat(file,{bigint:true});
  if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||
    before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||
    createHash('sha256').update(bytes).digest('hex')!==digest)deny('FILE_CHANGED');
}
const SIGNATURE=String.raw`
$ErrorActionPreference='Stop'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop
$s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_PROTECTED_ACL_TARGET
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'SIGNATURE_INVALID'}
$h=[Security.Cryptography.SHA256]::Create()
try{[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
`;
async function signature(file:string,digest:string){
  const r=await run(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(SIGNATURE,'utf16le').toString('base64')],{
    cwd:SYSTEM32,env:protectedWindowsAclEnvironment(file),windowsHide:true,timeout:20000,maxBuffer:8192});
  if(r.stderr.trim()||r.stdout.trim()!==digest)deny('SIGNATURE_UNVERIFIED');
}
function auditPaths(launcher:string,helper:string){
  for(const file of [launcher,helper]){
    for(let cursor=file;cursor.toLowerCase()!=='c:\\programdata';cursor=path.win32.dirname(cursor))
      verifyWindowsPrivateAcl(cursor);
  }
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsStackOuterAncestorAcl('C:\\');
}
type Ceremony=Parameters<ProtectedOwnerAssertionLauncher['runBoundAssertion']>[0];
/** Build only the fixed command from the ledger-issued intent, with strict
 * scope matching against the independently provisioned owner object. */
export function windowsOwnerLauncherArguments(input:Ceremony,pins:WindowsOwnerLauncherPins):readonly string[]{
  const c=validateWindowsOwnerLauncherPins(pins),a=input.args,b=input.owner.binding;
  const credential=Buffer.from(input.owner.credentialId,'base64url');
  if(input.helper!==HELPER||a.length!==7||a[0]!=='--assert-bound'||a[1]!==input.owner.rpId||
    !/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/.test(a[1]??'')||
    !sha.test(a[2]??'')||credential.length<1||credential.length>1024||
    credential.toString('base64url')!==input.owner.credentialId||a[3]!==credential.toString('hex')||
    a[4]!==b.windowsUserSid||!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(a[4]??'')||
    !Number.isInteger(b.windowsSessionId)||b.windowsSessionId<1||b.windowsSessionId>0xfffffffe||
    a[5]!==String(b.windowsSessionId)||a[6]!==b.windowsLogonLuid||
    !/^[a-f0-9]{16}$/.test(a[6]??'')||/^0+$/.test(a[6]??''))
    deny('CEREMONY_SCOPE_INVALID');
  return Object.freeze(['--ceremony',...a.slice(1),c.helperSha256,c.helperSignerSha256]);
}
async function launch(c:Readonly<WindowsOwnerLauncherPins>,args:readonly string[],signal:AbortSignal):Promise<unknown>{
  signal.throwIfAborted();
  // Direct launch under the protected SYSTEM service. The native launcher
  // independently checks session zero, actual owner token, artifact handle,
  // child DACL, pipe PID, exit status and kernel Job accounting.
  return new Promise((resolve,reject)=>{
    const child=spawn(c.launcherPath,[...args],{shell:false,cwd:SYSTEM32,
      env:protectedWindowsAclEnvironment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    const chunks:Buffer[]=[];let bytes=0,stderr=0,invalid=false;
    let settled=false,finished=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    const fail=()=>{if(!settled){settled=true;reject(Error('CORE_OWNER_LAUNCHER_OUTCOME_UNKNOWN'));}};
    const abort=()=>{invalid=true;if(!finished){try{child.kill();}catch{/* Keep outcome unknown. */}}};
    timer=setTimeout(abort,100000);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>8192)abort();else if(!invalid)chunks.push(b);});
    child.stderr.on('data',(b:Buffer)=>{stderr+=b.length;if(stderr>8192)abort();});
    child.once('error',()=>{invalid=true;cleanup();fail();});
    child.once('close',(code,exitSignal)=>{
      finished=true;cleanup();
      if(settled)return;
      if(invalid||signal.aborted||code!==0||exitSignal!==null||stderr!==0||!bytes){fail();return;}
      try{const result:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        settled=true;resolve(result);}
      catch{fail();}
    });
  });
}
/** Actual protected native launcher, not a simulated prompt. The caller is
 * the independently installed SYSTEM issuer composition root. Artifact
 * checks do not defend against a hostile SYSTEM/administrator replacing the
 * entire trusted runtime; release provisioning and physical acceptance remain
 * explicit prerequisites. All native failure paths deny, never retry. */
export async function createWindowsProtectedOwnerAssertionLauncher(pins:WindowsOwnerLauncherPins):
  Promise<ProtectedOwnerAssertionLauncher>{
  if(process.platform!=='win32')deny('WINDOWS_REQUIRED');
  const c=validateWindowsOwnerLauncherPins(pins);
  assertNoPrivilegedNodeStartupFlags(process.execArgv);
  assertWindowsPrivilegedRuntimeTrusted({executable:process.execPath,cliEntrypoint:process.argv[1]??'',env:process.env});
  const helper=path.win32.join(path.win32.dirname(c.launcherPath),HELPER);
  auditPaths(c.launcherPath,helper);
  await exactFile(c.launcherPath,c.launcherSha256);await signature(c.launcherPath,c.launcherSignerSha256);
  await exactFile(helper,c.helperSha256);await signature(helper,c.helperSignerSha256);
  let busy=false,unknown=false;
  return Object.freeze({
    async runBoundAssertion(input:Ceremony,signal:AbortSignal){
      if(unknown)deny('PRIOR_OUTCOME_UNKNOWN');
      if(busy)deny('BUSY');
      const args=windowsOwnerLauncherArguments(input,c);
      signal.throwIfAborted();busy=true;
      try{
        // No remote-supplied path or signer; verify the same installed launcher
        // immediately before and after the child. Native holds the helper file
        // without write/delete sharing until its own child Job is drained.
        await exactFile(c.launcherPath,c.launcherSha256);
        signal.throwIfAborted();
        const raw=await launch(c,args,signal);
        await exactFile(c.launcherPath,c.launcherSha256);
        signal.throwIfAborted();return raw;
      }catch(error){
        // A child may have been terminated without independently observed
        // Job drain. Never start another ceremony in this issuer incarnation.
        unknown=true;throw error;
      }finally{busy=false;}
    }
  });
}
/** Explicit startup composition, not the Agent or off-host verifier process.
 * No default service registration; current owner directory and ledger remain
 * independently provisioned. The Windows helper's raw assertion is verified
 * by the PostgreSQL ledger before a proof can be returned. */
export async function createWindowsProtectedOwnerIssuer(config:
  Omit<Parameters<typeof createProtectedOwnerConsentAuthority>[0],'launcher'> & {pins:WindowsOwnerLauncherPins}){
  const launcher=await createWindowsProtectedOwnerAssertionLauncher(config.pins);
  return createProtectedOwnerConsentAuthority({ledger:config.ledger,readCurrentOwner:config.readCurrentOwner,launcher});
}
