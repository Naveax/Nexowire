import {verify, type KeyObject} from 'node:crypto';

/** #23 read-only independent UI QA. No dispatch, UAC, service or Broker IO. */
export interface AccessStatusLike {
  requestedMode: 'SAFE'|'FULL'|'ROOT'|'CORE';
  state: 'SAFE_USER'|'FULL_STANDARD_USER'|'PAUSED_UNVERIFIED'|'EFFECTIVE';
  effective: boolean;
  verifiedNativeHighToken: boolean;
  actualElevatedTokenVerified: boolean;
  brokerSourceAclVerified: boolean;
  authoritySource: 'independent-protected-windows-broker'|'none';
  canDispatch: false;
}
/** #700 native source assessment. Current #700 only returns false for both readiness fields. */
export interface NativeRuntimeAssessmentLike {
  actualHighIntegrityBrokerAccepted: boolean;
  productionReady: boolean;
  reason: string;
  pendingEffectUnknown?: boolean;
  /** #756 TEMP-only OS probes explicitly leave these false. */
  installedBrokerProcessAttested?: boolean;
  fullTransitiveImportInventoryVerified?: boolean;
  separateLowPrivilegeTokenBoundaryVerified?: boolean;
  protectedJobHandleInheritanceAndDaclVerified?: boolean;
  signedReleaseAndRollbackManifestVerified?: boolean;
  nativeEffectiveLowPrivilegeAccessCheckCompleted?: boolean;
}
export interface NativeUiReceiptV2 {
  schema: 'nexowire.qa.ui.native-effective-v2';
  ownerId: string; deviceId: string; credentialHash: string; sessionHash: string;
  deviceEpoch: string; sessionEpoch: string;
  challengeNonce: string;
  ownerEpoch: number; grantGeneration: number;
  brokerImageSha256: string; brokerVersion: string;
  brokerPid: number; creationFiletime: string;
  volumeSerialHex: string; fileIdHex: string;
  observedAt: string;
  highTokenWithEnabledAdministrators: boolean;
  protectedPublisherAndRelease: boolean;
  protectedExeAndAncestorAcl: boolean;
  protectedImportAndUpdaterTree: boolean;
  protectedProcessHandleBoundary: boolean;
  authenticatedNativeBroker: boolean;
  localBootstrapApproved: boolean;
}
/** Distinct, external UI-status CAS witness. #702 dispatch permits are NOT this schema. */
export interface ExternalUiEpochV2 {
  schema: 'nexowire.qa.ui.external-epoch-v2';
  ownerId: string; deviceId: string; deviceEpoch: string; sessionEpoch: string;
  challengeNonce: string;
  ownerEpoch: number; grantGeneration: number;
  revoked: boolean; revoking: boolean; observedAt: string;
}
export interface SignedReceipt<T> {statement:T; signature:string}
export interface UiEvidenceV2 {
  native: SignedReceipt<NativeUiReceiptV2>;
  external: SignedReceipt<ExternalUiEpochV2>;
}
export interface UiTrustedPinsV2 {
  nativeKey: KeyObject; externalCasKey: KeyObject;
  /** Trusted server readbacks, never browser snapshot claims. */
  ownerId:string; deviceId:string; credentialHash:string; sessionHash:string;
  currentDeviceEpoch:string; currentSessionEpoch:string;
  /** Fresh 256-bit per-readback challenge provisioned by independent server. */
  currentReadbackNonce:string;
  /** Physically provisioned out of band: booleans from UI/request are NOT proof. */
  installedNativeSignerPhysicallyAccepted:boolean;
  externalCasMonotonicAuthorityPhysicallyAccepted:boolean;
  currentOwnerEpoch:number; currentGrantGeneration:number;
  installedImageSha256:string; installedVersion:string;
  currentBrokerPid:number; currentBrokerCreationFiletime:string;
  currentVolumeSerialHex:string; currentFileIdHex:string;
  now:Date;
}
export interface EffectiveUiGateResult {
  state:'PAUSED_UNVERIFIED'|'EFFECTIVE';
  effective:false|true;
  reason:'ACCESS_NOT_EFFECTIVE'|'NATIVE_RUNTIME_NOT_PHYSICALLY_ACCEPTED'|
    'INDEPENDENT_PHYSICAL_AUTHORITIES_UNVERIFIED'|'SIGNED_NATIVE_OR_CAS_UNAVAILABLE'|'SIGNED_NATIVE_OR_CAS_INVALID'|'INDEPENDENT_PROOF_ACCEPTED';
  canDispatch:false;
  uacProvenByAppearance:false;
}
const hex64=/^[a-f0-9]{64}$/;
const hexFileId=/^[a-f0-9]{16,64}$/;
const hexVolume=/^[a-f0-9]{8,16}$/;
const filetime=/^[1-9][0-9]{9,19}$/;
const MAX_AGE_MS=5000;
const keysNative=(s:NativeUiReceiptV2)=>[
  s.schema,s.ownerId,s.deviceId,s.credentialHash,s.sessionHash,
  s.deviceEpoch,s.sessionEpoch,s.challengeNonce,s.ownerEpoch,s.grantGeneration,
  s.brokerImageSha256,s.brokerVersion,s.brokerPid,s.creationFiletime,
  s.volumeSerialHex,s.fileIdHex,s.observedAt,
  s.highTokenWithEnabledAdministrators,s.protectedPublisherAndRelease,
  s.protectedExeAndAncestorAcl,s.protectedImportAndUpdaterTree,
  s.protectedProcessHandleBoundary,s.authenticatedNativeBroker,s.localBootstrapApproved,
];
const keysCas=(s:ExternalUiEpochV2)=>[
  s.schema,s.ownerId,s.deviceId,s.deviceEpoch,s.sessionEpoch,
  s.challengeNonce,s.ownerEpoch,s.grantGeneration,s.revoked,s.revoking,s.observedAt,
];
export const nativeUiSigningBytes=(s:NativeUiReceiptV2):Buffer=>
  Buffer.from(JSON.stringify(keysNative(s)),'utf8');
export const externalUiSigningBytes=(s:ExternalUiEpochV2):Buffer=>
  Buffer.from(JSON.stringify(keysCas(s)),'utf8');
function correctSignature(key:KeyObject,bytes:Buffer,raw:string):boolean {
  if(key.type!=='public'||key.asymmetricKeyType!=='ed25519'||
     typeof raw!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(raw))return false;
  const sig=Buffer.from(raw,'base64url');
  return sig.length===64&&sig.toString('base64url')===raw&&verify(null,bytes,key,sig);
}
function fresh(s:string,now:number):boolean {
  const t=Date.parse(s);
  return Number.isFinite(t)&&t<=now+1000&&t>=now-MAX_AGE_MS;
}
function positive(n:number):boolean{return Number.isSafeInteger(n)&&n>0}
/**
 * A status projection, not a physical witness collector. Its return value is
 * never an authorization permit. The #700 current native runtime returns
 * actualHighIntegrityBrokerAccepted=false, productionReady=false, so this
 * stays PAUSED_UNVERIFIED despite synthetic #669 signed status or #702 CAS.
 */
export function projectVerifiedCoreUi(
  access:AccessStatusLike,
  runtime:NativeRuntimeAssessmentLike|null,
  evidence:UiEvidenceV2|null,
  pins:UiTrustedPinsV2,
):EffectiveUiGateResult {
  const deny=(reason:EffectiveUiGateResult['reason']):EffectiveUiGateResult=>({
    state:'PAUSED_UNVERIFIED',effective:false,reason,
    canDispatch:false,uacProvenByAppearance:false,
  });
  if(access.requestedMode!=='CORE'||access.state!=='EFFECTIVE'||
     access.effective!==true||access.verifiedNativeHighToken!==true||
     access.actualElevatedTokenVerified!==true||
     access.brokerSourceAclVerified!==true||
     access.authoritySource!=='independent-protected-windows-broker'||
     access.canDispatch!==false)return deny('ACCESS_NOT_EFFECTIVE');
  if(!runtime||runtime.actualHighIntegrityBrokerAccepted!==true||
     runtime.productionReady!==true||runtime.pendingEffectUnknown===true||
     runtime.installedBrokerProcessAttested!==true||
     runtime.fullTransitiveImportInventoryVerified!==true||
     runtime.separateLowPrivilegeTokenBoundaryVerified!==true||
     runtime.protectedJobHandleInheritanceAndDaclVerified!==true||
     runtime.signedReleaseAndRollbackManifestVerified!==true||
     runtime.nativeEffectiveLowPrivilegeAccessCheckCompleted!==true){
    return deny('NATIVE_RUNTIME_NOT_PHYSICALLY_ACCEPTED');
  }
  if(pins.installedNativeSignerPhysicallyAccepted!==true||
     pins.externalCasMonotonicAuthorityPhysicallyAccepted!==true){
    return deny('INDEPENDENT_PHYSICAL_AUTHORITIES_UNVERIFIED');
  }
  if(!evidence)return deny('SIGNED_NATIVE_OR_CAS_UNAVAILABLE');
  try {
    const b=evidence.native.statement,c=evidence.external.statement;
    const now=pins.now.getTime();
    if(!b||!c||!Number.isFinite(now)||
       b.schema!=='nexowire.qa.ui.native-effective-v2'||
       c.schema!=='nexowire.qa.ui.external-epoch-v2'||
       pins.nativeKey.export({type:'spki',format:'der'}).equals(
         pins.externalCasKey.export({type:'spki',format:'der'}))||
       !positive(pins.currentOwnerEpoch)||!positive(pins.currentGrantGeneration)||
       !positive(b.ownerEpoch)||!positive(b.grantGeneration)||
       !positive(c.ownerEpoch)||!positive(c.grantGeneration)||
       b.ownerId!==pins.ownerId||c.ownerId!==pins.ownerId||
       b.deviceId!==pins.deviceId||c.deviceId!==pins.deviceId||
       b.credentialHash!==pins.credentialHash||b.sessionHash!==pins.sessionHash||
       b.deviceEpoch!==pins.currentDeviceEpoch||c.deviceEpoch!==pins.currentDeviceEpoch||
       b.sessionEpoch!==pins.currentSessionEpoch||c.sessionEpoch!==pins.currentSessionEpoch||
       !hex64.test(pins.currentReadbackNonce)||
       b.challengeNonce!==pins.currentReadbackNonce||
       c.challengeNonce!==pins.currentReadbackNonce||
       b.ownerEpoch!==pins.currentOwnerEpoch||c.ownerEpoch!==pins.currentOwnerEpoch||
       b.grantGeneration!==pins.currentGrantGeneration||
       c.grantGeneration!==pins.currentGrantGeneration||
       c.revoked!==false||c.revoking!==false||
       !hex64.test(b.brokerImageSha256)||
       b.brokerImageSha256!==pins.installedImageSha256||
       b.brokerVersion!==pins.installedVersion||
       !Number.isSafeInteger(b.brokerPid)||b.brokerPid<=0||
       b.brokerPid!==pins.currentBrokerPid||
       !filetime.test(b.creationFiletime)||
       b.creationFiletime!==pins.currentBrokerCreationFiletime||
       !hexVolume.test(b.volumeSerialHex)||
       b.volumeSerialHex!==pins.currentVolumeSerialHex||
       !hexFileId.test(b.fileIdHex)||b.fileIdHex!==pins.currentFileIdHex||
       !fresh(b.observedAt,now)||!fresh(c.observedAt,now)||
       b.highTokenWithEnabledAdministrators!==true||
       b.protectedPublisherAndRelease!==true||
       b.protectedExeAndAncestorAcl!==true||
       b.protectedImportAndUpdaterTree!==true||
       b.protectedProcessHandleBoundary!==true||
       b.authenticatedNativeBroker!==true||b.localBootstrapApproved!==true||
       !correctSignature(pins.nativeKey,nativeUiSigningBytes(b),evidence.native.signature)||
       !correctSignature(pins.externalCasKey,externalUiSigningBytes(c),evidence.external.signature)){
      return deny('SIGNED_NATIVE_OR_CAS_INVALID');
    }
    return {state:'EFFECTIVE',effective:true,reason:'INDEPENDENT_PROOF_ACCEPTED',
      canDispatch:false,uacProvenByAppearance:false};
  }catch{return deny('SIGNED_NATIVE_OR_CAS_INVALID')}
}
