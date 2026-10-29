import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {CoreConsoleAdmission,type CoreConsoleBinding,type CoreConsoleDispatch,
  type CoreConsoleEvidence,type CoreConsoleNativeProvider,type CoreConsoleReceipt} from './core-console-admission.js';
import {canonicalCoreConsoleEnrollment,evaluateCoreConsoleEnrollment,type SignedCoreConsoleEnrollmentV1} from './core-console-enrollment-policy.js';
import {coreOperationBytes,verifyCoreCertificate,CoreAuthorityStateSchema,normalizeCoreAuthorityUrl,readCoreJson,type CoreAuthorityRequest,
  type CoreAuthorityResponse,type CoreAuthorityState} from '../protocol/core-console-authority.js';
import {writeProtectedSecretFile} from '../security/protected-secret-files.js';
import {windowsDpapiChildEnvironment,unprotectWindowsUserSecretForPurpose} from '../security/windows-dpapi.js';
import {CORE_NATIVE_DEFINITION,CORE_POWERSHELL,executeCoreConsoleNative,runCorePowerShell,parseCoreNativeInput,CoreNativeDenial} from './windows-core-console-native.js';
import type {PrivilegedBrokerClient} from './privileged-broker-client.js';
import {NEXOWIRE_VERSION} from '../version.js';
import {executeWindowsPrivateViewerCapability} from './windows-private-viewer.js';
import {revokePhysicalConsoleGrant} from './windows-console-grant.js';

const PURPOSE='core-console-profile-v1';
const EnvelopeSchema=z.strictObject({version:z.literal(1),purpose:z.literal(PURPOSE),
  protection:z.literal('windows-dpapi-current-user'),ciphertext:z.string().min(4).max(16000)});
// The native trust boundary is not implemented by this JS module. The receipt
// is descriptive metadata only; a protected OS component must atomically consume
// the physical decision and independently read back the current Windows logon.
export interface NativeCoreConsentProof {
  version:1;challengeId:string;receiptId:string;ownerAccountId:string;
  deviceId:string;installationId:string;enrollmentId:string;
  ownerEpoch:number;grantGeneration:number;revokeEpoch:number;
  windowsSessionId:number;windowsUserSid:string;windowsLogonLuid:string;
  windowsLogonSessionEpoch:string;approvedAtMs:number;consumed:true;
}
export interface NativeCoreConsentChallenge {
  version:1;challengeId:string;ownerAccountId:string;deviceId:string;
  installationId:string;enrollmentId:string;ownerEpoch:number;
  grantGeneration:number;revokeEpoch:number;
}
export interface NativeCoreConsentAuthority {
  /** Protected native OS UI + atomic one-use decision. Never Agent/Hub or JS MessageBox.
   * Capture the interactive owner logon before the prompt, revalidate it after the
   * user returns, and only then consume the receipt. Bind the owner to a separately
   * provisioned Windows SID, token AuthenticationId, WTS session ID and logon epoch. */
  approveAndConsume(challenge:NativeCoreConsentChallenge,signal:AbortSignal):Promise<NativeCoreConsentProof|null>;
  /** Independent protected OS readback must verify current Windows logon/session. */
  currentReadback(receiptId:string,signal:AbortSignal):Promise<NativeCoreConsentProof|null>;
}
const NativeProofSchema=z.strictObject({
  version:z.literal(1),challengeId:z.string().uuid(),receiptId:z.string().uuid(),
  ownerAccountId:z.string().min(8).max(128),deviceId:z.string().min(8).max(128),
  installationId:z.string().uuid(),enrollmentId:z.string().uuid(),
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  revokeEpoch:z.number().int().nonnegative().safe(),
  windowsSessionId:z.number().int().positive().safe(),
  windowsUserSid:z.string().regex(/^S-\d-\d+(?:-\d+)+$/i),
  windowsLogonLuid:z.string().regex(/^[0-9a-f]{16}$/i).refine(v=>!/^0+$/.test(v)),
  windowsLogonSessionEpoch:z.string().uuid(),
  approvedAtMs:z.number().int().positive().safe(),consumed:z.literal(true),
});
const NATIVE_KEYS=Object.keys(NativeProofSchema.shape);
function sameNativeProof(value:unknown,expected:NativeCoreConsentProof):value is NativeCoreConsentProof {
  const parsed=NativeProofSchema.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length===NATIVE_KEYS.length &&
    NATIVE_KEYS.every(k=>parsed.data[k as keyof NativeCoreConsentProof]===
      expected[k as keyof NativeCoreConsentProof]);
}
interface Profile {version:1;installationId:string;deviceId:string;authorityUrl:string;
  certificate:SignedCoreConsoleEnrollmentV1|null;privateKey:string|null;
  nativeConsent?:NativeCoreConsentProof;pendingRevoke:boolean;
  pendingDispatch?:{requestId:string;fingerprint:string}}
const ProfileSchema=z.strictObject({version:z.literal(1),installationId:z.string().uuid(),
  deviceId:z.string().min(8).max(128),authorityUrl:z.string().url(),
  certificate:z.unknown().nullable(),privateKey:z.string().max(256).nullable(),
  // Accept legacy profile shapes only so they can remain revocable. The proof is
  // separately validated below; an old/incomplete proof becomes absent and can
  // never authorize enrollment or admission.
  nativeConsent:z.unknown().optional(),pendingRevoke:z.boolean(),
  pendingDispatch:z.strictObject({requestId:z.string().uuid(),
    fingerprint:z.string().regex(/^[0-9a-f]{64}$/)}).optional()});
export interface CoreProfileStore {load():Promise<Profile|null>;save(profile:Profile):Promise<void>;
  stop():Promise<void>;clearStop():Promise<void>;stopped():Promise<boolean>;readonly stopFile:string;
  block?():Promise<void>;clearBlock?():Promise<void>;blocked?():Promise<boolean>}

/** CurrentUser DPAPI protects this physical-console key; it is NOT a HIGH token
 * or protection from malicious code already running as the Windows owner.
 * No key, plaintext profile or enrollment certificate comes from a tool input. */
export class WindowsCoreProfileStore implements CoreProfileStore {
  readonly stopFile:string;private readonly file:string;
  private verifiedEnvelope?:{raw:string;profile:Profile};
  constructor(private readonly root=path.join(os.homedir(),'.nexowire','core-console')){
    this.file=path.join(root,'profile.dpapi.json');this.stopFile=path.join(root,'STOP');
  }
  private async protectDirectory(){
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    const stat=await fs.lstat(this.root);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('CORE_PROFILE_DIRECTORY_UNTRUSTED');
    const script=String.raw`$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$dir=Get-Item -LiteralPath $p.root -Force
if(($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'CORE_PROFILE_REPARSE_DENIED'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$expected=@($sid.Value,'S-1-5-18','S-1-5-32-544')
$acl=Get-Acl -LiteralPath $dir.FullName -ErrorAction Stop
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -notin $expected){throw 'CORE_PROFILE_OWNER_CHANGED'}
function Test-CoreProfileAcl($candidate){
 if(-not $candidate.AreAccessRulesProtected){return $false}
 $rules=@($candidate.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if($rules.Count -ne $expected.Count){return $false}
 $seen=@{}
 foreach($ace in $rules){
  $principal=$ace.IdentityReference.Value
  if($principal -notin $expected -or $seen.ContainsKey($principal) -or $ace.IsInherited -or
     $ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
     $ace.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
     $ace.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
     $ace.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){return $false}
  $seen[$principal]=$true
 }
 return $seen.Count -eq $expected.Count
}
# Many previously enrolled Windows owners already have this exact private
# DACL. Re-applying Set-Acl with an unnecessary owner write can demand
# SeSecurityPrivilege in a Medium Agent process and strand pending revoke.
if(Test-CoreProfileAcl $acl){
 @{protected=$true;alreadyProtected=$true}|ConvertTo-Json -Compress
 exit 0
}
# Preserve the previously validated owner. Change only the DACL, never
# request ownership/security privilege elevation from a console Agent.
$acl.SetAccessRuleProtection($true,$false)
foreach($existing in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($existing)}
foreach($s in $expected){
 $rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dir.FullName -AclObject $acl -ErrorAction Stop
$checked=Get-Acl -LiteralPath $dir.FullName -ErrorAction Stop
if($checked.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner -or
   -not (Test-CoreProfileAcl $checked)){throw 'CORE_PROFILE_ACL_POSTCHECK_FAILED'}
@{protected=$true;alreadyProtected=$false}|ConvertTo-Json -Compress`;
    // Windows CLR/module cold start on hosted runners can exceed 30 seconds.
    // This only changes ACLs on the owner's dedicated profile directory.
    await runCorePowerShell(script,{root:this.root},undefined,180000);
  }
  async load(){
    try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('CORE_PROFILE_INVALID');}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    const handle=await fs.open(this.file,'r');let raw:string;
    try{const bytes=Buffer.alloc(16385);const read=await handle.read(bytes,0,bytes.length,0);
      if(read.bytesRead>16384)throw new Error('CORE_PROFILE_INVALID');raw=bytes.subarray(0,read.bytesRead).toString('utf8');
    }finally{await handle.close();}
    const envelope=EnvelopeSchema.parse(JSON.parse(raw));
    // Re-read and compare the complete bounded envelope on every admission.
    // Only DPAPI decryption is cached, never current authority or STOP state.
    if(this.verifiedEnvelope?.raw===raw)return structuredClone(this.verifiedEnvelope.profile);
    // Async DPAPI must never block the Agent's WSS/heartbeat event loop.
    const plaintext=await unprotectWindowsUserSecretForPurpose(envelope.ciphertext,PURPOSE);
    const parsed=ProfileSchema.parse(JSON.parse(plaintext));
    const consent=NativeProofSchema.safeParse(parsed.nativeConsent);
    const profile={...parsed} as Profile;
    if(consent.success)profile.nativeConsent=consent.data;
    else delete profile.nativeConsent;
    if(profile.certificate){
      if(!profile.privateKey)throw new Error('CORE_PRIVATE_KEY_MISSING');
      const key=createPrivateKey({key:Buffer.from(profile.privateKey,'base64'),type:'pkcs8',format:'der'});
      const spki=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
      verifyCoreCertificate(profile.certificate,spki);
      if(profile.certificate.enrollment.installationId!==profile.installationId||
        profile.certificate.enrollment.deviceId!==profile.deviceId)throw new Error('CORE_PROFILE_BINDING_CHANGED');
    }
    this.verifiedEnvelope={raw,profile:structuredClone(profile)};return profile;
  }
  async save(profile:Profile){
    await this.protectDirectory();
    await writeProtectedSecretFile(this.file,PURPOSE,JSON.stringify(profile),{overwrite:true});
    // Flush the replaced profile before any native effect can be admitted.
    // Filesystem/power-loss durability still needs independent OS acceptance.
    const handle=await fs.open(this.file,'r+');
    try{await handle.sync();}finally{await handle.close();}
  }
  async stop(){await fs.mkdir(this.root,{recursive:true,mode:0o700});
    try{const handle=await fs.open(this.stopFile,'wx',0o600);
      try{await handle.writeFile('STOP');await handle.sync();}finally{await handle.close();}}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
  async clearStop(){await fs.rm(this.stopFile,{force:true});}
  async stopped(){try{await fs.lstat(this.stopFile);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
  async block(){try{await fs.writeFile(this.stopFile+'.blocked','BLOCKED',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
  async clearBlock(){await fs.rm(this.stopFile+'.blocked',{force:true});}
  async blocked(){try{await fs.lstat(this.stopFile+'.blocked');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
}

export class CoreConsoleAuthorityClient {
  readonly url:string;
  constructor(url:string,private readonly credential:string,private readonly fetchImpl:typeof fetch=fetch){
    const u=new URL(normalizeCoreAuthorityUrl(url));
    if(!/^nwx_dev_[A-Za-z0-9_-]{8,500}$/.test(credential))throw new Error('CORE_PAIRED_DEVICE_CREDENTIAL_REQUIRED');
    u.pathname='/api/v1/device/core-console';this.url=u.toString();
  }
  async call(profile:Profile,action:CoreAuthorityRequest['action'],extra:Partial<CoreAuthorityRequest>={},signal?:AbortSignal):Promise<CoreAuthorityState>{
    const request:CoreAuthorityRequest={...extra,action,deviceId:profile.deviceId,
      installationId:profile.installationId,nonce:randomUUID(),issuedAtMs:Date.now()};
    if(profile.privateKey){request.signature=sign(null,coreOperationBytes(request),
      createPrivateKey({key:Buffer.from(profile.privateKey,'base64'),type:'pkcs8',format:'der'})).toString('base64');}
    const response=await this.fetchImpl(this.url,{method:'POST',redirect:'error',cache:'no-store',
      headers:{authorization:'Bearer '+this.credential,'content-type':'application/json'},
      body:JSON.stringify(request),signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});
    if(!response.ok){await response.body?.cancel();throw new Error('CORE_AUTHORITY_DENIED_'+response.status);}
    const body=await readCoreJson(response) as CoreAuthorityResponse;
    if(body.nonce!==request.nonce||body.state?.deviceId!==profile.deviceId)throw new Error('CORE_AUTHORITY_RESPONSE_UNBOUND');
    const state=CoreAuthorityStateSchema.parse(body.state);
    if(request.issuedAtMs<state.authorityTimeMs-30000||request.issuedAtMs>state.authorityTimeMs+5000)
      throw new Error('CORE_AUTHORITY_CLOCK_UNVERIFIED');
    return state;
  }
}

const monitorScript=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${CORE_NATIVE_DEFINITION}
'@
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$icon=New-Object System.Windows.Forms.NotifyIcon
$icon.Icon=[System.Drawing.SystemIcons]::Shield;$icon.Text='Nexowire CORE fiziksel kontrol';$icon.Visible=$true
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$stop=$menu.Items.Add('CORE fiziksel kontrolü KAPAT')
$icon.ContextMenuStrip=$menu
$context=New-Object System.Windows.Forms.ApplicationContext
$stop.Add_Click({
 try{$f=[IO.File]::Open([string]$p.stopFile,[IO.FileMode]::CreateNew);$f.Dispose()}catch{}finally{
  [Console]::Out.WriteLine('STOP');[Console]::Out.Flush();$context.ExitThread()
 }
})
$timer=New-Object System.Windows.Forms.Timer;$timer.Interval=1000
$timer.Add_Tick({[Console]::Out.WriteLine($(if([NxCoreConsole]::DesktopAllowed()){'DEFAULT'}else{'BLOCKED'}));[Console]::Out.Flush()})
$timer.Start();[Console]::Out.WriteLine($(if([NxCoreConsole]::DesktopAllowed()){'DEFAULT'}else{'BLOCKED'}));[Console]::Out.WriteLine('READY');[Console]::Out.Flush()
try{[System.Windows.Forms.Application]::Run($context)}finally{$timer.Stop();$timer.Dispose();$icon.Visible=$false;$icon.Dispose()}
`;
export interface WindowsCoreProviderOptions {
  deviceId:string;authority:CoreConsoleAuthorityClient;store:CoreProfileStore;
  broker:Pick<PrivilegedBrokerClient,'probe'>;
  /** Trusted native integration only. The production composition root does NOT install one yet. */
  nativeConsent?:NativeCoreConsentAuthority;
  native?:(capability:string,input:unknown,stopFile:string,signal:AbortSignal)=>Promise<unknown>;
  monitor?:{desktopAllowed():boolean;close():void};
}
export class WindowsCoreConsoleProvider implements CoreConsoleNativeProvider {
  readonly durableReplayProtected=true as const;
  binding?:CoreConsoleBinding;
  private profile!:Profile;
  private pending=false;private closed=false;private revoked=false;private tail:Promise<unknown>=Promise.resolve();
  private monitor?:ChildProcessWithoutNullStreams;private monitorAt=0;private desktop=false;
  private timer?:NodeJS.Timeout;private lastReport=0;private pollBusy=false;
  private readonly lifetime=new AbortController();
  private revoking?:Promise<void>;
  private inFlightDispatch?:{requestId:string;fingerprint:string};
  private initialization?:Promise<void>;
  onEnrollmentRequested?:()=>Promise<void>;
  constructor(private readonly options:WindowsCoreProviderOptions){}
  initialize():Promise<void>{
    this.initialization??=this.initializeProfile();return this.initialization;
  }
  private async initializeProfile(){
    this.profile=await this.options.store.load()??{version:1,deviceId:this.options.deviceId,
      installationId:randomUUID(),authorityUrl:this.options.authority.url,certificate:null,privateKey:null,pendingRevoke:false};
    if(this.profile.deviceId!==this.options.deviceId||this.profile.authorityUrl!==this.options.authority.url)
      throw new Error('CORE_AUTHORITY_OR_DEVICE_REBOUND');
    if(this.profile.certificate){const e=this.profile.certificate.enrollment;
      this.binding={ownerAccountId:e.ownerAccountId,deviceId:e.deviceId,installationId:e.installationId};}
    if(this.profile.pendingRevoke||this.profile.pendingDispatch)this.revoked=true;
  }
  start(){
    if(this.closed)return;
    this.timer=setInterval(()=>{if(this.pollBusy||this.closed)return;this.pollBusy=true;
      void this.poll().catch(async()=>{this.desktop=false;await this.options.store.block?.();}).catch(()=>{}).finally(()=>{this.pollBusy=false;});},2000);this.timer.unref();
    void this.poll().catch(async()=>{await this.options.store.block?.();}).catch(()=>{});
  }
  private async poll(){
    await this.initialize();
    if(this.closed)return;
    if(this.profile.pendingRevoke){await this.revoke();return;}
    const state=await this.options.authority.call(this.profile,'read');
    const broker=await this.options.broker.probe();
    if(!broker.reachable||!broker.elevated||broker.version!==NEXOWIRE_VERSION){await this.options.store.block?.();return;}
    if(this.profile.certificate&&!this.matches(state))await this.revoke();
    if(this.profile.certificate){const disk=await this.options.store.load();
      if(!disk?.certificate||disk.pendingRevoke||disk.certificate.signatureBase64!==this.profile.certificate.signatureBase64)await this.revoke();}
    if(this.profile.certificate&&this.matches(state))await this.options.store.clearBlock?.();
    if(state.enrollmentRequested&&!this.pending){
      if(this.profile.certificate&&this.matches(state))await this.options.authority.call(this.profile,'dismiss');
      else await this.onEnrollmentRequested?.();
    }
    if(this.profile.certificate&&Date.now()-this.lastReport>10000){
      const evidence=await this.inspect(new AbortController().signal);
      const active=this.eligible(evidence)&&evidence.desktop==='default';
      await this.options.authority.call(this.profile,'report',{active});this.lastReport=Date.now();
    }
  }
  private current(state:CoreAuthorityState){return {ownerAccountId:state.ownerAccountId,deviceId:state.deviceId,
    installationId:state.installationId,ownerEpoch:state.ownerEpoch,grantGeneration:state.grantGeneration,
    revokeEpoch:state.revokeEpoch,coreEnabled:state.coreEnabled,accessMode:state.accessMode,
    deviceOnline:state.deviceOnline,bridgeVerified:state.bridgeVerified};}
  private matches(state:CoreAuthorityState){const e=this.profile.certificate?.enrollment;
    return !!e&&state.coreEnabled&&state.accessMode==='full'&&
      state.devicePlatform==='win32'&&state.deviceReady===true&&
      state.ownerAccountId===e.ownerAccountId&&
      state.deviceId===e.deviceId&&state.installationId===e.installationId&&state.enrollmentId===e.enrollmentId&&
      state.ownerEpoch===e.ownerEpoch&&state.grantGeneration===e.grantGeneration&&state.revokeEpoch===e.revokeEpoch&&
      !!state.publicKeySpki&&createHash('sha256').update(Buffer.from(state.publicKeySpki,'base64')).digest('hex')===e.issuerSpkiSha256;}
  private spki(){if(!this.profile.privateKey)return null;
    // Derive the public key from the DPAPI-protected private key, never a request pin.
    return createPublicKey(createPrivateKey({key:Buffer.from(this.profile.privateKey,'base64'),format:'der',type:'pkcs8'})).export({format:'der',type:'spki'});}
  private allowedDesktop(){return this.options.monitor?.desktopAllowed()??
    (!!this.monitor&&this.desktop&&Date.now()-this.monitorAt<3500);}
  async inspect(signal:AbortSignal):Promise<CoreConsoleEvidence>{
    await this.initialize();
    if(this.closed||signal.aborted)throw new Error('CORE_PROVIDER_CLOSED_OR_CANCELLED');
    const observedAtMs=Date.now();
    const state=await this.options.authority.call(this.profile,'read',{},signal);
    const local=await this.options.store.load();
    if(!this.profile.certificate)this.binding={ownerAccountId:state.ownerAccountId,deviceId:this.profile.deviceId,installationId:this.profile.installationId};
    const probe=await this.options.broker.probe();
    const bridge=probe.reachable===true&&probe.elevated===true&&probe.version===NEXOWIRE_VERSION;
    const pinned=this.spki();
    const pendingIsOurs=!local?.pendingDispatch||
      (!!this.inFlightDispatch&&local.pendingDispatch.requestId===this.inFlightDispatch.requestId&&
        local.pendingDispatch.fingerprint===this.inFlightDispatch.fingerprint);
    const localValid=local?.certificate?.signatureBase64===this.profile.certificate?.signatureBase64&&
      !local?.pendingRevoke&&pendingIsOurs;
    // A legacy DPAPI certificate or native-looking JS fixture is NOT physical
    // consent. No shipped native authority means enrollment remains required.
    const nativeValid=await this.currentNativeConsent(signal,state);
    // Native OS readback is an async trust boundary. Owner re-pair, CORE OFF,
    // revoke, session rotation or Broker loss during it must not publish an
    // evidence snapshot based on the older authority/bridge observations.
    const latest=await this.options.authority.call(this.profile,'read',{},signal);
    const latestProbe=await this.options.broker.probe();
    const latestBridge=latestProbe.reachable===true&&latestProbe.elevated===true&&
      latestProbe.version===NEXOWIRE_VERSION;
    const unchanged=latest.devicePlatform==='win32'&&latest.deviceReady===true&&
      state.devicePlatform===latest.devicePlatform&&state.deviceReady===latest.deviceReady&&
      JSON.stringify(this.current(state))===JSON.stringify(this.current(latest))&&
      state.enrollmentId===latest.enrollmentId&&
      state.publicKeySpki===latest.publicKeySpki&&
      state.nativeConsentReceiptId===latest.nativeConsentReceiptId&&
      state.windowsUserSid===latest.windowsUserSid&&
      state.windowsSessionId===latest.windowsSessionId&&
      state.windowsLogonLuid===latest.windowsLogonLuid&&
      state.windowsLogonSessionEpoch===latest.windowsLogonSessionEpoch;
    const certificate=this.revoked||signal.aborted||!localValid||!nativeValid||
      !unchanged||!bridge||!latestBridge||!this.matches(latest)||
      await this.options.store.stopped()||await this.options.store.blocked?.()?null:this.profile.certificate;
    return {certificate,pinnedLocalSpkiDer:pinned,
      current:{...this.current(latest),bridgeVerified:latest.bridgeVerified&&latestBridge},
      devicePlatform:latest.devicePlatform,deviceReady:latest.deviceReady,
      observedAtMs,desktop:this.allowedDesktop()?'default':'unknown',
      nativeAdmission:!!certificate&&nativeValid&&latestBridge&&this.allowedDesktop()?'verified':'unavailable',
      brokerVersionVerified:latestBridge,
      nativeConsentProviderPresent:!!this.options.nativeConsent} as CoreConsoleEvidence;
  }
  private async currentNativeConsent(signal:AbortSignal,authorityState:CoreAuthorityState):Promise<boolean>{
    const recorded=this.profile.nativeConsent;
    const e=this.profile.certificate?.enrollment;
    if(!recorded||!e||!this.options.nativeConsent||this.closed||signal.aborted)return false;
    if(recorded.enrollmentId!==e.enrollmentId||
      recorded.ownerAccountId!==e.ownerAccountId||
      recorded.deviceId!==e.deviceId||
      recorded.installationId!==e.installationId||
      recorded.ownerEpoch!==e.ownerEpoch||
      recorded.grantGeneration!==e.grantGeneration||
      recorded.revokeEpoch!==e.revokeEpoch||
      authorityState.nativeConsentReceiptId!==recorded.receiptId||
      authorityState.windowsUserSid!==recorded.windowsUserSid||
      authorityState.windowsSessionId!==recorded.windowsSessionId||
      authorityState.windowsLogonLuid!==recorded.windowsLogonLuid||
      authorityState.windowsLogonSessionEpoch!==recorded.windowsLogonSessionEpoch)return false;
    try{
      // A real implementation must freshly obtain this from a distinct OS
      // protected logon/desktop ledger; not a JS cache or local profile echo.
      const fresh=await this.options.nativeConsent.currentReadback(recorded.receiptId,signal);
      return sameNativeProof(fresh,recorded);
    }catch{return false;}
  }
  private eligible(e:CoreConsoleEvidence){if(!this.binding)return false;return evaluateCoreConsoleEnrollment({certificate:e.certificate,
    pinnedLocalSpkiDer:e.pinnedLocalSpkiDer,trustedCurrentReadback:e.current,
    requestedOwnerAccountId:this.binding.ownerAccountId,requestedDeviceId:this.binding.deviceId,
    requestedInstallationId:this.binding.installationId,nowMs:Date.now(),desktop:e.desktop}).policyEligible;}
  private async startMonitor(){
    if(this.closed)throw new Error('CORE_PROVIDER_CLOSED');
    if(this.options.monitor)return;
    if(this.monitor)return;
    const child=spawn(CORE_POWERSHELL,['-NoLogo','-NoProfile','-STA','-Command',monitorScript],{
      shell:false,cwd:'C:\\Windows\\System32',windowsHide:true,env:windowsDpapiChildEnvironment(),stdio:['pipe','pipe','pipe']});
    this.monitor=child;let buffer='';
    let ready!:()=>void,failed!:(e:Error)=>void;
    const startup=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
    const timeout=setTimeout(()=>failed(new Error('CORE_LOCAL_MONITOR_TIMEOUT')),180000);
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>16384){child.kill();return;}
      let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
        if(line==='DEFAULT'||line==='BLOCKED'){this.monitorAt=Date.now();this.desktop=line==='DEFAULT';}
        if(line==='READY')ready();
        if(line==='STOP'){revokePhysicalConsoleGrant();void this.revoke().catch(()=>{});}
      }});
    child.once('error',e=>{this.desktop=false;failed(e);});
    child.once('exit',()=>{failed(new Error('CORE_LOCAL_MONITOR_EXITED'));if(this.monitor!==child)return;
      this.monitor=undefined;this.desktop=false;if(!this.closed&&!this.revoked)void this.revoke().catch(()=>{});});
    child.stdin.end(JSON.stringify({stopFile:this.options.store.stopFile}));
    try{await startup;}finally{clearTimeout(timeout);}
  }
  async enroll(signal:AbortSignal):Promise<boolean>{
    signal=AbortSignal.any([signal,this.lifetime.signal]);
    await this.initialize();
    if(this.closed||signal.aborted)throw new Error('CORE_PROVIDER_CLOSED_OR_CANCELLED');
    // The existing JS MessageBox/boolean adapter is NOT an independently
    // attestable physical decision. No native provider ships at present.
    if(!this.options.nativeConsent)return false;
    if(this.pending)throw new Error('CORE_ENROLLMENT_PROMPT_ACTIVE');this.pending=true;
    try{
      const state=await this.options.authority.call(this.profile,'read',{},signal);
      if(!state.coreEnabled||state.accessMode!=='full'||!state.deviceOnline)throw new Error('CORE_OWNER_ENABLE_REQUIRED');
      const bridge=await this.options.broker.probe();
      if(!bridge.reachable||!bridge.elevated||bridge.version!==NEXOWIRE_VERSION)throw new Error('CORE_BROKER_VERIFICATION_REQUIRED');
      if(this.profile.certificate&&this.matches(state)&&!this.revoked&&
        !(await this.options.store.stopped())&&await this.currentNativeConsent(signal,state))return true;
      if(!this.options.native)await executeCoreConsoleNative('probe',{},'',signal);
      // Fence any legacy approval BEFORE issuing a new challenge. The challenge
      // must bind epochs after this monotonic revoke, not before it.
      await this.revoke();
      await this.tail;
      const fresh=await this.options.authority.call(this.profile,'read',{},signal);
      if(!fresh.coreEnabled||fresh.accessMode!=='full'||!fresh.deviceOnline||
        !fresh.bridgeVerified||fresh.ownerAccountId!==state.ownerAccountId||
        fresh.deviceId!==state.deviceId)throw new Error('CORE_REVOKED_DURING_ENROLLMENT');
      const challenge:NativeCoreConsentChallenge={version:1,challengeId:randomUUID(),
        ownerAccountId:fresh.ownerAccountId,deviceId:fresh.deviceId,
        installationId:this.profile.installationId,enrollmentId:randomUUID(),
        ownerEpoch:fresh.ownerEpoch,grantGeneration:fresh.grantGeneration,revokeEpoch:fresh.revokeEpoch};
      const proof=await this.options.nativeConsent.approveAndConsume(challenge,signal);
      if(!proof||signal.aborted)return false;
      const parsed=NativeProofSchema.safeParse(proof);
      const now=Date.now();
      if(!parsed.success||!Object.keys(proof).every(k=>NATIVE_KEYS.includes(k))||
        !Object.entries(challenge).every(([k,v])=>
          proof[k as keyof NativeCoreConsentProof]===v)||
        proof.approvedAtMs>now+5000||proof.approvedAtMs<now-120000)
        throw new Error('CORE_NATIVE_CONSENT_BINDING_INVALID');
      const independent=await this.options.nativeConsent.currentReadback(proof.receiptId,signal);
      if(!sameNativeProof(independent,proof))throw new Error('CORE_NATIVE_CONSENT_READBACK_REQUIRED');
      const latest=await this.options.authority.call(this.profile,'read',{},signal);
      if(JSON.stringify(this.current(fresh))!==JSON.stringify(this.current(latest))||
        latest.enrollmentId!==fresh.enrollmentId||latest.publicKeySpki!==fresh.publicKeySpki)
        throw new Error('CORE_CHANGED_DURING_LOCAL_CONSENT');
      if(!this.options.native)await executeCoreConsoleNative('probe',{},'',signal);
      const key=generateKeyPairSync('ed25519');const der=key.publicKey.export({type:'spki',format:'der'});
      const enrollment={version:1 as const,scope:'physical-console' as const,
        ownerAccountId:challenge.ownerAccountId,deviceId:challenge.deviceId,
        installationId:challenge.installationId,enrollmentId:challenge.enrollmentId,
        ownerEpoch:challenge.ownerEpoch,grantGeneration:challenge.grantGeneration,
        revokeEpoch:challenge.revokeEpoch,approvedLocallyAtMs:proof.approvedAtMs,
        issuerSpkiSha256:createHash('sha256').update(der).digest('hex')};
      const profile:Profile={...this.profile,
        privateKey:key.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
        pendingRevoke:false,nativeConsent:proof,
        certificate:{enrollment,signatureBase64:
          sign(null,canonicalCoreConsoleEnrollment(enrollment),key.privateKey).toString('base64')}};
      await this.options.store.save(profile);this.profile=profile;
      const registered=await this.options.authority.call(profile,'enroll',{certificate:profile.certificate,
        publicKeySpki:der.toString('base64'),nativeConsent:proof},signal);
      if(registered.nativeConsentReceiptId!==proof.receiptId||
        registered.windowsUserSid!==proof.windowsUserSid||
        registered.windowsSessionId!==proof.windowsSessionId||
        registered.windowsLogonLuid!==proof.windowsLogonLuid||
        registered.windowsLogonSessionEpoch!==proof.windowsLogonSessionEpoch)
        throw new Error('CORE_NATIVE_CONSENT_AUTHORITY_BINDING_REQUIRED');
      this.binding={ownerAccountId:challenge.ownerAccountId,deviceId:challenge.deviceId,
        installationId:challenge.installationId};
      this.revoked=false;await this.options.store.clearStop();
      await this.options.store.clearBlock?.();await this.startMonitor();return true;
    }finally{this.pending=false;}
  }
  execute(request:CoreConsoleDispatch,signal:AbortSignal):Promise<CoreConsoleReceipt>{
    const work=this.tail.then(async()=>{
      if(this.revoked||signal.aborted)throw new Error('CORE_REVOKED');
      if(request.capability!=='windows.private_viewer.start')parseCoreNativeInput(request.capability,request.input);
      const fingerprint=createHash('sha256').update(JSON.stringify([request.requestId,request.capability,request.input,request.binding])).digest('hex');
      if(request.fingerprint!==fingerprint)throw new Error('CORE_INPUT_FINGERPRINT_CHANGED');
      const evidence=await this.inspect(signal);
      if(!this.eligible(evidence)||!this.profile.certificate)throw new Error('CORE_CURRENT_PERMISSION_REQUIRED');
      const e=this.profile.certificate.enrollment;
      if(request.enrollmentId!==e.enrollmentId||request.ownerEpoch!==e.ownerEpoch||request.grantGeneration!==e.grantGeneration||request.revokeEpoch!==e.revokeEpoch||
        JSON.stringify(request.binding)!==JSON.stringify(this.binding))throw new Error('CORE_DISPATCH_BINDING_CHANGED');
      const fields={requestId:request.requestId,fingerprint:request.fingerprint};
      const cancel=()=>{this.latchLocalStop();void this.options.store.stop().catch(()=>{});};
      signal.addEventListener('abort',cancel,{once:true});
      let outcome:'succeeded'|'denied'|'unknown'='unknown';let data:unknown;
      let profilePrepared=false,reservationOwned=false;
      try{
        // Persist uncertainty BEFORE reserve/claim/native execution. A new
        // provider cannot resume an old certificate after crash or lost ACK.
        this.inFlightDispatch=fields;
        this.profile={...this.profile,pendingDispatch:fields};
        await this.options.store.save(this.profile);
        profilePrepared=true;
        await this.options.authority.call(this.profile,'reserve',fields,signal);
        reservationOwned=true;
        await this.options.authority.call(this.profile,'claim',fields,signal);
        // Session/owner readback is repeated after external admission and as
        // close as this source path can get to the native effect. Native OS
        // code must still enforce its own final logon/target checks.
        const finalEvidence=await this.inspect(signal);
        const finalEnrollment=finalEvidence.certificate?.enrollment;
        if(finalEvidence.devicePlatform!=='win32'||
          finalEvidence.deviceReady!==true||
          !this.eligible(finalEvidence)||finalEvidence.nativeAdmission!=='verified'||
          finalEvidence.nativeConsentProviderPresent!==true||!finalEnrollment||
          finalEnrollment.enrollmentId!==request.enrollmentId||
          finalEnrollment.ownerEpoch!==request.ownerEpoch||
          finalEnrollment.grantGeneration!==request.grantGeneration||
          finalEnrollment.revokeEpoch!==request.revokeEpoch)
          throw new Error('CORE_CONSOLE_FINAL_SESSION_READBACK_REQUIRED');
        const native=this.options.native??executeCoreConsoleNative;
        // The marker lets native cleanup release pressed keys before exiting.
        // Cancellation does not grant a new request or permit a blind replay.
        if(request.capability==='windows.private_viewer.start'&&!this.options.native){
          await executeCoreConsoleNative('probe',{},this.options.store.stopFile,new AbortController().signal);
          data=await executeWindowsPrivateViewerCapability(request.capability,request.input);
        }else data=await native(request.capability,request.input,this.options.store.stopFile,new AbortController().signal);
        outcome=signal.aborted||this.revoked||this.closed?'unknown':'succeeded';
      }catch(error){
        if(profilePrepared&&!reservationOwned){
          // This provider does not own admission. In particular, a losing
          // duplicate must not complete/revoke the winner's operation.
          // Retain the persistent marker and fence this provider locally.
          this.latchLocalStop();
          throw error;
        }
        outcome=error instanceof CoreNativeDenial?'denied':'unknown';
      }
      finally{this.inFlightDispatch=undefined;signal.removeEventListener('abort',cancel);}
      const completionProfile=this.profile;
      try{
        if(outcome==='unknown')await this.persistLocalStop();
        await this.options.authority.call(completionProfile,'complete',{...fields,outcome});
        if(outcome==='unknown')await this.revoke();
        else{
          const settled={...this.profile};delete settled.pendingDispatch;
          await this.options.store.save(settled);this.profile=settled;
        }
      }catch(error){
        // A reporting or local-settlement failure cannot bypass local fencing.
        // The write-ahead marker is not cleared until known completion.
        await this.persistLocalStop();
        await this.revoke().catch(()=>{});
        throw error;
      }
      return {requestId:request.requestId,fingerprint:request.fingerprint,outcome,data};
    });
    this.tail=work.catch(()=>{});return work;
  }
  private latchLocalStop():void{
    this.revoked=true;const monitor=this.monitor;this.monitor=undefined;this.desktop=false;monitor?.kill();
  }
  private async persistLocalStop():Promise<void>{
    this.latchLocalStop();
    await this.initialize();
    this.profile={...this.profile,pendingRevoke:true};
    // Independent local writes: one failed path cannot skip the other or the
    // subsequent external revoke. Failure never clears the pre-effect marker.
    await Promise.allSettled([this.options.store.stop(),this.options.store.save(this.profile)]);
  }
  revoke():Promise<void>{
    this.latchLocalStop();
    if(this.revoking)return this.revoking;
    const work=(async()=>{
      await this.persistLocalStop();
      await this.options.authority.call(this.profile,'revoke');
      const cleared={...this.profile,certificate:null,privateKey:null,pendingRevoke:false};
      delete cleared.pendingDispatch;
      await this.options.store.save(cleared);this.profile=cleared;
    })();
    this.revoking=work;
    void work.finally(()=>{if(this.revoking===work)this.revoking=undefined;}).catch(()=>{});
    return work;
  }
  async resumeMonitor(){await this.initialize();if(!this.closed&&!this.revoked&&this.profile.certificate&&
    !this.profile.pendingRevoke&&!this.profile.pendingDispatch)await this.startMonitor();}
  close(){this.closed=true;this.lifetime.abort();clearInterval(this.timer);this.monitor?.kill();this.options.monitor?.close();}
}

export async function createWindowsCoreConsoleAdmission(options:{deviceId:string;credential?:string;
  broker?:PrivilegedBrokerClient;env:NodeJS.ProcessEnv}):Promise<CoreConsoleAdmission>{
  const url=options.env.NEXOWIRE_CORE_AUTHORITY_URL?.trim();
  if(process.platform!=='win32'||!url||!options.credential||!options.broker)return new CoreConsoleAdmission();
  let provider:WindowsCoreConsoleProvider|undefined;
  try{
  provider=new WindowsCoreConsoleProvider({deviceId:options.deviceId,
    authority:new CoreConsoleAuthorityClient(url,options.credential),store:new WindowsCoreProfileStore(),broker:options.broker});
  const controller=new CoreConsoleAdmission(undefined,provider);
  provider.onEnrollmentRequested=async()=>{await controller.enroll(new AbortController().signal);};
  // CORE bootstrap is optional. It must not delay Agent hello, standard tools
  // or heartbeat while DPAPI/CLR initializes. Admission stays inactive meanwhile.
  const activeProvider=provider;
  void provider.initialize().then(()=>activeProvider.resumeMonitor()).then(()=>{
    activeProvider.start();
  }).catch(()=>{activeProvider.close();});
  return controller;
  }catch{provider?.close();return new CoreConsoleAdmission();}
}
