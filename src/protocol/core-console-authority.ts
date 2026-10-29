import {createHash,createPublicKey,verify} from 'node:crypto';
import * as z from 'zod';
import {canonicalCoreConsoleEnrollment,type SignedCoreConsoleEnrollmentV1,
  type CoreConsoleCurrentReadback} from '../agent/core-console-enrollment-policy.js';

const id=z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]+$/);
export function normalizeCoreAuthorityUrl(raw:string):string {
  if(raw.length>2048)throw new Error('CORE_AUTHORITY_HTTPS_REQUIRED');
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)
    throw new Error('CORE_AUTHORITY_HTTPS_REQUIRED');
  return url.origin;
}
export async function readCoreJson(message:Request|Response):Promise<unknown>{
  if(!message.headers.get('content-type')?.toLowerCase().includes('application/json'))throw new Error('CORE_JSON_REQUIRED');
  const reader=message.body?.getReader();if(!reader)throw new Error('CORE_JSON_REQUIRED');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const next=await reader.read();if(next.done)break;
      size+=next.value.byteLength;if(size>16384){await reader.cancel();throw new Error('CORE_JSON_TOO_LARGE');}
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}
export const CoreAuthorityRequestSchema=z.strictObject({
  action:z.enum(['read','enroll','dismiss','reserve','claim','complete','revoke','report']),
  deviceId:id,installationId:z.string().uuid(),nonce:z.string().uuid(),
  issuedAtMs:z.number().int().positive().safe(),
  certificate:z.unknown().optional(),publicKeySpki:z.string().max(128).optional(),
  // An Agent-provided receipt is not a physical approval until separately
  // authenticated and atomically consumed by an installed native verifier.
  nativeConsent:z.strictObject({
    version:z.literal(1),challengeId:z.string().uuid(),receiptId:z.string().uuid(),
    ownerAccountId:id,deviceId:id,installationId:z.string().uuid(),enrollmentId:z.string().uuid(),
    ownerEpoch:z.number().int().positive().safe(),
    grantGeneration:z.number().int().positive().safe(),
    revokeEpoch:z.number().int().nonnegative().safe(),
    // Native verifier binds this to the current token AuthenticationId and WTS session.
    windowsSessionId:z.number().int().positive().safe(),
    windowsUserSid:z.string().regex(/^S-\d-\d+(?:-\d+)+$/i),
    windowsLogonLuid:z.string().regex(/^[0-9a-f]{16}$/i).refine(v=>!/^0+$/.test(v)),
    windowsLogonSessionEpoch:z.string().uuid(),
    approvedAtMs:z.number().int().positive().safe(),consumed:z.literal(true),
  }).optional(),
  requestId:z.string().uuid().optional(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  signature:z.string().length(88).optional(),
  outcome:z.enum(['succeeded','denied','unknown']).optional(),
  active:z.boolean().optional(),
});
export type CoreAuthorityRequest=z.infer<typeof CoreAuthorityRequestSchema>;
export interface CoreAuthorityState extends CoreConsoleCurrentReadback {
  authorityTimeMs:number;
  enrollmentRequested:boolean;
  enrollmentId:string|null; publicKeySpki:string|null;
  physicalActive:boolean; statusObservedAtMs:number|null;
  /** D1-sourced device platform and complete readiness; absent legacy fields deny CORE. */
  devicePlatform?:string;deviceReady?:boolean;
  nativeConsentReceiptId:string|null; windowsUserSid:string|null;
  windowsSessionId:number|null; windowsLogonLuid:string|null;
  windowsLogonSessionEpoch:string|null;
}
export interface CoreAuthorityResponse {nonce:string;state:CoreAuthorityState}
export const CoreAuthorityStateSchema=z.strictObject({ownerAccountId:id,deviceId:id,
  authorityTimeMs:z.number().int().positive().safe(),
  installationId:z.string().uuid(),ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),revokeEpoch:z.number().int().nonnegative().safe(),
  coreEnabled:z.boolean(),accessMode:z.enum(['safe','full']),deviceOnline:z.boolean(),bridgeVerified:z.boolean(),
  enrollmentRequested:z.boolean(),enrollmentId:z.string().uuid().nullable(),publicKeySpki:z.string().length(60).nullable(),
  physicalActive:z.boolean(),statusObservedAtMs:z.number().int().nonnegative().safe().nullable(),
  devicePlatform:z.string().min(1).max(32).optional(),deviceReady:z.boolean().optional(),
  nativeConsentReceiptId:z.string().uuid().nullable(),
  windowsUserSid:z.string().regex(/^S-\d-\d+(?:-\d+)+$/i).nullable(),
  windowsSessionId:z.number().int().positive().safe().nullable(),
  windowsLogonLuid:z.string().regex(/^[0-9a-f]{16}$/i).refine(v=>!/^0+$/.test(v)).nullable(),
  windowsLogonSessionEpoch:z.string().uuid().nullable()});
export function coreOperationBytes(input:CoreAuthorityRequest):Buffer {
  // Existing read/report/reserve/claim/complete/revoke signatures must retain
  // their v1 bytes. Only newly attested enrollment extends the signed fields.
  const fields:unknown[]=['nexowire.core-console.operation.v1',
    input.action,input.deviceId,input.installationId,input.nonce,input.issuedAtMs,
    input.requestId??null,input.fingerprint??null,input.outcome??null,input.active??null];
  if(input.action==='enroll'&&input.nativeConsent)fields.push([
    input.nativeConsent.version,input.nativeConsent.challengeId,
    input.nativeConsent.receiptId,input.nativeConsent.ownerAccountId,
    input.nativeConsent.deviceId,input.nativeConsent.installationId,
    input.nativeConsent.enrollmentId,input.nativeConsent.ownerEpoch,
    input.nativeConsent.grantGeneration,input.nativeConsent.revokeEpoch,
    input.nativeConsent.windowsSessionId,input.nativeConsent.windowsUserSid,
    input.nativeConsent.windowsLogonLuid,input.nativeConsent.windowsLogonSessionEpoch,
    input.nativeConsent.approvedAtMs,input.nativeConsent.consumed,
  ]);
  return Buffer.from(JSON.stringify(fields));
}
export function corePublicKey(spki:string){
  const der=Buffer.from(spki,'base64');
  if(der.length!==44||der.toString('base64')!==spki)throw new Error('CORE_KEY_INVALID');
  const key=createPublicKey({key:der,type:'spki',format:'der'});
  if(key.asymmetricKeyType!=='ed25519')throw new Error('CORE_KEY_INVALID');
  return key;
}
export function verifyCoreOperation(input:CoreAuthorityRequest,spki:string):boolean {
  try {const sig=Buffer.from(input.signature??'','base64');
    return sig.length===64&&sig.toString('base64')===input.signature&&
      verify(null,coreOperationBytes(input),corePublicKey(spki),sig);
  }catch{return false;}
}
export function verifyCoreCertificate(raw:unknown,spki:string):SignedCoreConsoleEnrollmentV1 {
  const c=raw as SignedCoreConsoleEnrollmentV1;
  const key=corePublicKey(spki),der=key.export({type:'spki',format:'der'});
  const sig=Buffer.from(c?.signatureBase64??'','base64');
  if(!c||Object.keys(c).length!==2||sig.length!==64||
    sig.toString('base64')!==c.signatureBase64||
    c.enrollment.issuerSpkiSha256!==createHash('sha256').update(der).digest('hex')||
    !verify(null,canonicalCoreConsoleEnrollment(c.enrollment),key,sig))
    throw new Error('CORE_CERTIFICATE_INVALID');
  return c;
}
