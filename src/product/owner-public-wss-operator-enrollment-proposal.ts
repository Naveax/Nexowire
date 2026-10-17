import {createPublicKey,verify as verifySignature} from 'node:crypto';
import {
  validateOwnerPublicWssTrustProfile,
  type OwnerPublicWssTrustProfile,
} from './owner-public-wss-trust-proposal.js';

/** STAGING: identity, active session and trust root are independently authenticated. */
export interface SignedOwnerPublicWssEnrollment {
  version:1;
  operatorId:string;
  keyId:string;
  accountId:string;
  deviceId:string;
  sessionGeneration:number;
  profileRevision:number;
  issuedAtMs:number;
  expiresAtMs:number;
  profile:OwnerPublicWssTrustProfile;
  signature:string;
}
export interface TrustedOwnerPublicWssEnrollmentContext {
  operatorId:string;
  keyId:string;
  operatorPublicKeyPem:string;
  accountId:string;
  deviceId:string;
  activeSessionGeneration:number;
  minimumProfileRevision:number;
  nowMs?:number;
}

const ID=/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const BASE64URL=/^[A-Za-z0-9_-]{86}$/;
const MAX_TTL_MS=24*60*60*1000;
const MAX_CLOCK_SKEW_MS=60_000;
const ENVELOPE_KEYS=[
  'version','operatorId','keyId','accountId','deviceId',
  'sessionGeneration','profileRevision','issuedAtMs','expiresAtMs',
  'profile','signature',
] as const;

function exactRecord(value:unknown,keys:readonly string[]):boolean {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&
    Object.keys(value).every(key=>keys.includes(key));
}
function validId(value:unknown):value is string {
  return typeof value==='string'&&ID.test(value);
}
function positiveInteger(value:unknown):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
}

/** A versioned deterministic Ed25519 signature input, excluding signature. */
export function serializeOwnerPublicWssEnrollment(
  envelope:SignedOwnerPublicWssEnrollment,
):Buffer {
  if(!exactRecord(envelope,ENVELOPE_KEYS)||
    envelope.version!==1||
    !validId(envelope.operatorId)||!validId(envelope.keyId)||
    !validId(envelope.accountId)||!validId(envelope.deviceId)||
    !positiveInteger(envelope.sessionGeneration)||
    !positiveInteger(envelope.profileRevision)||
    !positiveInteger(envelope.issuedAtMs)||
    !positiveInteger(envelope.expiresAtMs)||
    typeof envelope.signature!=='string'){
    throw new Error('Invalid signed owner WSS enrollment schema');
  }
  const profile=validateOwnerPublicWssTrustProfile(envelope.profile);
  return Buffer.from(JSON.stringify([
    'nexowire.owner-public-wss-enrollment.v1',
    envelope.operatorId,envelope.keyId,envelope.accountId,envelope.deviceId,
    envelope.sessionGeneration,envelope.profileRevision,
    envelope.issuedAtMs,envelope.expiresAtMs,
    profile.endpoint,profile.hostname,profile.caMode,
    profile.trustedCaPem??null,profile.trustedSpkiSha256,
  ]),'utf8');
}

/**
 * Verify an operator-issued WSS profile without granting native execution.
 * Context MUST NOT come from tool arguments, HTTP headers, or the envelope.
 */
export function verifySignedOwnerPublicWssEnrollment(
  input:unknown,context:TrustedOwnerPublicWssEnrollmentContext,
):Readonly<OwnerPublicWssTrustProfile> {
  if(!context||!validId(context.operatorId)||!validId(context.keyId)||
    !validId(context.accountId)||!validId(context.deviceId)||
    !positiveInteger(context.activeSessionGeneration)||
    !positiveInteger(context.minimumProfileRevision)||
    typeof context.operatorPublicKeyPem!=='string'||
    context.operatorPublicKeyPem.length>8192||
    !context.operatorPublicKeyPem.includes('BEGIN PUBLIC KEY')){
    throw new Error('Invalid trusted owner enrollment context');
  }
  const now=context.nowMs??Date.now();
  if(!Number.isSafeInteger(now)||now<=0){
    throw new Error('Invalid trusted enrollment clock');
  }
  const envelope=input as SignedOwnerPublicWssEnrollment;
  const bytes=serializeOwnerPublicWssEnrollment(envelope);
  if(envelope.operatorId!==context.operatorId||
    envelope.keyId!==context.keyId||
    envelope.accountId!==context.accountId||
    envelope.deviceId!==context.deviceId||
    envelope.sessionGeneration!==context.activeSessionGeneration||
    envelope.profileRevision<context.minimumProfileRevision){
    throw new Error('Owner WSS enrollment account/device/session/revision mismatch');
  }
  if(envelope.expiresAtMs<=envelope.issuedAtMs||
    envelope.expiresAtMs-envelope.issuedAtMs>MAX_TTL_MS||
    envelope.issuedAtMs>now+MAX_CLOCK_SKEW_MS||
    now>=envelope.expiresAtMs){
    throw new Error('Owner WSS enrollment expired or outside trusted clock window');
  }
  if(!BASE64URL.test(envelope.signature)||
    Buffer.from(envelope.signature,'base64url').length!==64){
    throw new Error('Invalid owner WSS enrollment signature encoding');
  }
  let valid=false;
  try{
    const key=createPublicKey(context.operatorPublicKeyPem);
    if(key.asymmetricKeyType!=='ed25519')throw new Error('Wrong key algorithm');
    valid=verifySignature(null,bytes,key,Buffer.from(envelope.signature,'base64url'));
  }catch{valid=false}
  if(!valid)throw new Error('Invalid operator Ed25519 WSS enrollment signature');
  const profile=validateOwnerPublicWssTrustProfile(envelope.profile);
  return Object.freeze({
    endpoint:profile.endpoint,expectedHostname:profile.hostname,
    trustedSpkiSha256:Object.freeze([...profile.trustedSpkiSha256]),
    caMode:profile.caMode,
    ...(profile.caMode==='custom'?{trustedCaPem:profile.trustedCaPem}:{}),
  });
}
