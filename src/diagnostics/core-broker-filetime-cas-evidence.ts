/**
 * #10 source-only Broker identity/epoch comparator.
 * Inputs are untrusted provider observations, never Windows attestation or
 * permission to dispatch. No native APIs, network, UAC, VM, or filesystem IO.
 */
export type ReadState = 'reported' | 'unavailable' | 'unknown';
export interface ReadEvidence<T> {
  readonly state: ReadState;
  readonly observedAtMs?: number;
  readonly value?: T;
}
export interface ProcessIdentity {
  readonly pid: number;
  /** Native Win32 creation FILETIME in decimal string: DO NOT parse via Number. */
  readonly creationFiletime: string;
  readonly volumeSerialHex: string;
  readonly fileIdHex: string;
  readonly imageSha256: string;
}
export interface RunningImage {
  readonly identity: ProcessIdentity;
  readonly running: boolean;
  readonly authenticodeVerified: boolean;
  readonly pinnedPublisherThumbprint: string;
  readonly identityBoundToOpenHandle: boolean;
}
export interface HighToken {
  readonly pid: number;
  readonly creationFiletime: string;
  readonly integrity: 'low' | 'medium' | 'high' | 'system' | 'unknown';
  readonly administratorsEnabled: boolean;
  readonly sameProcessTokenVerified: boolean;
}
export interface ImageTree {
  readonly ancestorAclProtected: boolean;
  readonly importsIndependentlyEnumerated: boolean;
  readonly signedImportManifestVerified: boolean;
  readonly importsAclProtected: boolean;
  readonly updaterAndImportsAclProtected: boolean;
  readonly noLowTrustWriteOrReplace: boolean;
  readonly lowPrivilegeDupHandleDenied: boolean;
}
export interface OwnerEpoch {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly ownerEpoch: number;
  readonly generation: number;
  readonly active: boolean;
  readonly signed: boolean;
  readonly revocationChecked: boolean;
}
export interface ExternalEpoch {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly ownerEpoch: number;
  readonly generation: number;
  readonly signedReceipt: boolean;
  readonly independentlyNonCoRestorable: boolean;
  readonly linearizableWithRevoke: boolean;
  readonly revoked: boolean;
}
export interface StatusOnly {
  readonly requestId: string;
  readonly responseRequestId: string | null;
  readonly httpStatus: number | null;
  readonly fromCache: boolean;
  readonly consentExeVisible: boolean;
  readonly requestedCorePreference: boolean;
}
export interface ReadonlyEvidenceProviders {
  readonly signedImage?: () => Promise<ReadEvidence<RunningImage>>;
  readonly highToken?: () => Promise<ReadEvidence<HighToken>>;
  readonly protectedTree?: () => Promise<ReadEvidence<ImageTree>>;
  readonly ownerGrant?: () => Promise<ReadEvidence<OwnerEpoch>>;
  readonly externalCas?: () => Promise<ReadEvidence<ExternalEpoch>>;
  readonly status?: () => Promise<ReadEvidence<StatusOnly>>;
}
export interface BrokerExpectation {
  readonly identity: ProcessIdentity;
  readonly publisherThumbprint: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly minGeneration: number;
  readonly statusRequestId: string;
  readonly nowMs: number;
  readonly maxAgeMs: number;
}
export type Reason =
  | 'NATIVE_PROVIDER_UNAVAILABLE' | 'PROVIDER_UNKNOWN' | 'PROBE_MALFORMED'
  | 'PROBE_STALE' | 'SIGNED_IMAGE_UNAVAILABLE' | 'UNSIGNED_OR_UNBOUND_IMAGE'
  | 'PID_CREATION_FILETIME_MISMATCH' | 'RUNNING_FILE_ID_OR_HASH_MISMATCH'
  | 'PUBLISHER_PIN_MISMATCH' | 'HIGH_TOKEN_UNVERIFIED'
  | 'TOKEN_PROCESS_FILETIME_MISMATCH' | 'FULL_IMPORT_UPDATER_ACL_UNVERIFIED'
  | 'CORE_OWNER_GRANT_STALE_OR_REVOKED' | 'EXTERNAL_CAS_UNAVAILABLE'
  | 'EXTERNAL_WITNESS_UNVERIFIED' | 'CACHED_CORE_EPOCH_MISMATCH'
  | 'UNAUTHENTICATED_401_NOT_ELEVATION' | 'REPLAYED_STATUS_CACHE'
  | 'STATUS_REQUEST_UNCORRELATED' | 'CONSENT_EXE_NOT_APPROVAL'
  | 'CORE_PREFERENCE_NOT_EFFECTIVE' | 'CLAIMED_GREEN_NOT_ATTESTATION';
export interface ReadonlyDiagnostic {
  readonly schemaVersion: 1;
  readonly provenance: 'untrusted_source_fixture';
  readonly status: 'BLOCKED' | 'UNVERIFIED';
  readonly requestedMode: 'CORE';
  readonly effectiveElevation: 'NOT_PROVEN';
  readonly effectiveCore: false;
  readonly authorized: false;
  readonly dispatchAllowed: false;
  readonly replaySafe: false;
  readonly reasons: readonly Reason[];
}
const isRecord=(x:unknown):x is Record<string,unknown> =>
  typeof x==='object' && x!==null && !Array.isArray(x);
const isEpoch=(x:unknown):x is number =>
  typeof x==='number' && Number.isSafeInteger(x) && x>0;
const isHex=(x:unknown,n:number):x is string =>
  typeof x==='string' && new RegExp('^[a-f0-9]{'+n+'}$','i').test(x);
function validFiletime(x:unknown):x is string {
  if(typeof x!=='string'||!/^[1-9][0-9]{9,19}$/.test(x))return false;
  try{return BigInt(x)<=18446744073709551615n;}catch{return false;}
}
function validIdentity(x:unknown):x is ProcessIdentity {
  if(!isRecord(x))return false;
  return isEpoch(x.pid) && (x.pid as number)<=4294967295 &&
    validFiletime(x.creationFiletime) &&
    typeof x.volumeSerialHex==='string' && /^[a-f0-9]{8,16}$/i.test(x.volumeSerialHex) &&
    typeof x.fileIdHex==='string' && /^[a-f0-9]{16,64}$/i.test(x.fileIdHex) &&
    isHex(x.imageSha256,64);
}
async function read<T>(provider:(()=>Promise<ReadEvidence<T>>)|undefined):Promise<ReadEvidence<T>>{
  if(!provider)return {state:'unavailable'};
  try{
    const raw:unknown=await provider();
    if(!isRecord(raw)||!['reported','unknown','unavailable'].includes(String(raw.state)))
      return {state:'unavailable'};
    return raw as unknown as ReadEvidence<T>;
  }catch{
    // Provider exceptions can contain private paths/tokens; never return them.
    return {state:'unavailable'};
  }
}
export async function assessReadonlyBrokerEpoch(
  provider:ReadonlyEvidenceProviders,expected:BrokerExpectation,
):Promise<ReadonlyDiagnostic>{
  if(!validIdentity(expected.identity) ||
     !(isHex(expected.publisherThumbprint,40)||isHex(expected.publisherThumbprint,64)) ||
     !expected.ownerId || !expected.deviceId || !expected.statusRequestId ||
     !isEpoch(expected.minGeneration) || !Number.isSafeInteger(expected.nowMs) ||
     !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs<1 || expected.maxAgeMs>300000)
    throw new TypeError('INVALID_BROKER_DIAGNOSTIC_EXPECTATION');
  const [image,token,tree,owner,cas,status]=await Promise.all([
    read(provider.signedImage),read(provider.highToken),read(provider.protectedTree),
    read(provider.ownerGrant),read(provider.externalCas),read(provider.status),
  ]);
  const codes=new Set<Reason>();
  const usable=<T>(v:ReadEvidence<T>,ifMissing:Reason):v is ReadEvidence<T>&{value:T}=>{
    if(v.state==='unavailable'){codes.add('NATIVE_PROVIDER_UNAVAILABLE');codes.add(ifMissing);return false;}
    if(v.state==='unknown'){codes.add('PROVIDER_UNKNOWN');codes.add(ifMissing);return false;}
    if(!isRecord(v.value)){codes.add('PROBE_MALFORMED');codes.add(ifMissing);return false;}
    if(typeof v.observedAtMs!=='number'||!Number.isSafeInteger(v.observedAtMs)||
       v.observedAtMs>expected.nowMs+2000 ||
       expected.nowMs-v.observedAtMs>expected.maxAgeMs){
      codes.add('PROBE_STALE');return false;
    }
    return true;
  };
  if(usable(image,'SIGNED_IMAGE_UNAVAILABLE')){
    const v=image.value;
    if(!validIdentity(v.identity)||v.running!==true||v.authenticodeVerified!==true||
       v.identityBoundToOpenHandle!==true)codes.add('UNSIGNED_OR_UNBOUND_IMAGE');
    if(validIdentity(v.identity)){
      if(v.identity.pid!==expected.identity.pid||
         v.identity.creationFiletime!==expected.identity.creationFiletime)
        codes.add('PID_CREATION_FILETIME_MISMATCH');
      if(v.identity.volumeSerialHex.toLowerCase()!==expected.identity.volumeSerialHex.toLowerCase()||
         v.identity.fileIdHex.toLowerCase()!==expected.identity.fileIdHex.toLowerCase()||
         v.identity.imageSha256.toLowerCase()!==expected.identity.imageSha256.toLowerCase())
        codes.add('RUNNING_FILE_ID_OR_HASH_MISMATCH');
    }
    if(v.pinnedPublisherThumbprint?.toLowerCase()!==expected.publisherThumbprint.toLowerCase())
      codes.add('PUBLISHER_PIN_MISMATCH');
  }
  if(usable(token,'HIGH_TOKEN_UNVERIFIED')){
    const v=token.value;
    if(!(v.integrity==='high'||v.integrity==='system')||
       v.administratorsEnabled!==true||v.sameProcessTokenVerified!==true)
      codes.add('HIGH_TOKEN_UNVERIFIED');
    if(v.pid!==expected.identity.pid||!validFiletime(v.creationFiletime)||
       v.creationFiletime!==expected.identity.creationFiletime)
      codes.add('TOKEN_PROCESS_FILETIME_MISMATCH');
  }
  if(usable(tree,'FULL_IMPORT_UPDATER_ACL_UNVERIFIED')){
    const v=tree.value;
    if(!(v.ancestorAclProtected===true&&v.importsIndependentlyEnumerated===true&&
         v.signedImportManifestVerified===true&&v.importsAclProtected===true&&
         v.updaterAndImportsAclProtected===true&&v.noLowTrustWriteOrReplace===true&&
         v.lowPrivilegeDupHandleDenied===true))
      codes.add('FULL_IMPORT_UPDATER_ACL_UNVERIFIED');
  }
  if(usable(owner,'CORE_OWNER_GRANT_STALE_OR_REVOKED')){
    const v=owner.value;
    if(v.ownerId!==expected.ownerId||v.deviceId!==expected.deviceId||
       !isEpoch(v.ownerEpoch)||!isEpoch(v.generation)||
       v.generation<expected.minGeneration||v.active!==true||
       v.signed!==true||v.revocationChecked!==true)
      codes.add('CORE_OWNER_GRANT_STALE_OR_REVOKED');
  }
  if(usable(cas,'EXTERNAL_CAS_UNAVAILABLE')){
    const v=cas.value;
    if(v.ownerId!==expected.ownerId||v.deviceId!==expected.deviceId||
       !isEpoch(v.ownerEpoch)||!isEpoch(v.generation)||v.signedReceipt!==true||
       v.independentlyNonCoRestorable!==true||v.linearizableWithRevoke!==true||
       v.revoked!==false)codes.add('EXTERNAL_WITNESS_UNVERIFIED');
    const grant=owner.state==='reported'?owner.value:undefined;
    if(!grant||!isEpoch(grant.ownerEpoch)||!isEpoch(grant.generation)||
       v.ownerEpoch!==grant.ownerEpoch||v.generation!==grant.generation||
       !isEpoch(v.generation)||v.generation<expected.minGeneration)
      codes.add('CACHED_CORE_EPOCH_MISMATCH');
  }
  if(usable(status,'NATIVE_PROVIDER_UNAVAILABLE')){
    const v=status.value;
    if(v.httpStatus===401)codes.add('UNAUTHENTICATED_401_NOT_ELEVATION');
    if(v.fromCache===true)codes.add('REPLAYED_STATUS_CACHE');
    if(v.requestId!==expected.statusRequestId||
       v.responseRequestId!==expected.statusRequestId)
      codes.add('STATUS_REQUEST_UNCORRELATED');
    if(v.consentExeVisible===true)codes.add('CONSENT_EXE_NOT_APPROVAL');
    if(v.requestedCorePreference===true)codes.add('CORE_PREFERENCE_NOT_EFFECTIVE');
  }
  codes.add('CLAIMED_GREEN_NOT_ATTESTATION');
  return{
    schemaVersion:1,provenance:'untrusted_source_fixture',
    status:codes.size===1?'UNVERIFIED':'BLOCKED',
    requestedMode:'CORE',effectiveElevation:'NOT_PROVEN',
    effectiveCore:false,authorized:false,dispatchAllowed:false,replaySafe:false,
    reasons:[...codes],
  };
}
