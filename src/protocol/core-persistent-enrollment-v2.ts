import {createHash,createPublicKey,verify} from 'node:crypto';
import * as z from 'zod';

const id=z.string().uuid();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const epoch=z.number().int().positive().safe();
const sid=z.string().regex(/^S-1-\d+(?:-\d+)+$/);
export const PersistentEnrollmentV2Schema=z.strictObject({
  version:z.literal(2),algorithm:z.literal('ES256-P1363'),
  scope:z.literal('physical-console'),ownerAccountId:z.string().min(8).max(128),
  ownerSid:sid,deviceId:id,installationId:id,enrollmentId:id,
  machineBindingSha256:hash,issuerSpkiSha256:hash,
  generation:epoch,consentedAtMs:epoch,expiresAt:z.null(),
});
export type PersistentEnrollmentV2=z.infer<typeof PersistentEnrollmentV2Schema>;
export const PersistentSessionV2Schema=z.strictObject({
  version:z.literal(2),enrollmentSha256:hash,nonce:id,
  audience:z.literal('nexowire.local-enrollment.session'),
  bootId:id,windowsSessionId:z.number().int().positive().safe(),
  ownerSid:sid,logonLuid:z.string().regex(/^[a-f0-9]{16}$/).refine(v=>!/^0+$/.test(v)),
  observedAtMs:epoch,validUntilMs:epoch,
}).refine(v=>v.validUntilMs>v.observedAtMs&&v.validUntilMs-v.observedAtMs<=30000);
export type PersistentSessionV2=z.infer<typeof PersistentSessionV2Schema>;
const signedGrant=z.strictObject({payload:PersistentEnrollmentV2Schema,signatureBase64:z.string().length(88)});
const signedSession=z.strictObject({payload:PersistentSessionV2Schema,signatureBase64:z.string().length(88)});

// Fixed field-order arrays and domain separation are also implemented by the
// native signer. No generic JSON serializer, v1 key or caller-selected algorithm.
export function persistentEnrollmentBytes(raw:unknown):Buffer{
  const p=PersistentEnrollmentV2Schema.parse(raw);
  return Buffer.from('nexowire.local.enrollment.v2\0'+JSON.stringify([
    p.version,p.algorithm,p.scope,p.ownerAccountId,p.ownerSid,p.deviceId,
    p.installationId,p.enrollmentId,p.machineBindingSha256,p.issuerSpkiSha256,
    p.generation,p.consentedAtMs,p.expiresAt,
  ]),'utf8');
}
export function persistentEnrollmentHash(raw:unknown):string{
  return createHash('sha256').update(persistentEnrollmentBytes(raw)).digest('hex');
}
export function persistentSessionBytes(raw:unknown):Buffer{
  const p=PersistentSessionV2Schema.parse(raw);
  return Buffer.from('nexowire.local.session.v2\0'+JSON.stringify([
    p.version,p.enrollmentSha256,p.nonce,p.audience,p.bootId,
    p.windowsSessionId,p.ownerSid,p.logonLuid,p.observedAtMs,p.validUntilMs,
  ]),'utf8');
}
/** Independent authority challenge, not a locally selected signing request. */
export function persistentSessionChallengeBytes(raw:unknown):Buffer{
  return Buffer.concat([Buffer.from('nexowire.local.session.challenge.v2\0','utf8'),persistentSessionBytes(raw)]);
}

/** All expected state must come from protected local/independent authority.
 * Successful verification is NOT dispatch authorization or proof of UAC consent.
 * The caller must atomically consume its challenge and recheck revocation before
 * using a witness; this pure parser cannot provide those durable operations. */
export function verifyPersistentEnrollmentSession(input:{
  grant:unknown;session:unknown;pinnedSpkiDer:Uint8Array;
  expected:{ownerAccountId:string;ownerSid:string;deviceId:string;installationId:string;
    machineBindingSha256:string;enrollmentId:string;generation:number;revoked:boolean;
    nonce:string;bootId:string;windowsSessionId:number;logonLuid:string};
  nowMs:number;
}):Readonly<{enrollmentId:string;generation:number;consentedAtMs:number;
  expiresAt:null;sessionValidUntilMs:number;mayDispatch:false}> {
  try{
    const g=signedGrant.parse(input.grant),s=signedSession.parse(input.session);
    const p=g.payload,w=s.payload,e=input.expected;
    if(!Number.isSafeInteger(input.nowMs)||input.nowMs<=0||e.revoked!==false||
      p.consentedAtMs>input.nowMs||w.observedAtMs>input.nowMs||w.validUntilMs<=input.nowMs||
      p.consentedAtMs>w.observedAtMs||p.ownerAccountId!==e.ownerAccountId||
      p.ownerSid!==e.ownerSid||p.deviceId!==e.deviceId||p.installationId!==e.installationId||
      p.machineBindingSha256!==e.machineBindingSha256||p.enrollmentId!==e.enrollmentId||
      p.generation!==e.generation||w.enrollmentSha256!==persistentEnrollmentHash(p)||
      w.ownerSid!==e.ownerSid||w.nonce!==e.nonce||w.bootId!==e.bootId||
      w.windowsSessionId!==e.windowsSessionId||w.logonLuid!==e.logonLuid)
      throw new Error('scope');
    if(!(input.pinnedSpkiDer instanceof Uint8Array)||input.pinnedSpkiDer.byteLength>512)
      throw new Error('key');
    const der=Buffer.from(input.pinnedSpkiDer);
    if(createHash('sha256').update(der).digest('hex')!==p.issuerSpkiSha256)throw new Error('pin');
    const key=createPublicKey({key:der,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')
      throw new Error('algorithm');
    for(const [encoded,bytes] of [[g.signatureBase64,persistentEnrollmentBytes(p)],
      [s.signatureBase64,persistentSessionBytes(w)]] as const){
      const sig=Buffer.from(encoded,'base64');
      if(sig.length!==64||sig.toString('base64')!==encoded||
        !verify('sha256',bytes,{key,dsaEncoding:'ieee-p1363'},sig))throw new Error('signature');
    }
    return Object.freeze({enrollmentId:p.enrollmentId,generation:p.generation,
      consentedAtMs:p.consentedAtMs,expiresAt:null,sessionValidUntilMs:w.validUntilMs,mayDispatch:false});
  }catch{throw new Error('PERSISTENT_ENROLLMENT_V2_REJECTED');}
}
