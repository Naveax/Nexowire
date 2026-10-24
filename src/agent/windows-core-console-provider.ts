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
import {readProtectedSecretFile,writeProtectedSecretFile} from '../security/protected-secret-files.js';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';
import {CORE_NATIVE_DEFINITION,CORE_POWERSHELL,executeCoreConsoleNative,runCorePowerShell,parseCoreNativeInput,CoreNativeDenial} from './windows-core-console-native.js';
import type {PrivilegedBrokerClient} from './privileged-broker-client.js';
import {NEXOWIRE_VERSION} from '../version.js';
import {executeWindowsPrivateViewerCapability} from './windows-private-viewer.js';
import {revokePhysicalConsoleGrant} from './windows-console-grant.js';

const PURPOSE='core-console-profile-v1';
interface Profile {version:1;installationId:string;deviceId:string;authorityUrl:string;
  certificate:SignedCoreConsoleEnrollmentV1|null;privateKey:string|null;pendingRevoke:boolean}
const ProfileSchema=z.strictObject({version:z.literal(1),installationId:z.string().uuid(),
  deviceId:z.string().min(8).max(128),authorityUrl:z.string().url(),
  certificate:z.unknown().nullable(),privateKey:z.string().max(256).nullable(),pendingRevoke:z.boolean()});
export interface CoreProfileStore {load():Promise<Profile|null>;save(profile:Profile):Promise<void>;
  stop():Promise<void>;clearStop():Promise<void>;stopped():Promise<boolean>;readonly stopFile:string;
  block?():Promise<void>;clearBlock?():Promise<void>;blocked?():Promise<boolean>}

/** CurrentUser DPAPI protects this physical-console key; it is NOT a HIGH token
 * or protection from malicious code already running as the Windows owner.
 * No key, plaintext profile or enrollment certificate comes from a tool input. */
export class WindowsCoreProfileStore implements CoreProfileStore {
  readonly stopFile:string;private readonly file:string;
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
$owner=(Get-Acl -LiteralPath $dir.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){throw 'CORE_PROFILE_OWNER_CHANGED'}
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dir.FullName -AclObject $acl
@{protected=$true}|ConvertTo-Json -Compress`;
    await runCorePowerShell(script,{root:this.root},undefined,15000);
  }
  async load(){
    try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('CORE_PROFILE_INVALID');}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    const parsed=ProfileSchema.parse(JSON.parse(readProtectedSecretFile(this.file,PURPOSE,'CORE console')));
    const profile=parsed as Profile;
    if(profile.certificate){
      if(!profile.privateKey)throw new Error('CORE_PRIVATE_KEY_MISSING');
      const key=createPrivateKey({key:Buffer.from(profile.privateKey,'base64'),type:'pkcs8',format:'der'});
      const spki=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
      verifyCoreCertificate(profile.certificate,spki);
      if(profile.certificate.enrollment.installationId!==profile.installationId||
        profile.certificate.enrollment.deviceId!==profile.deviceId)throw new Error('CORE_PROFILE_BINDING_CHANGED');
    }
    return profile;
  }
  async save(profile:Profile){
    await this.protectDirectory();
    await writeProtectedSecretFile(this.file,PURPOSE,JSON.stringify(profile),{overwrite:true});
  }
  async stop(){await fs.mkdir(this.root,{recursive:true,mode:0o700});
    try{await fs.writeFile(this.stopFile,'STOP',{flag:'wx',mode:0o600});}
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
const consentScript=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$message='Bu PC için süresiz, geri alınabilir fiziksel kontrol izni verilsin mi?'+[Environment]::NewLine+[Environment]::NewLine+
 'Sahip: '+$p.owner+[Environment]::NewLine+'Cihaz: '+$p.device+[Environment]::NewLine+'Yetki sunucusu: '+$p.authority+[Environment]::NewLine+[Environment]::NewLine+
 'Fare, klavye ve pencere kontrolü. Sistem tepsisindeki Nexowire CORE simgesinden istediğiniz an KAPATIN. Windows kilidi, UAC ve yönetici izinleri değişmez.'
$result=[System.Windows.Forms.MessageBox]::Show($message,'Nexowire CORE - yerel ilk onay',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning,[System.Windows.Forms.MessageBoxDefaultButton]::Button2)
@{approved=($result -eq [System.Windows.Forms.DialogResult]::Yes)}|ConvertTo-Json -Compress
`;

export interface WindowsCoreProviderOptions {
  deviceId:string;authority:CoreConsoleAuthorityClient;store:CoreProfileStore;
  broker:Pick<PrivilegedBrokerClient,'probe'>;
  consent?:(binding:CoreConsoleBinding,signal:AbortSignal)=>Promise<boolean>;
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
  onEnrollmentRequested?:()=>Promise<void>;
  constructor(private readonly options:WindowsCoreProviderOptions){}
  async initialize(){
    this.profile=await this.options.store.load()??{version:1,deviceId:this.options.deviceId,
      installationId:randomUUID(),authorityUrl:this.options.authority.url,certificate:null,privateKey:null,pendingRevoke:false};
    if(this.profile.deviceId!==this.options.deviceId||this.profile.authorityUrl!==this.options.authority.url)
      throw new Error('CORE_AUTHORITY_OR_DEVICE_REBOUND');
    if(this.profile.certificate){const e=this.profile.certificate.enrollment;
      this.binding={ownerAccountId:e.ownerAccountId,deviceId:e.deviceId,installationId:e.installationId};}
    if(this.profile.pendingRevoke)this.revoked=true;
  }
  start(){
    this.timer=setInterval(()=>{if(this.pollBusy||this.closed)return;this.pollBusy=true;
      void this.poll().catch(async()=>{this.desktop=false;await this.options.store.block?.();}).catch(()=>{}).finally(()=>{this.pollBusy=false;});},2000);this.timer.unref();
    void this.poll().catch(async()=>{await this.options.store.block?.();}).catch(()=>{});
  }
  private async poll(){
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
    return !!e&&state.coreEnabled&&state.accessMode==='full'&&state.ownerAccountId===e.ownerAccountId&&
      state.deviceId===e.deviceId&&state.installationId===e.installationId&&state.enrollmentId===e.enrollmentId&&
      state.ownerEpoch===e.ownerEpoch&&state.grantGeneration===e.grantGeneration&&state.revokeEpoch===e.revokeEpoch&&
      !!state.publicKeySpki&&createHash('sha256').update(Buffer.from(state.publicKeySpki,'base64')).digest('hex')===e.issuerSpkiSha256;}
  private spki(){if(!this.profile.privateKey)return null;
    // Derive the public key from the DPAPI-protected private key, never a request pin.
    return createPublicKey(createPrivateKey({key:Buffer.from(this.profile.privateKey,'base64'),format:'der',type:'pkcs8'})).export({format:'der',type:'spki'});}
  private allowedDesktop(){return this.options.monitor?.desktopAllowed()??
    (!!this.monitor&&this.desktop&&Date.now()-this.monitorAt<3500);}
  async inspect(signal:AbortSignal):Promise<CoreConsoleEvidence>{
    const observedAtMs=Date.now();
    const state=await this.options.authority.call(this.profile,'read',{},signal);
    const local=await this.options.store.load();
    if(!this.profile.certificate)this.binding={ownerAccountId:state.ownerAccountId,deviceId:this.profile.deviceId,installationId:this.profile.installationId};
    const probe=await this.options.broker.probe();
    const bridge=probe.reachable===true&&probe.elevated===true&&probe.version===NEXOWIRE_VERSION;
    const pinned=this.spki();
    const localValid=local?.certificate?.signatureBase64===this.profile.certificate?.signatureBase64&&!local?.pendingRevoke;
    return {certificate:this.revoked||!localValid||!this.matches(state)||await this.options.store.stopped()||await this.options.store.blocked?.()?null:this.profile.certificate,
      pinnedLocalSpkiDer:pinned,
      current:{...this.current(state),bridgeVerified:state.bridgeVerified&&bridge},
      observedAtMs,desktop:this.allowedDesktop()?'default':'unknown',
      nativeAdmission:bridge&&this.allowedDesktop()?'verified':'unavailable'} as CoreConsoleEvidence;
  }
  private eligible(e:CoreConsoleEvidence){if(!this.binding)return false;return evaluateCoreConsoleEnrollment({certificate:e.certificate,
    pinnedLocalSpkiDer:e.pinnedLocalSpkiDer,trustedCurrentReadback:e.current,
    requestedOwnerAccountId:this.binding.ownerAccountId,requestedDeviceId:this.binding.deviceId,
    requestedInstallationId:this.binding.installationId,nowMs:Date.now(),desktop:e.desktop}).policyEligible;}
  private async startMonitor(){
    if(this.options.monitor)return;
    if(this.monitor)return;
    const child=spawn(CORE_POWERSHELL,['-NoLogo','-NoProfile','-STA','-Command',monitorScript],{
      shell:false,cwd:'C:\\Windows\\System32',windowsHide:true,env:windowsDpapiChildEnvironment(),stdio:['pipe','pipe','pipe']});
    this.monitor=child;let buffer='';
    let ready!:()=>void,failed!:(e:Error)=>void;
    const startup=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
    const timeout=setTimeout(()=>failed(new Error('CORE_LOCAL_MONITOR_TIMEOUT')),15000);
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
    if(this.pending)throw new Error('CORE_ENROLLMENT_PROMPT_ACTIVE');this.pending=true;
    try{
      const state=await this.options.authority.call(this.profile,'read',{},signal);
      if(!state.coreEnabled||state.accessMode!=='full'||!state.deviceOnline)throw new Error('CORE_OWNER_ENABLE_REQUIRED');
      const bridge=await this.options.broker.probe();
      if(!bridge.reachable||!bridge.elevated||bridge.version!==NEXOWIRE_VERSION)throw new Error('CORE_BROKER_VERIFICATION_REQUIRED');
      if(this.profile.certificate&&this.matches(state)&&!this.revoked&&!(await this.options.store.stopped()))return true;
      if(!this.options.native)await executeCoreConsoleNative('probe',{},'',signal);
      const binding={ownerAccountId:state.ownerAccountId,deviceId:this.profile.deviceId,installationId:this.profile.installationId};
      const decision=this.options.consent?await this.options.consent(binding,signal):
        (await runCorePowerShell(consentScript,{owner:binding.ownerAccountId,device:binding.deviceId,authority:this.options.authority.url},signal,120000) as {approved?:boolean}).approved===true;
      await this.options.authority.call(this.profile,'dismiss',{},signal);
      if(!decision||signal.aborted)return false;
      if(!this.options.native)await executeCoreConsoleNative('probe',{},'',signal);
      // Recheck all epochs AFTER the local user made a decision.
      const fresh=await this.options.authority.call(this.profile,'read',{},signal);
      if(JSON.stringify(this.current(state))!==JSON.stringify(this.current(fresh)))throw new Error('CORE_CHANGED_DURING_LOCAL_CONSENT');
      await this.revoke();
      // A new local consent never clears STOP while an old native operation
      // could still be running. Drain the bounded native worker first.
      await this.tail;
      const latest=await this.options.authority.call(this.profile,'read',{},signal);
      const key=generateKeyPairSync('ed25519');const der=key.publicKey.export({type:'spki',format:'der'});
      const enrollment={version:1 as const,scope:'physical-console' as const,...binding,
        enrollmentId:randomUUID(),ownerEpoch:latest.ownerEpoch,grantGeneration:latest.grantGeneration,
        revokeEpoch:latest.revokeEpoch,approvedLocallyAtMs:Date.now(),issuerSpkiSha256:createHash('sha256').update(der).digest('hex')};
      const profile:Profile={...this.profile,privateKey:key.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),pendingRevoke:false,
        certificate:{enrollment,signatureBase64:sign(null,canonicalCoreConsoleEnrollment(enrollment),key.privateKey).toString('base64')}};
      // Persist first: failure/ACK loss never manufactures ACTIVE. A later read
      // must match the independently registered enrollment ID and issuer key.
      await this.options.store.save(profile);this.profile=profile;
      await this.options.authority.call(profile,'enroll',{certificate:profile.certificate,publicKeySpki:der.toString('base64')},signal);
      this.binding=binding;this.revoked=false;await this.options.store.clearStop();await this.options.store.clearBlock?.();await this.startMonitor();return true;
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
      await this.options.authority.call(this.profile,'reserve',fields,signal);
      const cancel=()=>{void this.options.store.stop();};signal.addEventListener('abort',cancel,{once:true});
      let outcome:'succeeded'|'denied'|'unknown'='unknown';let data:unknown;
      try{
        await this.options.authority.call(this.profile,'claim',fields,signal);
        const native=this.options.native??executeCoreConsoleNative;
        // The marker lets native cleanup release pressed keys before exiting.
        // Cancellation does not grant a new request or permit a blind replay.
        if(request.capability==='windows.private_viewer.start'&&!this.options.native){
          await executeCoreConsoleNative('probe',{},this.options.store.stopFile,new AbortController().signal);
          data=await executeWindowsPrivateViewerCapability(request.capability,request.input);
        }else data=await native(request.capability,request.input,this.options.store.stopFile,new AbortController().signal);
        outcome=signal.aborted?'unknown':'succeeded';
      }catch(error){outcome=error instanceof CoreNativeDenial?'denied':'unknown';}
      finally{signal.removeEventListener('abort',cancel);}
      await this.options.authority.call(this.profile,'complete',{...fields,outcome});
      if(outcome==='unknown')await this.revoke();
      return {requestId:request.requestId,fingerprint:request.fingerprint,outcome,data};
    });
    this.tail=work.catch(()=>{});return work;
  }
  revoke():Promise<void>{
    this.revoked=true;const monitor=this.monitor;this.monitor=undefined;this.desktop=false;monitor?.kill();
    if(this.revoking)return this.revoking;
    const work=(async()=>{
      await this.options.store.stop();
      this.profile={...this.profile,pendingRevoke:true};await this.options.store.save(this.profile);
      await this.options.authority.call(this.profile,'revoke');
      this.profile={...this.profile,certificate:null,privateKey:null,pendingRevoke:false};await this.options.store.save(this.profile);
    })();
    this.revoking=work;
    void work.finally(()=>{if(this.revoking===work)this.revoking=undefined;}).catch(()=>{});
    return work;
  }
  async resumeMonitor(){if(this.profile.certificate&&!this.profile.pendingRevoke)await this.startMonitor();}
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
  await provider.initialize();await provider.resumeMonitor();
  const controller=new CoreConsoleAdmission(undefined,provider);
  provider.onEnrollmentRequested=async()=>{await controller.enroll(new AbortController().signal);};
  provider.start();return controller;
  }catch{provider?.close();return new CoreConsoleAdmission();}
}
