import {createHash} from 'node:crypto';

/**
 * #35 source-only pairing writer boundary. This is deliberately NOT a D1,
 * SQLite, WSS or production authority adapter. No local lock, SQL transaction,
 * signed receipt, or caller-declared provider can establish off-host CAS.
 * Until an independently reviewed non-restorable linearizable provider exists,
 * ALL writes and reads requiring authorization remain BLOCKED.
 */
export type PairingRealm='self-host'|'cloud';
export type PairingMutationKind='ENROLL'|'REPAIR'|'REVOKE';

export interface PairingMutationIntent {
  readonly version:1;
  readonly realm:PairingRealm;
  readonly kind:PairingMutationKind;
  readonly ownerAccountId:string;
  readonly deviceId:string;
  /** Original request identity; do not mint another ID after lost ACK. */
  readonly requestId:string;
  /** #792 authentication epoch is distinct from owner and pairing epochs. */
  readonly oauthSessionEpoch:number;
  /** Expected epochs; validation alone cannot prove they are current. */
  readonly ownerEpoch:number;
  readonly pairingEpoch:number;
  readonly issuerId:string;
  readonly issuerEpoch:number;
  /** SHA256 of DER SPKI, never private signing material. */
  readonly signerSpkiSha256:string;
  /** Digest of a fresh one-use nonce, null only for REVOKE. */
  readonly nonceSha256:string|null;
  readonly issuedAtMs:number;
  readonly expiresAtMs:number;
}

export interface PairingReadIntent {
  readonly version:1;
  readonly realm:PairingRealm;
  readonly ownerAccountId:string;
  readonly deviceId:string;
  /** Required to reconcile the ORIGINAL possibly-committed operation. */
  readonly requestId:string;
  readonly intentFingerprintSha256:string;
}

export interface EnrollmentClaimIntent {
  readonly version:1;
  readonly realm:PairingRealm;
  readonly ownerAccountId:string;
  readonly deviceId:string;
  /** Same immutable requestId and fingerprint as original commitPairing. */
  readonly requestId:string;
  readonly intentFingerprintSha256:string;
  readonly oauthSessionEpoch:number;
  readonly ownerEpoch:number;
  readonly pairingEpoch:number;
  readonly issuerId:string;
  readonly issuerEpoch:number;
  readonly signerSpkiSha256:string;
  readonly nonceSha256:string;
  readonly devicePossessionProofSha256:string;
}

export interface PairingBlocked {
  readonly status:'BLOCKED';
  readonly code:'EXTERNAL_LINEARIZABLE_PAIRING_AUTHORITY_REQUIRED';
  readonly mayDispatch:false;
  readonly mayReplay:false;
}
export interface PairingUnknown {
  readonly status:'UNKNOWN';
  readonly code:'PAIRING_COMMIT_OUTCOME_UNKNOWN';
  readonly originalRequestId:string;
  readonly reconciliationRequired:true;
  readonly mayDispatch:false;
  readonly mayReplay:false;
}

const BLOCKED:PairingBlocked=Object.freeze({
  status:'BLOCKED',code:'EXTERNAL_LINEARIZABLE_PAIRING_AUTHORITY_REQUIRED',
  mayDispatch:false,mayReplay:false,
});
const ID=/^[A-Za-z0-9][A-Za-z0-9._:@-]{7,127}$/;
const SHA=/^[a-f0-9]{64}$/;
const MUTATION_FIELDS=[
  'version','realm','kind','ownerAccountId','deviceId','requestId',
  'oauthSessionEpoch','ownerEpoch','pairingEpoch','issuerId','issuerEpoch','signerSpkiSha256',
  'nonceSha256','issuedAtMs','expiresAtMs',
] as const;
const READ_FIELDS=[
  'version','realm','ownerAccountId','deviceId','requestId',
  'intentFingerprintSha256',
] as const;
const CLAIM_FIELDS=[
  'version','realm','ownerAccountId','deviceId','requestId',
  'intentFingerprintSha256','oauthSessionEpoch','ownerEpoch','pairingEpoch',
  'issuerId','issuerEpoch','signerSpkiSha256',
  'nonceSha256','devicePossessionProofSha256',
] as const;

function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&
    Object.keys(value).every(key=>keys.includes(key));
}
function id(value:unknown):value is string {
  return typeof value==='string'&&ID.test(value);
}
function sha(value:unknown):value is string {
  return typeof value==='string'&&SHA.test(value);
}
function epoch(value:unknown,allowZero=false):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&
    value>=(allowZero?0:1);
}
function realm(value:unknown):value is PairingRealm{
  return value==='self-host'||value==='cloud';
}

/** Validate exact shape; provider MUST separately prove current epochs. */
export function validatePairingMutation(value:unknown):Readonly<PairingMutationIntent>{
  if(!exact(value,MUTATION_FIELDS)||value.version!==1||
    !realm(value.realm)||
    !['ENROLL','REPAIR','REVOKE'].includes(value.kind as string)||
    !id(value.ownerAccountId)||!id(value.deviceId)||!id(value.requestId)||
    !epoch(value.oauthSessionEpoch)||!epoch(value.ownerEpoch)||
    !epoch(value.pairingEpoch,true)||!id(value.issuerId)||
    !epoch(value.issuerEpoch)||!sha(value.signerSpkiSha256)||
    (value.kind==='REVOKE'?value.nonceSha256!==null:!sha(value.nonceSha256))||
    !epoch(value.issuedAtMs)||!epoch(value.expiresAtMs)||
    (value.expiresAtMs as number)<=(value.issuedAtMs as number)||
    (value.expiresAtMs as number)-(value.issuedAtMs as number)>300_000){
    throw new Error('PAIRING_INTENT_INVALID');
  }
  return Object.freeze({...value}) as unknown as Readonly<PairingMutationIntent>;
}
export function validatePairingRead(value:unknown):Readonly<PairingReadIntent>{
  if(!exact(value,READ_FIELDS)||value.version!==1||
    !realm(value.realm)||!id(value.ownerAccountId)||!id(value.deviceId)||
    !id(value.requestId)||!sha(value.intentFingerprintSha256)){
    throw new Error('PAIRING_READ_INVALID');
  }
  return Object.freeze({...value}) as unknown as Readonly<PairingReadIntent>;
}
export function validateEnrollmentClaim(value:unknown):Readonly<EnrollmentClaimIntent>{
  if(!exact(value,CLAIM_FIELDS)||value.version!==1||!realm(value.realm)||
    !id(value.ownerAccountId)||!id(value.deviceId)||!id(value.requestId)||
    !sha(value.intentFingerprintSha256)||!epoch(value.oauthSessionEpoch)||
    !epoch(value.ownerEpoch)||!epoch(value.pairingEpoch)||
    !id(value.issuerId)||!epoch(value.issuerEpoch)||
    !sha(value.signerSpkiSha256)||
    !sha(value.nonceSha256)||!sha(value.devicePossessionProofSha256)){
    throw new Error('PAIRING_CLAIM_INVALID');
  }
  return Object.freeze({...value}) as unknown as Readonly<EnrollmentClaimIntent>;
}

/** Stable idempotency fingerprint only. A digest is NOT a signed grant or CAS. */
export function pairingMutationFingerprint(value:unknown):string{
  const v=validatePairingMutation(value);
  const tuple=MUTATION_FIELDS.map(k=>v[k]);
  return createHash('sha256').update(JSON.stringify([
    'nexowire.pairing-writer-intent.v1',...tuple,
  ])).digest('hex');
}

/** A lost commit ACK is UNKNOWN, NOT DENIED or a retry authorization. */
export function pairingAcknowledgementLost(value:unknown):PairingUnknown{
  const v=validatePairingMutation(value);
  return Object.freeze({
    status:'UNKNOWN',code:'PAIRING_COMMIT_OUTCOME_UNKNOWN',
    originalRequestId:v.requestId,reconciliationRequired:true,
    mayDispatch:false,mayReplay:false,
  });
}

/**
 * Unbound adapter is safe to instantiate on multiple Hubs. It never writes
 * pairing/device state or returns a permission. A future provider must replace
 * this contract only after independent external-CAS proof and audit.
 */
export class UnboundPairingWriter {
  async commitPairing(input:unknown):Promise<PairingBlocked>{
    validatePairingMutation(input);
    return BLOCKED;
  }
  async readCurrentPairing(input:unknown):Promise<PairingBlocked>{
    validatePairingRead(input);
    return BLOCKED;
  }
  async claimEnrollment(input:unknown):Promise<PairingBlocked>{
    validateEnrollmentClaim(input);
    return BLOCKED;
  }
}
