import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as z from 'zod';
import {CoreConsoleAdmission,type CoreConsoleStatus} from './core-console-admission.js';
import type {CoreAuthorityState} from '../protocol/core-console-authority.js';
import {writeProtectedSecretFile} from '../security/protected-secret-files.js';
import {unprotectWindowsUserSecretForPurpose} from '../security/windows-dpapi.js';
import {executeCoreConsoleNative,runCorePowerShell} from './windows-core-console-native.js';
import {requiresPhysicalConsoleGrant} from './windows-console-grant.js';
import {NEXOWIRE_VERSION} from '../version.js';

const PURPOSE='core-local-owner-v1';
const GrantSchema=z.strictObject({version:z.literal(1),installationId:z.string().uuid(),
  ownerAccountId:z.string().min(8),deviceId:z.string().min(8),
  ownerEpoch:z.number().int().positive(),grantGeneration:z.number().int().positive(),
  revokeEpoch:z.number().int().nonnegative(),approvedAtMs:z.number().int().positive(),
  expiresAt:z.null()});
export type LocalOwnerCoreGrant=z.infer<typeof GrantSchema>;
export interface LocalOwnerCoreStore {
  readonly stopFile:string;
  load():Promise<LocalOwnerCoreGrant|null>;
  save(grant:LocalOwnerCoreGrant):Promise<void>;
  stopped():Promise<boolean>;
  stop():Promise<void>;
  clearStop():Promise<void>;
  reserve(requestId:string):Promise<void>;
}

/** Local owner consent, not an independent native attestation or an admin token.
 * Windows DPAPI preserves the same user's consent over Agent/OS restarts.
 * Requests still pass normal Hub authorization and native desktop checks. */
export class WindowsLocalOwnerCoreStore implements LocalOwnerCoreStore {
  readonly stopFile:string;
  private readonly file:string;
  constructor(private readonly root=path.join(os.homedir(),'.nexowire','core-local-owner')){
    this.stopFile=path.join(root,'STOP');this.file=path.join(root,'grant.dpapi.json');
  }
  async load(){
    let raw:string;
    try{raw=await fs.readFile(this.file,'utf8');}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    const e=z.strictObject({version:z.literal(1),purpose:z.literal(PURPOSE),
      protection:z.literal('windows-dpapi-current-user'),ciphertext:z.string().max(16384)})
      .parse(JSON.parse(raw));
    return GrantSchema.parse(JSON.parse(await unprotectWindowsUserSecretForPurpose(e.ciphertext,PURPOSE)));
  }
  async save(grant:LocalOwnerCoreGrant){
    await writeProtectedSecretFile(this.file,PURPOSE,JSON.stringify(GrantSchema.parse(grant)),{overwrite:true});
  }
  async stopped(){try{await fs.stat(this.stopFile);return true;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
  async stop(){await fs.mkdir(this.root,{recursive:true});await fs.writeFile(this.stopFile,'STOP');}
  async clearStop(){await fs.rm(this.stopFile,{force:true});}
  async reserve(requestId:string){
    const dir=path.join(this.root,'requests');await fs.mkdir(dir,{recursive:true});
    const fd=await fs.open(path.join(dir,requestId),'wx',0o600);
    try{await fd.writeFile('INTENT_NO_REPLAY');await fd.sync();}finally{await fd.close();}
  }
}

export class LocalOwnerCoreConsole extends CoreConsoleAdmission {
  private installationId:string=randomUUID();
  private readonly lifetime=new AbortController();
  private effects=new AbortController();
  private epoch=0;
  private prompting=false;
  constructor(private readonly options:{deviceId:string;store:LocalOwnerCoreStore;
    read:(installationId:string,signal:AbortSignal)=>Promise<CoreAuthorityState>;
    probe:()=>Promise<{reachable:boolean;elevated:boolean;version:string|null}>;
    approve:(deviceId:string,signal:AbortSignal)=>Promise<boolean>;
    native?:(capability:string,input:unknown,stopFile:string,signal:AbortSignal)=>Promise<unknown>;
  }){super();}
  override get installed(){return true;}
  private async current(signal:AbortSignal){
    const grant=await this.options.store.load();
    if(grant)this.installationId=grant.installationId;
    const state=await this.options.read(this.installationId,signal);
    if(state.deviceId!==this.options.deviceId||state.installationId!==this.installationId)
      throw Error('CORE_OWNER_DEVICE_MISMATCH');
    return {grant,state};
  }
  private same(grant:LocalOwnerCoreGrant,state:CoreAuthorityState){
    return grant.deviceId===state.deviceId&&grant.ownerAccountId===state.ownerAccountId&&
      grant.installationId===state.installationId&&grant.ownerEpoch===state.ownerEpoch&&
      grant.grantGeneration===state.grantGeneration&&grant.revokeEpoch===state.revokeEpoch;
  }
  override async status(accessMode:'safe'|'full'):Promise<CoreConsoleStatus>{
    let result:CoreConsoleStatus={preferenceEnabled:null,localEnrolled:false,active:false,
      duration:'indefinite-revocable',expiresAt:null,state:'LOCAL_ENROLLMENT_REQUIRED'};
    if(accessMode!=='full')return {...result,state:'SAFE_MODE'};
    try{
      const {grant,state}=await this.current(AbortSignal.timeout(10000));
      result={...result,preferenceEnabled:state.coreEnabled};
      if(this.lifetime.signal.aborted||await this.options.store.stopped())return {...result,state:'REVOKED_LOCALLY'};
      if(grant&&!this.same(grant,state))return {...result,state:'CORE_OWNER_OR_GRANT_CHANGED'};
      if(!state.coreEnabled||state.accessMode!=='full')return {...result,state:'CORE_NOT_EFFECTIVE'};
      if(!grant)return result;
      result={...result,localEnrolled:true};
      const broker=await this.options.probe();
      if(!broker.reachable||!broker.elevated||broker.version!==NEXOWIRE_VERSION)
        return {...result,state:'CORE_BROKER_VERIFICATION_REQUIRED'};
      if(!state.deviceOnline)return {...result,state:'CORE_DEVICE_OFFLINE'};
      return {...result,active:true,state:'ACTIVE_LOCAL_OWNER'};
    }catch{return {...result,state:'CORE_CURRENT_STATE_UNAVAILABLE'};}
  }
  override async enroll(signal:AbortSignal){
    if(this.prompting)throw Error('CORE_ENROLLMENT_PROMPT_ACTIVE');
    this.prompting=true;const epoch=this.epoch;
    try{
      const before=await this.current(signal);
      if(!before.state.coreEnabled||before.state.accessMode!=='full')throw Error('CORE_OWNER_ENABLE_REQUIRED');
      if((await this.status('full')).active)return true;
      if(!await this.options.approve(this.options.deviceId,signal)||signal.aborted||epoch!==this.epoch)return false;
      const after=await this.current(signal);
      const grant:LocalOwnerCoreGrant={version:1,installationId:this.installationId,
        ownerAccountId:before.state.ownerAccountId,deviceId:this.options.deviceId,
        ownerEpoch:before.state.ownerEpoch,grantGeneration:before.state.grantGeneration,
        revokeEpoch:before.state.revokeEpoch,approvedAtMs:Date.now(),expiresAt:null};
      if(!this.same(grant,after.state)||!after.state.coreEnabled||after.state.accessMode!=='full')
        throw Error('CORE_CHANGED_DURING_LOCAL_CONSENT');
      await this.options.store.save(grant);
      if(signal.aborted||epoch!==this.epoch){await this.options.store.stop();return false;}
      await this.options.store.clearStop();
      if(signal.aborted||epoch!==this.epoch){await this.options.store.stop();return false;}
      this.effects=new AbortController();
      return true;
    }finally{this.prompting=false;}
  }
  override async revoke(){++this.epoch;this.effects.abort();await this.options.store.stop();}
  override close(){this.lifetime.abort();}
  override async execute(capability:string,input:unknown,requestId:string|undefined,
    accessMode:'safe'|'full',requestSignal?:AbortSignal):Promise<unknown>{
    if(!requiresPhysicalConsoleGrant(capability))throw Error('CORE_CONSOLE_SCOPE_DENIED');
    const id=z.string().uuid().parse(requestId);
    const epoch=this.epoch;
    const signal=AbortSignal.any([this.lifetime.signal,this.effects.signal,AbortSignal.timeout(30000),
      ...(requestSignal?[requestSignal]:[])]);
    const snapshot=structuredClone(input);
    if(!(await this.status(accessMode)).active||signal.aborted)throw Error('CORE_NOT_ACTIVE');
    await this.options.store.reserve(id);
    if(!(await this.status(accessMode)).active||epoch!==this.epoch||signal.aborted)throw Error('CORE_REVOKED');
    return (this.options.native??executeCoreConsoleNative)(capability,snapshot,this.options.store.stopFile,signal);
  }
}

export async function approveLocalOwnerCore(deviceId:string,signal:AbortSignal):Promise<boolean>{
  const result=await runCorePowerShell(String.raw`Add-Type -AssemblyName System.Windows.Forms
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$text="Bu cihazda Nexowire fiziksel kontrolüne süresiz izin verilsin mi?\nCihaz: "+$p.deviceId+"\nYeniden başlatmada korunur. Nexowire CORE KAPAT veya console_control_revoke ile iptal edilir.\nWindows yönetici/UAC yetkisini değiştirmez."
@{approved=([System.Windows.Forms.MessageBox]::Show($text,'Nexowire kalıcı CORE','YesNo','Question','Button2') -eq 'Yes')}|ConvertTo-Json -Compress`,{deviceId},signal,120000);
  return !!result&&typeof result==='object'&&'approved' in result&&result.approved===true;
}
