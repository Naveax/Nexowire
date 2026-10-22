import {randomBytes,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import {
  reviewLateDispatchPermit,type LatePermitEvidence,
  type LatePermitReviewDependencies,
} from './access-late-permit-review.js';
import {
  verifiesInstalledBrokerNonce,
  type SignedInstalledBrokerNonceRecord,
} from './access-native-broker-proof.js';
import type {QueuedAccessRequest} from './access-queued-job-review.js';
import type {EffectiveOwnerSession} from './access-effective-authority.js';
import type {ProductDeviceRecord} from './control-plane-store.js';

/**
 * #04 Access owner boundary CONTRACT, not the native executor.
 * A signed final CAS grant alone does not guarantee the source callback
 * was atomically serialized with a Windows native effect (#731/#747).
 * No production trusted provider is installed; even all-positive synthetic
 * fixtures return canLaunch:false. Physical admission remains NO-GO.
 */
const uuid=z.string().uuid();
const sha=z.string().regex(/^[0-9a-f]{64}$/);
const finalGrant=z.strictObject({
  kind:z.literal('nexowire.access.final-native-effect-grant.v1'),
  authorityId:uuid,requestId:uuid,dispatchId:uuid,
  brokerId:uuid,finalNonce:sha,permitNonce:sha,
  fingerprint:sha,capability:z.string().min(1).max(128),
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  privilege:z.enum(['CORE','ROOT']),
  installedBrokerPid:z.number().int().positive().safe(),
  installedBrokerCreationFiletime:z.string().regex(/^[1-9][0-9]{9,19}$/),
  installedImageSha256:sha,
  ownerRevoked:z.literal(false),
  revoking:z.literal(false),
  /** Claim from independent native/CAS authority, not physical proof alone. */
  reservationState:z.literal('FINAL_NATIVE_EFFECT_FENCED'),
  issuedAtMs:z.number().int().positive().safe(),
  expiresAtMs:z.number().int().positive().safe(),
});
export type FinalNativeEffectGrant=z.infer<typeof finalGrant>;
export const finalGrantSigningBytes=(raw:FinalNativeEffectGrant):Buffer=>
  Buffer.from(JSON.stringify(finalGrant.parse(raw)),'utf8');
export interface SignedFinalNativeGrant {
  statement:unknown;
  signature:string;
}
export interface FinalDispatchDependencies extends LatePermitReviewDependencies {
  /** Pinned independent external CAS signer, never from client/Agent. */
  finalGrantPublicKey:KeyObject;
  /**
   * The protected native process must be re-attested at the final launch
   * boundary with a new nonce, not recycled from the queued readback.
   */
  readNativeAtLaunch:(request:QueuedAccessRequest,
    nonce:string)=>Promise<SignedInstalledBrokerNonceRecord>;
  /**
   * Source-only external adapter. Only a deployed atomic native+CAS owner
   * with protected signer custody can eventually implement this safely.
   * This callback NEVER directly launches any process or executes effects.
   */
  getFinalExternalGrant:(request:QueuedAccessRequest,
    nonce:string,permitNonce:string,dispatchId:string,
  )=>Promise<SignedFinalNativeGrant>;
}
export interface FinalDispatchReview {
  status:'DENIED'|'UNKNOWN_RECONCILE'|'FINAL_SOURCE_CANDIDATE_ONLY';
  reason:string;
  dispatchEffective:false;
  canLaunch:false;
  canReplay:false;
  noRepeatedUacAfterApprovedCore:true;
}
const result=(status:FinalDispatchReview['status'],reason:string):FinalDispatchReview=>
  Object.freeze({
    status,reason,dispatchEffective:false,canLaunch:false,canReplay:false,
    noRepeatedUacAfterApprovedCore:true,
  });
function verified(
  value:SignedFinalNativeGrant,
  pub:KeyObject,
):FinalNativeEffectGrant|null {
  try{
    const parsed=finalGrant.safeParse(value?.statement);
    if(!parsed.success||!pub||pub.type!=='public'||
      pub.asymmetricKeyType!=='ed25519'||typeof value.signature!=='string'||
      !/^[A-Za-z0-9_-]{86}$/.test(value.signature))return null;
    const decoded=Buffer.from(value.signature,'base64url');
    if(decoded.length!==64||decoded.toString('base64url')!==value.signature||
      !verify(null,finalGrantSigningBytes(parsed.data),pub,decoded))return null;
    return parsed.data;
  }catch{return null}
}
/**
 * Do not promote UI CORE EFFECTIVE or a previously valid signed permit into
 * authorization. The final source result is *never* an executable permit:
 * actual native launch must live inside independently deployed atomic
 * revoke-vs-effect machinery, owned by #01/#03.
 */
export async function reviewFinalDispatchAuthority(
  job:QueuedAccessRequest,
  context:{
    device:ProductDeviceRecord;session:EffectiveOwnerSession|null;
    corePreferenceEnabled:boolean;bridgeDesiredMode:'auto'|'on'|'off';
  },
  permit:LatePermitEvidence,
  dependencies:FinalDispatchDependencies,
):Promise<FinalDispatchReview>{
  if(job?.effectState==='may-have-dispatched'){
    return result('UNKNOWN_RECONCILE','POTENTIALLY_DISPATCHED_DO_NOT_REPLAY');
  }
  if(job?.effectState!=='queued')return result('DENIED','JOB_NOT_QUEUED');
  try{
    const late=await reviewLateDispatchPermit(job,context,permit,dependencies);
    if(late.status!=='CURRENT_SOURCE_ONLY_NO_EXECUTION'){
      return result(late.status==='UNKNOWN_RECONCILE'?'UNKNOWN_RECONCILE':'DENIED',
        'LATE_PERMIT_OR_EFFECTIVE_ACCESS_NOT_CURRENT');
    }
    const expected=dependencies.installedBroker?.process;
    if(!expected||!dependencies.installedBroker?.publicKey||
      dependencies.installedBroker.publicKey.export({
        format:'der',type:'spki',
      }).equals(dependencies.finalGrantPublicKey.export({
        format:'der',type:'spki',
      }))){
      return result('DENIED','FINAL_NATIVE_AND_CAS_NOT_INDEPENDENT');
    }
    const info=permit?.payload as Record<string,unknown>|null;
    if(!info||typeof info.dispatchId!=='string'||
      typeof info.challengeNonce!=='string'||
      typeof info.fingerprint!=='string'||
      typeof info.capability!=='string'||typeof info.brokerId!=='string'){
      return result('DENIED','ORIGINAL_SIGNED_PERMIT_INVALID');
    }
    const nonce=randomBytes(32).toString('hex');
    // A new installed Broker challenge is required at the actual proposed
    // launch, not the earlier queue or remote CAS preflight.
    const native=await dependencies.readNativeAtLaunch(job,nonce);
    const time=(dependencies.now??Date.now)();
    if(!verifiesInstalledBrokerNonce(native,{
      requestId:job.requestId,challengeNonce:nonce,
      ownerId:job.ownerId,deviceId:job.deviceId,
      deviceEpoch:job.deviceEpoch,sessionEpoch:job.sessionEpoch,
      ownerEpoch:job.ownerEpoch,grantGeneration:job.grantGeneration,
      privilege:job.mode,now:time,
    },dependencies.installedBroker)){
      return result('DENIED','INSTALLED_BROKER_HIGH_TOKEN_LAUNCH_PROOF_UNVERIFIED');
    }
    // Final CAS must be observed AFTER fresh native proof. A grant issued
    // before the current nonce cannot pass; revocation must be compared
    // inside the actual remote-native atomic boundary by the executor.
    const raw=await dependencies.getFinalExternalGrant(
      job,nonce,info.challengeNonce,info.dispatchId,
    );
    const signed=verified(raw,dependencies.finalGrantPublicKey);
    const finished=(dependencies.now??Date.now)();
    if(!signed||!Number.isSafeInteger(finished)||
      signed.authorityId!==dependencies.dispatchAuthorityId||
      signed.requestId!==job.requestId||
      signed.dispatchId!==info.dispatchId||
      signed.brokerId!==info.brokerId||
      signed.finalNonce!==nonce||
      signed.permitNonce!==info.challengeNonce||
      signed.fingerprint!==info.fingerprint||
      signed.capability!==info.capability||
      signed.ownerId!==job.ownerId||signed.deviceId!==job.deviceId||
      signed.deviceEpoch!==job.deviceEpoch||
      signed.sessionEpoch!==job.sessionEpoch||
      signed.ownerEpoch!==job.ownerEpoch||
      signed.grantGeneration!==job.grantGeneration||
      signed.privilege!==job.mode||
      signed.installedBrokerPid!==expected.pid||
      signed.installedBrokerCreationFiletime!==expected.creationFiletime||
      signed.installedImageSha256!==expected.imageSha256||
      signed.issuedAtMs>finished+1000||finished-signed.issuedAtMs>1500||
      signed.expiresAtMs<=finished||
      typeof info.expiresAtMs!=='number'||
      info.expiresAtMs<=finished||
      signed.expiresAtMs-signed.issuedAtMs>1500||
      Date.parse(context.session?.sessionExpiresAt??'')<=finished||
      (job.mode==='ROOT'&&Date.parse(job.rootExpiresAt??'')<=finished)){
      return result('DENIED','FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
    }
    return result('FINAL_SOURCE_CANDIDATE_ONLY',
      'SIGNED_FINAL_GRANT_NOT_PHYSICAL_ATOMIC_NATIVE_EXECUTION');
  }catch{
    return result('DENIED','FINAL_PROTECTED_AUTHORITY_UNAVAILABLE');
  }
}
