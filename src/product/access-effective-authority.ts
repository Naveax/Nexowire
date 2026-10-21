import {verify,type KeyObject} from 'node:crypto';
import type {ControlPlaneStore,ProductDeviceRecord} from './control-plane-store.js';
import type {ControlPlaneIdentity} from './control-plane-service.js';
import type {D1CoreDelegationLedger} from '../security/core-admin-delegation.js';

export type EffectiveMode='ROOT'|'CORE';
export interface NativeAccessAttestation {
  schema:'nexowire.access.native-effective.v1';
  mode:EffectiveMode;deviceId:string;ownerAccountId:string;
  credentialHash:string;sessionHash:string;
  ownerEpoch:number;grantGeneration:number;
  rootIssuedAt:string|null;rootExpiresAt:string|null;
  enrollmentId:string|null;
  brokerImageSha256:string;brokerVersion:string;
  observedAt:string;nativeHighIntegrity:boolean;administratorsEnabled:boolean;
  authenticatedBroker:boolean;localUacBootstrapVerified:boolean;
  publisherAndReleasePinned:boolean;parentImportUpdaterAclProtected:boolean;
  processHandleBoundaryProtected:boolean;ownerApprovedDelegation:boolean;
}
export interface ExternalRevocationAttestation {
  schema:'nexowire.access.external-epoch.v1';
  deviceId:string;ownerAccountId:string;ownerEpoch:number;
  grantGeneration:number;revoked:boolean;observedAt:string;
}
export interface SignedAccessAttestation<T>{
  statement:T;signature:string;
}
export interface IndependentEffectiveEvidence {
  broker:SignedAccessAttestation<NativeAccessAttestation>;
  epoch:SignedAccessAttestation<ExternalRevocationAttestation>;
}
export interface TrustedEffectiveAnchor {
  /** Provisioned by separately approved native installation, never request JSON. */
  nativeProtectedCollectorPublicKey:KeyObject;
  /** Pinned independent monotonic revocation authority, not Agent telemetry. */
  externalCasPublicKey:KeyObject;
  expectedImageSha256:string;expectedBrokerVersion:string;
  /** Must come from a trusted external high-watermark read, not signed snapshot. */
  independentlyReadOwnerEpoch:number;
  independentlyReadGrantGeneration:number;
  physicallyAcceptedNativeCollector:boolean;
  physicallyAcceptedExternalCas:boolean;
}
export interface EffectiveEvidenceReader {
  /** Read-only, independent native+CAS providers; no UI-supplied trust anchors. */
  fetch(deviceId:string,mode:EffectiveMode):Promise<{
    evidence:IndependentEffectiveEvidence|null;
    trust:TrustedEffectiveAnchor|null;
  }>;
}
export interface EffectiveOwnerSession {
  ownerAccountId:string;sessionHash:string;sessionExpiresAt:string;
  loginIsRevoked:boolean;
}
export interface EffectiveAccessStatus {
  requestedMode:'SAFE'|'FULL'|'ROOT'|'CORE';
  state:'SAFE_USER'|'FULL_STANDARD_USER'|'PAUSED_UNVERIFIED'|'EFFECTIVE';
  effective:boolean;
  verifiedNativeHighToken:boolean;
  authoritySource:'independent-protected-windows-broker'|'none';
  localEnrollmentVerified:boolean;
  actualElevatedTokenVerified:boolean;
  brokerSourceAclVerified:boolean;
  brokerVersionVerified:boolean;
  requiresPerCommandUac:false;
  canDispatch:false;
  reason:string;
}
const fmt=/^[a-f0-9]{64}$/;
const freshness=15000;
function signedBytes(v:NativeAccessAttestation):Buffer{
  return Buffer.from(JSON.stringify([
    v.schema,v.mode,v.deviceId,v.ownerAccountId,v.credentialHash,
    v.sessionHash,v.ownerEpoch,v.grantGeneration,v.rootIssuedAt,v.rootExpiresAt,
    v.enrollmentId,v.brokerImageSha256,v.brokerVersion,v.observedAt,
    v.nativeHighIntegrity,v.administratorsEnabled,v.authenticatedBroker,
    v.localUacBootstrapVerified,v.publisherAndReleasePinned,
    v.parentImportUpdaterAclProtected,v.processHandleBoundaryProtected,
    v.ownerApprovedDelegation,
  ]));
}
function externalBytes(v:ExternalRevocationAttestation):Buffer{
  return Buffer.from(JSON.stringify([
    v.schema,v.deviceId,v.ownerAccountId,v.ownerEpoch,v.grantGeneration,
    v.revoked,v.observedAt,
  ]));
}
export const nativeEffectiveSigningBytes=signedBytes;
export const externalEffectiveSigningBytes=externalBytes;
function signedValid(key:KeyObject,bytes:Buffer,raw:unknown):boolean{
  try {
    if(key.type!=='public'||key.asymmetricKeyType!=='ed25519'||
      typeof raw!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(raw))return false;
    const sig=Buffer.from(raw,'base64url');
    return sig.length===64 && sig.toString('base64url')===raw &&
      verify(null,bytes,key,sig);
  }catch{return false}
}
function recent(t:string,now:number):boolean{
  const ts=Date.parse(t);
  return Number.isFinite(ts)&&ts>=now-freshness&&ts<=now+2000;
}
function positive(n:number):boolean{return Number.isSafeInteger(n)&&n>0}
const deny=(mode:EffectiveAccessStatus['requestedMode'],reason:string):EffectiveAccessStatus=>
  Object.freeze({requestedMode:mode,
    state:mode==='SAFE'?'SAFE_USER':mode==='FULL'?'FULL_STANDARD_USER':'PAUSED_UNVERIFIED',
    effective:false,verifiedNativeHighToken:false,
    authoritySource:'none',localEnrollmentVerified:false,
    actualElevatedTokenVerified:false,brokerSourceAclVerified:false,
    brokerVersionVerified:false,requiresPerCommandUac:false,canDispatch:false,reason});
/**
 * Trustworthy EFFECTIVE is conditional on *independently provisioned native*
 * and *independently read monotonic epoch* proof, current owner session and
 * durable D1 grant. This module is an Access STATUS projector, NOT executor.
 * No independently provisioned providers are connected in production.
 */
export class AccessEffectiveAuthority {
  constructor(
    private readonly store:ControlPlaneStore,
    private readonly coreLedger:D1CoreDelegationLedger,
    private readonly evidenceReader:EffectiveEvidenceReader,
    private readonly clock:()=>Date=()=>new Date(),
  ){}
  async project(input:{
    device:ProductDeviceRecord;
    mode:'SAFE'|'FULL'|'ROOT'|'CORE';
    session:EffectiveOwnerSession|null;
    corePreferenceEnabled:boolean;
    bridgeDesiredMode:'auto'|'on'|'off';
  }):Promise<EffectiveAccessStatus>{
    const {device,mode,session}=input;
    if(mode==='SAFE')return deny(mode,'SAFE_STANDARD');
    if(mode==='FULL')return deny(mode,'FULL_STANDARD_USER');
    try{
      const now=this.clock().getTime();
      const loginExpiry=Date.parse(session?.sessionExpiresAt??'');
      if(!Number.isFinite(now)||!session||
        session.ownerAccountId!==device.ownerAccountId||
        session.loginIsRevoked||!fmt.test(session.sessionHash)||
        !Number.isFinite(loginExpiry)||loginExpiry<=now){
        return deny(mode,'OWNER_LOGIN_REVOKED_OR_MISSING');
      }
      if(device.platform!=='win32'||device.accessMode!=='full'||
        !device.online||device.privilegeMode!=='broker'||
        input.bridgeDesiredMode==='off'){
        return deny(mode,'DEVICE_OR_BRIDGE_NOT_READY');
      }
      const {evidence,trust}=await this.evidenceReader.fetch(device.id,mode);
      if(!evidence||!trust||!trust.physicallyAcceptedNativeCollector||
        !trust.physicallyAcceptedExternalCas)return deny(mode,'INDEPENDENT_PROOF_MISSING');
      const [core,root]=await Promise.all([
        mode==='CORE'&&input.corePreferenceEnabled
          ?this.coreLedger.currentCandidate({
            deviceId:device.id,ownerAccountId:device.ownerAccountId,
            credentialHash:device.credentialHash,
            brokerImageSha256:trust.expectedImageSha256,
            brokerVersion:trust.expectedBrokerVersion,
          }):Promise.resolve(null),
        mode==='ROOT'?this.store.getRootSessionGrant({
          deviceId:device.id,ownerAccountId:device.ownerAccountId,
          sessionHash:session.sessionHash,at:new Date(now).toISOString(),
        }):Promise.resolve(null),
      ]);
      if(mode==='CORE' && (!input.corePreferenceEnabled||!core)){
        return deny(mode,'CORE_ENROLLMENT_REVOKED_OR_ABSENT');
      }
      if(mode==='ROOT' && (!root ||
        !Number.isFinite(Date.parse(root.issuedAt))||
        !Number.isFinite(Date.parse(root.expiresAt))||
        Date.parse(root.issuedAt)>now+2000||
        Date.parse(root.expiresAt)<=now||
        Date.parse(root.expiresAt)<=Date.parse(root.issuedAt)||
        Date.parse(root.expiresAt)-Date.parse(root.issuedAt)>900000)){
        return deny(mode,'ROOT_LEASE_REVOKED_OR_EXPIRED');
      }
      const b=evidence.broker.statement,e=evidence.epoch.statement;
      if(!b||!e||b.schema!=='nexowire.access.native-effective.v1'||
        e.schema!=='nexowire.access.external-epoch.v1'||
        b.mode!==mode||b.deviceId!==device.id||e.deviceId!==device.id||
        b.ownerAccountId!==device.ownerAccountId||
        e.ownerAccountId!==device.ownerAccountId||
        b.credentialHash!==device.credentialHash||
        b.sessionHash!==session.sessionHash||
        !positive(b.ownerEpoch)||!positive(b.grantGeneration)||
        b.ownerEpoch!==e.ownerEpoch||b.grantGeneration!==e.grantGeneration||
        b.ownerEpoch!==trust.independentlyReadOwnerEpoch||
        b.grantGeneration!==trust.independentlyReadGrantGeneration||
        !recent(b.observedAt,now)||!recent(e.observedAt,now)||
        !fmt.test(b.brokerImageSha256)||
        b.brokerImageSha256!==trust.expectedImageSha256||
        b.brokerVersion!==trust.expectedBrokerVersion||
        !signedValid(trust.nativeProtectedCollectorPublicKey,signedBytes(b),evidence.broker.signature)||
        !signedValid(trust.externalCasPublicKey,externalBytes(e),evidence.epoch.signature)||
        trust.nativeProtectedCollectorPublicKey.export({format:'der',type:'spki'}).equals(
          trust.externalCasPublicKey.export({format:'der',type:'spki'})) ||
        e.revoked!==false ||
        !b.nativeHighIntegrity||!b.administratorsEnabled||!b.authenticatedBroker||
        !b.localUacBootstrapVerified||!b.publisherAndReleasePinned||
        !b.parentImportUpdaterAclProtected||!b.processHandleBoundaryProtected||
        !b.ownerApprovedDelegation){
        return deny(mode,'SIGNED_BROKER_OR_EPOCH_INVALID');
      }
      if(mode==='CORE' && (b.enrollmentId!==core!.enrollmentId||
        b.grantGeneration!==core!.generation||
        b.brokerImageSha256!==core!.brokerImageSha256||
        b.brokerVersion!==core!.brokerVersion||
        b.rootIssuedAt!==null||b.rootExpiresAt!==null)){
        return deny(mode,'CORE_REVOKED_OR_GENERATION_CHANGED');
      }
      if(mode==='ROOT' && (b.enrollmentId!==null||
        b.rootIssuedAt!==root!.issuedAt||b.rootExpiresAt!==root!.expiresAt||
        Date.parse(root!.expiresAt)<=now)){
        return deny(mode,'ROOT_SESSION_OR_DURATION_MISMATCH');
      }
      return Object.freeze({
        requestedMode:mode,state:'EFFECTIVE' as const,effective:true,
        verifiedNativeHighToken:true,
        authoritySource:'independent-protected-windows-broker' as const,
        localEnrollmentVerified:true,actualElevatedTokenVerified:true,
        brokerSourceAclVerified:true,brokerVersionVerified:true,
        requiresPerCommandUac:false as const,canDispatch:false as const,
        reason:'SIGNED_NATIVE_AND_EXTERNAL_CAS_VERIFIED',
      });
    }catch{
      // Missing D1 migration, ACL evidence, native signer or CAS network must
      // never turn into a UI ACTIVE state.
      return deny(mode,'EFFECTIVE_EVIDENCE_UNAVAILABLE');
    }
  }
}
