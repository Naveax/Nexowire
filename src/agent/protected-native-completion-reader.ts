import {createHash,createPublicKey,randomBytes,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {BrokerDispatchRequest,DispatchRevokeRequest} from './broker-external-dispatch-fence.js';
import type {DispatchStoreConnection} from './postgres-broker-dispatch-authority.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const positive=z.number().int().positive().safe();
const scope=z.strictObject({ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:positive,expectedGeneration:positive,requiredPrivilege:z.enum(['CORE','ROOT'])});
const request=z.strictObject({requestId:uuid,fingerprint:sha,capability:z.string().min(1).max(128),scope});
const proof=z.strictObject({version:z.literal(1),kind:z.literal('core_native_effect_completion_v1'),
  authorityId:uuid,dispatchId:uuid,brokerId:uuid,commitNonce:sha,request,
  outcome:z.literal('TERMINAL_DRAINED'),evidenceKind:z.enum(['JOB_OBJECT_EMPTY','NATIVE_OPERATION_TERMINAL']),
  evidenceSha256:sha,completedAtMs:positive});
export type NativeEffectCompletionProof=z.infer<typeof proof>;
export interface ProtectedNativeCompletionConfig{
  readonly observerPublicKeyPem:string;
  /** A separately reviewed capability-specific OS observer policy. No
   * default mapping from approval helper drain or generic JS completion. */
  readonly evidenceByCapability:Readonly<Record<string,NativeEffectCompletionProof['evidenceKind']>>;
}
export interface NativeCompletionClaim{
  authorityId:string;dispatchId:string;brokerId:string;commitNonce:string;
  request:BrokerDispatchRequest;reservedAtMs:number;
}
const b64=(value:unknown,min:number,max:number):Buffer|undefined=>{
  if(typeof value!=='string'||value.length>max*2||!/^[A-Za-z0-9_-]+$/.test(value))return;
  const data=Buffer.from(value,'base64url');
  if(data.length<min||data.length>max||data.toString('base64url')!==value)return;
  return data;
};
function same(a:BrokerDispatchRequest,b:BrokerDispatchRequest){
  return a.requestId===b.requestId&&a.fingerprint===b.fingerprint&&a.capability===b.capability&&
    (Object.keys(a.scope) as Array<keyof typeof a.scope>).every(k=>a.scope[k]===b.scope[k]);
}
export class ProtectedNativeCompletionReader{
  private readonly key:KeyObject;private readonly pin:string;
  private readonly kinds:Readonly<Record<string,NativeEffectCompletionProof['evidenceKind']>>;
  constructor(config:ProtectedNativeCompletionConfig){
    this.key=createPublicKey(config.observerPublicKeyPem);
    if(this.key.asymmetricKeyType!=='ed25519')throw Error('DISPATCH_NATIVE_COMPLETION_SIGNER_INVALID');
    this.pin=createHash('sha256').update(this.key.export({type:'spki',format:'der'})).digest('hex');
    const kinds=Object.entries(config.evidenceByCapability);
    if(!kinds.length||kinds.length>128||kinds.some(([k,v])=>!k||k.length>128||
      (v!=='JOB_OBJECT_EMPTY'&&v!=='NATIVE_OPERATION_TERMINAL')))
      throw Error('DISPATCH_NATIVE_COMPLETION_POLICY_INVALID');
    this.kinds=Object.freeze(Object.assign(Object.create(null),Object.fromEntries(kinds)));
  }
  async checkPolicy(db:DispatchStoreConnection,authorityId:string,capability:string):Promise<boolean>{
    if(!Object.hasOwn(this.kinds,capability))return false;
    // Neither the dispatch role nor an inherited role may manufacture proof or
    // change signer policy. The policy row is provisioned by the operator.
    const roles=await db.query("SELECT NOT (has_any_column_privilege(current_user,'core_dispatch.native_completion_policy','INSERT,UPDATE,REFERENCES') OR "+
      "has_table_privilege(current_user,'core_dispatch.native_completion_policy','DELETE,TRUNCATE,TRIGGER') OR "+
      "has_any_column_privilege(current_user,'core_dispatch.native_effect_completions','INSERT,UPDATE,REFERENCES') OR "+
      "has_table_privilege(current_user,'core_dispatch.native_effect_completions','DELETE,TRUNCATE,TRIGGER')) AS restricted");
    if(roles.rows.length!==1||roles.rows[0]?.restricted!==true)return false;
    const policy=await db.query('SELECT signer_spki_sha256 FROM core_dispatch.native_completion_policy WHERE authority_id=$1',[authorityId]);
    return policy.rows.length===1&&policy.rows[0]?.signer_spki_sha256===this.pin;
  }
  verifyRecord(value:unknown,signature:unknown,claim:NativeCompletionClaim,now:number):boolean{
    try{
      const bytes=b64(value,1,12288),sig=b64(signature,64,64);
      if(!bytes||!sig||!verify(null,bytes,this.key,sig))return false;
      const p=proof.parse(JSON.parse(bytes.toString('utf8')));
      return p.authorityId===claim.authorityId&&p.dispatchId===claim.dispatchId&&
        p.brokerId===claim.brokerId&&p.commitNonce===claim.commitNonce&&same(p.request,claim.request)&&
        Object.hasOwn(this.kinds,p.request.capability)&&p.evidenceKind===this.kinds[p.request.capability]&&
        p.completedAtMs>=claim.reservedAtMs&&p.completedAtMs<=now;
    }catch{return false;}
  }
  async hasCompletion(db:DispatchStoreConnection,claim:NativeCompletionClaim,now:number):Promise<boolean>{
    if(!await this.checkPolicy(db,claim.authorityId,claim.request.capability))return false;
    const result=await db.query('SELECT payload,signature FROM core_dispatch.native_effect_completions '+
      'WHERE authority_id=$1 AND request_id=$2 AND dispatch_id=$3 AND commit_nonce=$4',
      [claim.authorityId,claim.request.requestId,claim.dispatchId,claim.commitNonce]);
    return result.rows.length===1&&this.verifyRecord(result.rows[0]?.payload,result.rows[0]?.signature,claim,now);
  }
}

/** Separate domain from individual effect completion. A signed receipt is
 * meaningful only when the independently installed observer actually owns
 * and verifies the OS containment/terminal boundaries. This reader has no
 * signing key and never manufactures a receipt from a boolean or DB count. */
const drainProof=z.strictObject({
  version:z.literal(1),kind:z.literal('core_native_drain_readback_v1'),
  authorityId:uuid,nonce:sha,ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  previousGeneration:positive,generation:positive,ownerApprovalSha256:sha,
  permanentFence:z.literal(true),pendingNativeEffects:z.literal(0),
  outcome:z.literal('TERMINAL_DRAINED'),evidenceSha256:sha,observedAtMs:positive
});
const drainEnvelope=z.strictObject({payload:z.string().min(1).max(16384),signature:z.string().length(86)});
export type ProtectedNativeDrainReadback=(request:Readonly<DispatchRevokeRequest>,
  nonce:string,signal:AbortSignal)=>Promise<unknown>;

/** Pin the independent completion observer's key. Require a fresh signed
 * nonce, exact revoked scope and authorization generation. No default
 * observer, local signer or transport fallback is installed here. */
export function createProtectedNativeDrainVerifier(config:{
  authorityId:string;observerPublicKeyPem:string;readback:ProtectedNativeDrainReadback
}){
  const authorityId=uuid.parse(config.authorityId),key=createPublicKey(config.observerPublicKeyPem);
  if(key.asymmetricKeyType!=='ed25519'||typeof config.readback!=='function')
    throw Error('DISPATCH_NATIVE_DRAIN_OBSERVER_REQUIRED');
  const read=config.readback;
  return async(request:DispatchRevokeRequest,signal?:AbortSignal):Promise<boolean>=>{
    const active=signal??new AbortController().signal;
    const wanted=Object.freeze({...request});
    const nonce=randomBytes(32).toString('hex'),started=Date.now(),startMono=process.hrtime.bigint();
    try{
      active.throwIfAborted();
      if(!Number.isSafeInteger(wanted.expectedGeneration)||wanted.expectedGeneration<1||
        wanted.expectedGeneration>=Number.MAX_SAFE_INTEGER)return false;
      const raw=drainEnvelope.parse(await read(wanted,nonce,active));
      active.throwIfAborted();
      const bytes=b64(raw.payload,1,12288),sig=b64(raw.signature,64,64);
      if(!bytes||!sig||!verify(null,bytes,key,sig))return false;
      const proof=drainProof.parse(JSON.parse(bytes.toString('utf8'))),now=Date.now();
      return !active.aborted&&process.hrtime.bigint()-startMono<5000000000n&&
        now>=started&&now-started<5000&&proof.observedAtMs>=started&&proof.observedAtMs<=now&&
        proof.authorityId===authorityId&&proof.nonce===nonce&&
        proof.ownerId===wanted.ownerId&&proof.deviceId===wanted.deviceId&&
        proof.deviceEpoch===wanted.deviceEpoch&&proof.sessionEpoch===wanted.sessionEpoch&&
        proof.previousGeneration===wanted.expectedGeneration&&proof.generation===wanted.expectedGeneration+1&&
        proof.ownerApprovalSha256===createHash('sha256').update(wanted.signedOwnerApproval,'utf8').digest('hex');
    }catch{return false}
  };
}
