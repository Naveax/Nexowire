import {createHash,createPublicKey,randomBytes,verify} from 'node:crypto';
import * as z from 'zod';
import {CoreNativeProofSchema,coreNativeWireRequestHash}
  from '../protocol/core-native-consent-transport.js';

const positive=z.number().int().positive().safe();
const b64=z.string().regex(/^[A-Za-z0-9_-]+$/);
const rp=z.string().min(3).max(253).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);
export const CoreWebAuthnIntentSchema=CoreNativeProofSchema.omit({
  receiptId:true,approvedAtMs:true,consumed:true,
}).extend({rpId:rp,credentialId:b64.max(1366),nonce:z.string().regex(/^[a-f0-9]{64}$/),
  issuedAtMs:positive,expiresAtMs:positive});
export type CoreWebAuthnIntent=z.infer<typeof CoreWebAuthnIntentSchema>;
const assertionSchema=z.strictObject({version:z.literal(1),kind:z.literal('core_webauthn_assertion_v1'),
  credentialId:b64.max(1366),clientDataJSON:b64.max(8192),authenticatorData:b64.max(1024),
  signature:b64.max(128),userHandle:b64.max(86).nullable(),coreAuthority:z.literal(false)});
export type CoreWebAuthnAssertion=z.infer<typeof assertionSchema>;
export interface PinnedCoreWebAuthnCredential {
  readonly credentialId:string;
  /** Provisioned independently, never learned from the assertion's own data. */
  readonly publicKeyPem:string;
  readonly userHandle:string|null;
  readonly previousSignatureCounter:number;
}
function fail(code:string):never{throw new Error('CORE_WEBAUTHN_'+code)}
function bytes(value:string,min:number,max:number):Buffer{
  const data=Buffer.from(value,'base64url');
  if(data.length<min||data.length>max||data.toString('base64url')!==value)fail('ENCODING_INVALID');
  return data;
}
function checkedIntent(value:CoreWebAuthnIntent,now:number):Readonly<CoreWebAuthnIntent>{
  const parsed=CoreWebAuthnIntentSchema.parse(value);
  bytes(parsed.credentialId,1,1024);
  if(!Number.isSafeInteger(now)||now<=0||parsed.issuedAtMs>now+2000||
    parsed.expiresAtMs<=now||parsed.expiresAtMs<=parsed.issuedAtMs||
    parsed.expiresAtMs-parsed.issuedAtMs>120000)fail('CHALLENGE_STALE');
  return Object.freeze(parsed);
}
/** Scope includes the exact protected Windows SID/logon binding, not just owner UI state. */
export function coreWebAuthnIntentHash(value:CoreWebAuthnIntent):string{
  const intent=CoreWebAuthnIntentSchema.parse(value);
  return coreNativeWireRequestHash({version:1,operation:'approve-and-consume',
    nonce:intent.challengeId,expected:intent});
}
export function prepareCoreWebAuthnChallenge(
  binding:Omit<CoreWebAuthnIntent,'nonce'|'issuedAtMs'|'expiresAtMs'>,
  now=Date.now(),
):{intent:Readonly<CoreWebAuthnIntent>;challengeHex:string;clientDataJSON:string}{
  const intent=checkedIntent({...binding,nonce:randomBytes(32).toString('hex'),
    issuedAtMs:now,expiresAtMs:now+120000},now);
  const challengeHex=coreWebAuthnIntentHash(intent);
  const clientDataJSON=JSON.stringify({type:'webauthn.get',
    challenge:Buffer.from(challengeHex,'hex').toString('base64url'),
    origin:'https://'+intent.rpId,crossOrigin:false});
  return {intent,challengeHex,clientDataJSON};
}
export interface VerifiedCoreWebAuthnAssertion {
  readonly intent:Readonly<CoreWebAuthnIntent>;
  readonly intentSha256:string;
  readonly assertionSha256:string;
  readonly credentialSpkiSha256:string;
  readonly previousSignatureCounter:number;
  readonly nextSignatureCounter:number;
  readonly authenticatorUserPresence:true;
  readonly authenticatorUserVerification:true;
  /** A valid assertion is not attestation of authenticator hardware or Windows. */
  readonly physicalAcceptance:'NOT_PROVEN';
  readonly coreAuthority:false;
}
/** Cryptographic ES256 assertion verification; does not consume or grant CORE. */
export function verifyCoreWebAuthnAssertion(
  raw:unknown,intentValue:CoreWebAuthnIntent,credentialValue:PinnedCoreWebAuthnCredential,
  now=Date.now(),
):Readonly<VerifiedCoreWebAuthnAssertion>{
  const intent=checkedIntent(intentValue,now),assertion=assertionSchema.parse(raw);
  const credential={...credentialValue};
  if(credential.credentialId!==intent.credentialId||assertion.credentialId!==intent.credentialId||
    assertion.userHandle!==credential.userHandle||!Number.isInteger(credential.previousSignatureCounter)||
    credential.previousSignatureCounter<0||credential.previousSignatureCounter>0xffffffff)
    fail('CREDENTIAL_NOT_PINNED');
  bytes(assertion.credentialId,1,1024);
  if(assertion.userHandle!==null)bytes(assertion.userHandle,1,64);
  const clientBytes=bytes(assertion.clientDataJSON,1,6144);
  const auth=bytes(assertion.authenticatorData,37,37),signature=bytes(assertion.signature,8,80);
  const expectedHash=coreWebAuthnIntentHash(intent);
  const expectedClient=JSON.stringify({type:'webauthn.get',
    challenge:Buffer.from(expectedHash,'hex').toString('base64url'),
    origin:'https://'+intent.rpId,crossOrigin:false});
  // The native component constructs this exact, extension-free client data.
  // Reject duplicate JSON keys, cross-origin, injected extensions and ambiguous
  // alternative encodings; verification always hashes the actual original bytes.
  if(!clientBytes.equals(Buffer.from(expectedClient,'utf8')))fail('CLIENT_DATA_UNBOUND');
  if(!auth.subarray(0,32).equals(createHash('sha256').update(intent.rpId).digest()))fail('RP_ID_MISMATCH');
  // This strict native profile requires UP+UV, no backup/sync eligibility,
  // attested credential data, extensions or reserved flags in an assertion.
  if(auth[32]!==0x05)fail('USER_VERIFICATION_REQUIRED');
  const counter=auth.readUInt32BE(33),previous=credential.previousSignatureCounter;
  if((previous!==0||counter!==0)&&counter<=previous)fail('SIGNATURE_COUNTER_REPLAY');
  const key=createPublicKey(credential.publicKeyPem);
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')
    fail('CREDENTIAL_ALGORITHM_INVALID');
  const signed=Buffer.concat([auth,createHash('sha256').update(clientBytes).digest()]);
  if(!verify('sha256',signed,key,signature))fail('SIGNATURE_INVALID');
  return Object.freeze({intent,intentSha256:expectedHash,
    assertionSha256:createHash('sha256').update(signed).update(signature).digest('hex'),
    credentialSpkiSha256:createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex'),
    previousSignatureCounter:previous,nextSignatureCounter:counter,
    authenticatorUserPresence:true,authenticatorUserVerification:true,
    physicalAcceptance:'NOT_PROVEN',coreAuthority:false});
}
export interface CoreWebAuthnConsumeReceipt {
  readonly challengeId:string;readonly nonce:string;readonly intentSha256:string;
  readonly credentialSpkiSha256:string;readonly previousSignatureCounter:number;
  readonly nextSignatureCounter:number;readonly consumed:true;
}
/**
 * The callback MUST be a durable, rollback-independent conditional consume
 * against current owner/device/session/enrollment/revoke epochs and credential
 * pin/counter. It must tombstone challenge+nonce even with counterless FIDO
 * authenticators. No Map/file or timestamp fallback is supplied here.
 */
export async function consumeCoreWebAuthnApproval(
  raw:unknown,intent:CoreWebAuthnIntent,credential:PinnedCoreWebAuthnCredential,
  consumeOnce:(verified:Readonly<VerifiedCoreWebAuthnAssertion>)=>Promise<CoreWebAuthnConsumeReceipt|null>,
):Promise<Readonly<VerifiedCoreWebAuthnAssertion>>{
  const startedMs=Date.now(),startedNs=process.hrtime.bigint();
  const verified=verifyCoreWebAuthnAssertion(raw,intent,credential,startedMs);
  let receipt;
  try{receipt=await consumeOnce(verified)}catch{return fail('CONSUMPTION_UNKNOWN')}
  const expected={challengeId:verified.intent.challengeId,nonce:verified.intent.nonce,
    intentSha256:verified.intentSha256,credentialSpkiSha256:verified.credentialSpkiSha256,
    previousSignatureCounter:verified.previousSignatureCounter,
    nextSignatureCounter:verified.nextSignatureCounter,consumed:true};
  if(!receipt||!Object.keys(expected).every(k=>(receipt as unknown as Record<string,unknown>)[k]===
    (expected as Record<string,unknown>)[k]))fail('CONSUMPTION_DENIED');
  const now=Date.now(),elapsed=process.hrtime.bigint()-startedNs;
  if(now<startedMs||elapsed<0n||elapsed>=BigInt(verified.intent.expiresAtMs-startedMs)*1000000n)
    fail('CHALLENGE_STALE');
  checkedIntent(verified.intent,now);
  return verified;
}
