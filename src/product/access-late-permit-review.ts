import {verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import {reviewQueuedAccess,type QueuedAccessRequest,
  type QueuedAccessDependencies} from './access-queued-job-review.js';
import type {ProductDeviceRecord} from './control-plane-store.js';
import type {EffectiveOwnerSession} from './access-effective-authority.js';

/**
 * #04 dispatch-time ACCESS REVIEW, not #01/#03 executable authorization.
 * Detects #731 late validly signed permit after remote revokeAndDrain starts.
 * A successful review cannot bridge the CAS read-to-effect race; #01 must
 * atomically fence native execution in the independent remote CAS.
 */
const uuid=z.string().uuid();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const permitSchema=z.strictObject({
 kind:z.literal('broker_dispatch_permit_v1'),
 authorityId:uuid,brokerId:uuid,dispatchId:uuid,
 challengeNonce:hash,requestId:uuid,fingerprint:hash,
 capability:z.string().min(1).max(128),
 ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
 ownerEpoch:z.number().int().positive().safe(),
 generation:z.number().int().positive().safe(),
 privilege:z.enum(['CORE','ROOT']),
 issuedAtMs:z.number().int().positive().safe(),
 expiresAtMs:z.number().int().positive().safe(),
});
export type SignedBrokerDispatchPermit=z.infer<typeof permitSchema>;
export const brokerDispatchPermitSigningBytes=(p:SignedBrokerDispatchPermit):Buffer=>
  Buffer.from(JSON.stringify(permitSchema.parse(p)),'utf8');

export interface LatePermitEvidence {
 readonly payload:unknown;
 readonly signature:string;
}
const fenceSchema=z.strictObject({
 kind:z.literal('nexowire.access.dispatch-fence-readback.v1'),
 authorityId:uuid,requestId:uuid,dispatchId:uuid,
 challengeNonce:hash,ownerId:uuid,deviceId:uuid,
 deviceEpoch:uuid,sessionEpoch:uuid,
 ownerEpoch:z.number().int().positive().safe(),
 grantGeneration:z.number().int().positive().safe(),
 revoking:z.boolean(),revoked:z.boolean(),
 pendingDispatchId:uuid.nullable(),
 observedAtMs:z.number().int().positive().safe(),
 expiresAtMs:z.number().int().positive().safe(),
});
export type SignedCurrentDispatchFence=z.infer<typeof fenceSchema>;
export const dispatchFenceSigningBytes=(value:SignedCurrentDispatchFence):Buffer=>
  Buffer.from(JSON.stringify(fenceSchema.parse(value)),'utf8');
export interface LatePermitReviewDependencies extends QueuedAccessDependencies {
 /** Trust anchors are provisioned, never derived from this permit or UI. */
 readonly dispatchPermitPublicKey:KeyObject;
 readonly dispatchAuthorityId:string;
 readonly expectedBrokerId:string;
 readonly expectedFingerprint:string;
 readonly expectedCapability:string;
 /** Challenge issued at #712 remote begin, not from user preference. */
 readonly expectedPendingChallengeNonce:string;
 /** Fresh independently authenticated current CAS state AFTER delivery. */
 readonly fetchCurrentDispatchFence:(
   request:QueuedAccessRequest,
 )=>Promise<{statement:unknown;signature:string}>;
}
export type LatePermitReview = Readonly<{
 status:'DENIED'|'UNKNOWN_RECONCILE'|'CURRENT_SOURCE_ONLY_NO_EXECUTION';
 reason:string;
 coreEffectiveAtReview:boolean;
 elevatedExecutionAllowed:false;
 noPerCommandUacAfterLegitimateEnrollment:true;
 mayReplay:false;
}>;
const response=(status:LatePermitReview['status'],reason:string,
  fresh=false):LatePermitReview=>Object.freeze({
  status,reason,coreEffectiveAtReview:fresh,
  elevatedExecutionAllowed:false,
  noPerCommandUacAfterLegitimateEnrollment:true,
  mayReplay:false,
});
function validFence(
 raw:{statement:unknown;signature:string},
 permit:SignedBrokerDispatchPermit,
 job:QueuedAccessRequest,
 d:LatePermitReviewDependencies,
 now:number,
):boolean{
 try{
  const parsed=fenceSchema.safeParse(raw?.statement);
  if(!parsed.success)return false;
  const r=parsed.data;
  const sig=raw?.signature;
  if(!Number.isSafeInteger(now)||
    r.authorityId!==d.dispatchAuthorityId||
    r.requestId!==job.requestId||r.dispatchId!==permit.dispatchId||
    r.challengeNonce!==permit.challengeNonce||
    r.ownerId!==job.ownerId||r.deviceId!==job.deviceId||
    r.deviceEpoch!==job.deviceEpoch||
    r.sessionEpoch!==job.sessionEpoch||
    r.ownerEpoch!==job.ownerEpoch||
    r.grantGeneration!==job.grantGeneration||
    r.revoked!==false||r.revoking!==false||
    r.pendingDispatchId!==permit.dispatchId||
    r.observedAtMs>now+1000||now-r.observedAtMs>5000||
    r.expiresAtMs<=now||r.expiresAtMs-r.observedAtMs>5000||
    !d.independentCasPublicKey||
    d.independentCasPublicKey.type!=='public'||
    d.independentCasPublicKey.asymmetricKeyType!=='ed25519'||
    typeof sig!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(sig))return false;
  const bytes=Buffer.from(sig,'base64url');
  return bytes.length===64 && bytes.toString('base64url')===sig &&
    verify(null,dispatchFenceSigningBytes(r),
      d.independentCasPublicKey,bytes);
 }catch{return false}
}
const signed=(key:KeyObject,payload:SignedBrokerDispatchPermit,
 signature:string):boolean=>{
 try{
  if(!key||key.type!=='public'||key.asymmetricKeyType!=='ed25519'||
    typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature)){
    return false;
  }
  const bytes=Buffer.from(signature,'base64url');
  return bytes.length===64&&bytes.toString('base64url')===signature&&
    verify(null,brokerDispatchPermitSigningBytes(payload),key,bytes);
 }catch{return false}
};
/**
 * Verify late permit once delivered. Even a real Ed25519 signature and fresh
 * high-water readback is NOT an OS authorization to call the effect callback.
 */
export async function reviewLateDispatchPermit(
 job:QueuedAccessRequest,
 context:{
   device:ProductDeviceRecord;session:EffectiveOwnerSession|null;
   corePreferenceEnabled:boolean;bridgeDesiredMode:'auto'|'on'|'off';
 },
 permit:LatePermitEvidence,
 dependencies:LatePermitReviewDependencies,
):Promise<LatePermitReview>{
 if(job?.effectState==='may-have-dispatched')
   return response('UNKNOWN_RECONCILE','MAY_HAVE_EXECUTED_NO_REPLAY');
 if(job?.effectState!=='queued')return response('DENIED','NO_QUEUED_INTENT');
 try{
  const started=(dependencies.now??Date.now)();
  const parsed=permitSchema.safeParse(permit?.payload);
  if(!parsed.success||!signed(dependencies.dispatchPermitPublicKey,
    parsed.data,permit.signature))return response('DENIED','PERMIT_UNTRUSTED');
  const p=parsed.data;
  if(p.authorityId!==dependencies.dispatchAuthorityId||
    p.brokerId!==dependencies.expectedBrokerId||
    p.requestId!==job.requestId||
    p.ownerId!==job.ownerId||p.deviceId!==job.deviceId||
    p.deviceEpoch!==job.deviceEpoch||p.sessionEpoch!==job.sessionEpoch||
    p.ownerEpoch!==job.ownerEpoch||p.generation!==job.grantGeneration||
    p.privilege!==job.mode||
    p.fingerprint!==dependencies.expectedFingerprint||
    p.capability!==dependencies.expectedCapability||
    p.challengeNonce!==dependencies.expectedPendingChallengeNonce||
    !hash.safeParse(p.challengeNonce).success||
    !Number.isSafeInteger(started)||p.issuedAtMs>started+1000||
    p.expiresAtMs<=started||p.expiresAtMs-p.issuedAtMs>5000){
     return response('DENIED','PERMIT_SCOPE_OR_TIME_STALE');
  }
  // A permit signed before revoke began can arrive AFTER remote revoke began.
  // This read is separately authenticated and current at DELIVERY, not the
  // old permit signature. Must reject revoking=true (not only revoked=true).
  const beforeRaw=await dependencies.fetchCurrentDispatchFence(job);
  if(!validFence(beforeRaw,p,job,dependencies,started)){
     return response('DENIED','REVOKE_OR_REPAIR_DURING_PERMIT_DELIVERY');
  }
  // Exact native BROKER token, fresh nonce-bound CAS, D1 CORE enrollment or
  // ROOT 15-minute boundary, plus independent high-water checks.
  const checked=await reviewQueuedAccess(job,context,dependencies);
  if(checked.status!=='REVIEWED_ONLY_NO_DISPATCH'){
   return response(checked.status==='UNKNOWN_RECONCILE'
     ?'UNKNOWN_RECONCILE':'DENIED','ACCESS_FRESH_PROOF_DENIED');
  }
  const afterRaw=await dependencies.fetchCurrentDispatchFence(job);
  if(!validFence(afterRaw,p,job,dependencies,
    (dependencies.now??Date.now)())){
     return response('DENIED','REVOKE_OR_REPAIR_AFTER_ACCESS_READBACK');
  }
  const finished=(dependencies.now??Date.now)();
  if(!Number.isFinite(finished)||finished>=p.expiresAtMs||
    Date.parse(context.session?.sessionExpiresAt??'')<=finished||
    (job.mode==='ROOT'&&
     Date.parse(job.rootExpiresAt??'')<=finished)){
     return response('DENIED','ROOT_OR_PERMIT_EXPIRED_AT_DISPATCH');
  }
  // A concurrent revoke can still begin immediately after this read.
  // #712 must atomically serialize actual native begin with revokeAndDrain
  // and release a reserved late permit if external revoke already started.
  return response('CURRENT_SOURCE_ONLY_NO_EXECUTION',
    'PHYSICAL_CAS_NATIVE_ATOMIC_DISPATCH_NOT_PROVEN',job.mode==='CORE');
 }catch{
  return response('DENIED','INDEPENDENT_DISPATCH_EVIDENCE_UNAVAILABLE');
 }
}
