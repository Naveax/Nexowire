import {verify,randomBytes,type KeyObject} from 'node:crypto';
import {verifiesInstalledBrokerNonce,
  type PinnedInstalledBrokerIdentity,type SignedInstalledBrokerNonceRecord}
  from './access-native-broker-proof.js';
import * as z from 'zod';
import {AccessEffectiveAuthority,type EffectiveOwnerSession,
  type EffectiveMode} from './access-effective-authority.js';
import type {ProductDeviceRecord} from './control-plane-store.js';

/**
 * #04 Access owner read-only queue gate. Not a Broker, CAS reservation,
 * OS token attestation or privileged executor.
 *
 * A previous dashboard EFFECTIVE result is never authority to start or
 * continue an elevated effect. External #702 must atomically reserve
 * against revoke/re-pair at the actual native dispatch boundary.
 */
const uid=z.string().uuid();
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const signedRecord=z.strictObject({
  kind:z.literal('nexowire.access.cas-readback.v1'),
  authorityId:uid,requestId:uid,challengeNonce:sha,deviceId:uid,ownerId:uid,
  deviceEpoch:uid,sessionEpoch:uid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  privilege:z.enum(['CORE','ROOT']),
  revoked:z.boolean(),revoking:z.boolean(),
  observedAtMs:z.number().int().nonnegative().safe(),
  expiresAtMs:z.number().int().positive().safe(),
});
export type CasReadbackRecord=z.infer<typeof signedRecord>;
export const casReadbackSigningBytes=(record:CasReadbackRecord):Buffer=>{
  const r=signedRecord.parse(record);
  return Buffer.from(JSON.stringify([
    r.kind,r.authorityId,r.requestId,r.challengeNonce,r.deviceId,r.ownerId,
    r.deviceEpoch,r.sessionEpoch,r.ownerEpoch,r.grantGeneration,
    r.privilege,r.revoked,r.revoking,r.observedAtMs,r.expiresAtMs,
  ]),'utf8');
};
export interface QueuedAccessRequest {
  mode:EffectiveMode;
  requestId:string;
  ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;
  credentialHash:string;sessionHash:string;
  /** ROOT bound to owner session and <=15-minute lease, NOT CORE TTL. */
  rootIssuedAt:string|null;rootExpiresAt:string|null;
  /** A response may be lost after a side effect. Never replay. */
  effectState:'queued'|'may-have-dispatched'|'completed';
  /** Diagnostic only; never authentication. */
  cachedUiEffective?:boolean;
}
export interface AuthenticatedReadback {
  statement:CasReadbackRecord;
  signature:string;
}
export interface QueuedAccessDependencies {
  effectiveAuthority:AccessEffectiveAuthority;
  /** Trusted from protected server config, NOT inbound JSON or Agent UI. */
  independentCasPublicKey:KeyObject;
  /** Pinned installed Broker PID/FILETIME/file identity and protected key. */
  installedBroker:PinnedInstalledBrokerIdentity;
  authorityId:string;
  /** Must inspect a protected installed Broker, NOT calling PowerShell. */
  readInstalledBroker:(request:QueuedAccessRequest,
    nonce:string)=>Promise<SignedInstalledBrokerNonceRecord>;
  /** Authenticated protected readback client, absent in production currently. */
  readCas:(request:QueuedAccessRequest,nonce:string)=>Promise<AuthenticatedReadback>;
  /** Independent monotonic compare, not just another cached readback. */
  readHighWater:(deviceId:string)=>Promise<{
    ownerId:string;deviceEpoch:string;sessionEpoch:string;
    ownerEpoch:number;grantGeneration:number;
    /** Revocation begins BEFORE the drain completes; not just final revoked. */
    revoking:boolean;revoked:boolean;
  }>;
  now?:()=>number;
}
export interface QueuedAccessReview {
  status:'DENIED'|'UNKNOWN_RECONCILE'|'REVIEWED_ONLY_NO_DISPATCH';
  reason:string;
  cachedUiTrusted:false;
  noAdditionalPerCommandUacAfterBootstrap:true;
  elevatedDispatchAllowed:false;
  canRetry:false;
}
function outcome(status:QueuedAccessReview['status'],reason:string):QueuedAccessReview{
  return Object.freeze({
    status,reason,cachedUiTrusted:false,
    noAdditionalPerCommandUacAfterBootstrap:true,
    elevatedDispatchAllowed:false,canRetry:false,
  });
}
function positive(x:number):boolean{
  return Number.isSafeInteger(x)&&x>0;
}
function validSignature(
  key:KeyObject,record:CasReadbackRecord,signature:unknown,
):boolean{
  if(key?.type!=='public'||key.asymmetricKeyType!=='ed25519'||
    typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature)){
    return false;
  }
  const data=Buffer.from(signature,'base64url');
  return data.length===64&&data.toString('base64url')===signature&&
    verify(null,casReadbackSigningBytes(record),key,data);
}
export async function reviewQueuedAccess(
  request:QueuedAccessRequest,
  context:{
    device:ProductDeviceRecord;
    session:EffectiveOwnerSession|null;
    corePreferenceEnabled:boolean;
    bridgeDesiredMode:'auto'|'on'|'off';
  },
  dependencies:QueuedAccessDependencies,
):Promise<QueuedAccessReview>{
  // No readback can make an already-dispatched effect repeatable.
  if(request?.effectState==='may-have-dispatched'){
    return outcome('UNKNOWN_RECONCILE','POSSIBLE_EFFECT_NO_REPLAY');
  }
  if(request?.effectState!=='queued')return outcome('DENIED','NOT_QUEUED');
  try{
    const now=(dependencies.now??Date.now)();
    const s=context.session;
    if(!Number.isFinite(now)||!uid.safeParse(request.requestId).success||
      !uid.safeParse(request.ownerId).success||
      !uid.safeParse(request.deviceId).success||
      !uid.safeParse(request.deviceEpoch).success||
      !uid.safeParse(request.sessionEpoch).success||
      !sha.safeParse(request.credentialHash).success||
      !sha.safeParse(request.sessionHash).success||
      !uid.safeParse(dependencies.authorityId).success||
      !positive(request.ownerEpoch)||!positive(request.grantGeneration)||
      !s||s.loginIsRevoked||
      request.ownerId!==context.device.ownerAccountId||
      request.ownerId!==s.ownerAccountId||
      request.deviceId!==context.device.id||
      request.credentialHash!==context.device.credentialHash||
      request.sessionHash!==s.sessionHash||
      !sha.safeParse(s.sessionHash).success||
      Date.parse(s.sessionExpiresAt)<=now){
      return outcome('DENIED','OWNER_DEVICE_LOGIN_SCOPE_STALE');
    }
    if(request.mode==='ROOT'){
      const issued=Date.parse(request.rootIssuedAt??'');
      const expiry=Date.parse(request.rootExpiresAt??'');
      if(!Number.isFinite(issued)||!Number.isFinite(expiry)||
        issued>now||expiry<=now||expiry<=issued||
        expiry-issued>900_000){
        return outcome('DENIED','ROOT_15M_EXPIRED_OR_UNBOUND');
      }
    }else if(request.mode==='CORE'){
      if(request.rootIssuedAt!==null||request.rootExpiresAt!==null||
        !context.corePreferenceEnabled){
        return outcome('DENIED','CORE_ENROLLMENT_PREFERENCE_REVOKED');
      }
    }else return outcome('DENIED','MODE_INVALID');
    // Full fresh server-side owner/D1 + protected native + independent CAS
    // status recheck. UI cachedEffective does not participate.
    const status=await dependencies.effectiveAuthority.project({
      device:context.device,mode:request.mode,session:s,
      corePreferenceEnabled:context.corePreferenceEnabled,
      bridgeDesiredMode:context.bridgeDesiredMode,
    });
    if(status.state!=='EFFECTIVE'||status.effective!==true||
      status.authoritySource!=='independent-protected-windows-broker'||
      status.actualElevatedTokenVerified!==true||
      status.brokerSourceAclVerified!==true||
      status.brokerVersionVerified!==true){
      return outcome('DENIED','FRESH_BROKER_OR_OWNER_PROOF_MISSING');
    }
    // #712-style fresh 256-bit challenge binds both native report and
    // independent CAS readback. Old signed UI/CAS from WAL rollback cannot
    // satisfy a new review. Neither proof authorizes privileged dispatch.
    const nonce=randomBytes(32).toString('hex');
    const native=await dependencies.readInstalledBroker(request,nonce);
    if(!verifiesInstalledBrokerNonce(native,{
      requestId:request.requestId,challengeNonce:nonce,
      ownerId:request.ownerId,deviceId:request.deviceId,
      deviceEpoch:request.deviceEpoch,sessionEpoch:request.sessionEpoch,
      ownerEpoch:request.ownerEpoch,grantGeneration:request.grantGeneration,
      privilege:request.mode,now,
    },dependencies.installedBroker)){
      return outcome('DENIED','INSTALLED_BROKER_NONCE_TOKEN_UNVERIFIED');
    }
    // The external and native signing keys must not share an authority.
    if(dependencies.installedBroker.publicKey.export({format:'der',type:'spki'}).equals(
      dependencies.independentCasPublicKey.export({format:'der',type:'spki'}))){
      return outcome('DENIED','BROKER_CAS_SIGNING_KEYS_NOT_INDEPENDENT');
    }
    const {statement,signature}=await dependencies.readCas(request,nonce);
    const parsed=signedRecord.safeParse(statement);
    if(!parsed.success||!validSignature(
      dependencies.independentCasPublicKey,parsed.data,signature)){
      return outcome('DENIED','EXTERNAL_READBACK_SIGNATURE_INVALID');
    }
    const r=parsed.data;
    if(r.authorityId!==dependencies.authorityId||
      r.requestId!==request.requestId||r.challengeNonce!==nonce||
      r.deviceId!==request.deviceId||
      r.ownerId!==request.ownerId||
      r.deviceEpoch!==request.deviceEpoch||
      r.sessionEpoch!==request.sessionEpoch||
      r.ownerEpoch!==request.ownerEpoch||
      r.grantGeneration!==request.grantGeneration||
      r.privilege!==request.mode||r.revoked||r.revoking||
      r.observedAtMs>now+1_000||now-r.observedAtMs>5_000||
      r.expiresAtMs<=now||r.expiresAtMs-r.observedAtMs>5_000){
      return outcome('DENIED','EXTERNAL_READBACK_STALE_OR_REVOKED');
    }
    const current=await dependencies.readHighWater(request.deviceId);
    if(current?.ownerId!==request.ownerId||
      current?.deviceEpoch!==request.deviceEpoch||
      current?.sessionEpoch!==request.sessionEpoch||
      current?.ownerEpoch!==request.ownerEpoch||
      current.grantGeneration!==request.grantGeneration||
      current.revoking!==false||current.revoked!==false){
      return outcome('DENIED','INDEPENDENT_CAS_HIGHWATER_ADVANCED');
    }
    // The owner/ROOT session can expire while waiting for remote CAS.
    // Re-evaluate against the actual final wall-clock boundary.
    const finalNow=(dependencies.now??Date.now)();
    if(!Number.isFinite(finalNow)||
      Date.parse(s.sessionExpiresAt)<=finalNow||
      r.expiresAtMs<=finalNow||
      (request.mode==='ROOT'&&
        Date.parse(request.rootExpiresAt??'')<=finalNow)){
      return outcome('DENIED','ROOT_OR_READBACK_EXPIRED_DURING_REVIEW');
    }
    // TOCTOU remains between this read and the future native side effect.
    // Owner #702 beginIfCurrent must atomically fence the actual dispatch.
    return outcome('REVIEWED_ONLY_NO_DISPATCH','ATOMIC_DISPATCH_PERMIT_NOT_PROVEN');
  }catch{
    return outcome('DENIED','INDEPENDENT_ATTESTATION_UNAVAILABLE');
  }
}
