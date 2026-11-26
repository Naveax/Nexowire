import {createHash,createPublicKey,verify} from 'node:crypto';
import * as z from 'zod';

// AI05 forward admission and independent native release are deliberately
// different signed domains. Neither a persisted fence nor a valid signature
// is proof of a protected live provider or atomic one-use consumption.
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .refine(v=>v!=='00000000-0000-0000-0000-000000000000');
const stamp=z.string().regex(/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+:-?[0-9]+$/).max(160);
const millis=z.number().int().positive().safe();
const pid=z.number().int().min(1).max(0xffffffff);
const ticks=z.string().regex(/^[1-9][0-9]{11,18}$/).refine(v=>BigInt(v)<=0x7fffffffffffffffn);
const binding=z.strictObject({
  deviceId:uuid,installationId:uuid,bootEpoch:uuid,attemptId:uuid,
  sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
  fenceGeneration:z.number().int().positive().safe(),fenceSha256:hash,
  taskName:z.string().min(1).max(128),taskDefinitionSha256:hash,
  principalSid:z.string().regex(/^S-1-(?:[0-9]+-)*[0-9]+$/).max(184),
  sessionId:z.number().int().min(0).max(0xffffffff),
  runtimeManifestSha256:hash,launcherSha256:hash,helperSha256:hash,
  launcherIdentity:stamp,helperIdentity:stamp,
});
const assignment=z.strictObject({
  rootPid:pid,rootCreationFiletime:ticks,guardianPid:pid,guardianCreationFiletime:ticks,
  sessionId:z.number().int().min(0).max(0xffffffff),
}).refine(v=>v.rootPid!==v.guardianPid&&BigInt(v.guardianCreationFiletime)<=BigInt(v.rootCreationFiletime));
const forward=z.strictObject({
  kind:z.literal('nexowire.scheduled-agent-v6.forward.v1'),binding,
  issuedAtMs:millis,expiresAtMs:millis,
});
const release=z.strictObject({
  kind:z.literal('nexowire.scheduled-agent-v6.release.v1'),binding,assignment,
  forwardSha256:hash,issuedAtMs:millis,expiresAtMs:millis,
});
const sig=z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const signedForward=z.strictObject({payload:forward,signature:sig});
const signedRelease=z.strictObject({payload:release,signature:sig});
export type ScheduledAgentV6Binding=z.infer<typeof binding>;
export type ScheduledAgentV6Assignment=z.infer<typeof assignment>;
export type ScheduledAgentV6Forward=z.infer<typeof forward>;
export type ScheduledAgentV6Release=z.infer<typeof release>;
export const SCHEDULED_AGENT_V6_FORWARD_MAX_MS=300000;
export const SCHEDULED_AGENT_V6_RELEASE_MAX_MS=30000;
export interface ScheduledAgentV6SignerPins {
  forwardSpkiBase64:string;releaseSpkiBase64:string;
  forwardSpkiSha256:string;releaseSpkiSha256:string;
}
export interface ScheduledAgentV6ForwardReviewInput extends ScheduledAgentV6SignerPins {
  // Observations and pins must come from independently protected providers.
  // These pure reviews cannot authenticate the source of those observations.
  observed:ScheduledAgentV6Binding;
  nowMs:number;
  forwardEnvelope:unknown;
}
export interface ScheduledAgentV6ReviewInput extends ScheduledAgentV6ForwardReviewInput {
  observedAssignment:ScheduledAgentV6Assignment;
  releaseEnvelope:unknown;
}
function fail(code:string):never{throw Error('SCHEDULED_AGENT_V6_'+code)}
function bytes(v:unknown):Buffer{return Buffer.from(JSON.stringify(v),'utf8')}
function digest(v:Uint8Array):string{return createHash('sha256').update(v).digest('hex')}
export function scheduledAgentV6ForwardSigningBytes(value:ScheduledAgentV6Forward):Buffer{
  return Buffer.concat([Buffer.from('nexowire.scheduled-agent-v6.forward.v1\0'),bytes(forward.parse(value))]);
}
export function scheduledAgentV6ReleaseSigningBytes(value:ScheduledAgentV6Release):Buffer{
  return Buffer.concat([Buffer.from('nexowire.scheduled-agent-v6.release.v1\0'),bytes(release.parse(value))]);
}
export function scheduledAgentV6ForwardEnvelopeSha256(value:unknown):string{
  return digest(bytes(signedForward.parse(value)));
}
function key(encoded:string,pin:string){
  if(typeof encoded!=='string'||encoded.length!==60||!hash.safeParse(pin).success)
    return fail('SIGNER_PIN_REQUIRED');
  const der=Buffer.from(encoded,'base64');
  if(der.length!==44||der.toString('base64')!==encoded||digest(der)!==pin)
    return fail('SIGNER_PIN_MISMATCH');
  const k=createPublicKey({key:der,format:'der',type:'spki'});
  if(k.asymmetricKeyType!=='ed25519')return fail('SIGNER_TYPE');
  return k;
}
function checkSignature(raw:string,message:Buffer,k:ReturnType<typeof key>){
  const signature=Buffer.from(raw,'base64url');
  if(signature.length!==64||signature.toString('base64url')!==raw||
     !verify(null,message,k,signature))fail('SIGNATURE_INVALID');
}
function checkTime(v:{issuedAtMs:number;expiresAtMs:number},now:number,max:number){
  if(v.expiresAtMs<=v.issuedAtMs||v.expiresAtMs-v.issuedAtMs>max||
     now<v.issuedAtMs||now>=v.expiresAtMs)fail('EXPIRED_OR_FUTURE');
}
/** Forward-only candidate review before the suspended helper/root exists.
 * Snapshot signed binding so an asynchronous installed-file reader cannot
 * accidentally compare a subsequently mutated caller-owned observation. */
export function reviewScheduledAgentV6ForwardEvidence(input:ScheduledAgentV6ForwardReviewInput){
  const observed=Object.freeze(binding.parse(input.observed));
  const now=millis.parse(input.nowMs),f=signedForward.parse(input.forwardEnvelope);
  if(input.forwardSpkiSha256===input.releaseSpkiSha256)fail('INDEPENDENT_SIGNERS_REQUIRED');
  const fk=key(input.forwardSpkiBase64,input.forwardSpkiSha256);
  // Both independent pinned public keys must be provisioned before forward review.
  key(input.releaseSpkiBase64,input.releaseSpkiSha256);
  checkSignature(f.signature,scheduledAgentV6ForwardSigningBytes(f.payload),fk);
  checkTime(f.payload,now,SCHEDULED_AGENT_V6_FORWARD_MAX_MS);
  if(!bytes(f.payload.binding).equals(bytes(observed)))fail('BOOT_OR_BINDING_MISMATCH');
  if(observed.sessionId===0&&observed.principalSid!=='S-1-5-18')
    fail('SYSTEM_SESSION_REQUIRED');
  if(observed.taskName==='Nexowire Prelogin Agent'&&
     (observed.sessionId!==0||observed.principalSid!=='S-1-5-18'))fail('SYSTEM_SESSION_REQUIRED');
  return Object.freeze({
    signaturesVerified:true as const,bindingMatched:true as const,verifiedBinding:observed,
    forwardSha256:scheduledAgentV6ForwardEnvelopeSha256(f),
    forwardIssuedAtMs:f.payload.issuedAtMs,forwardExpiresAtMs:f.payload.expiresAtMs,
    activationAuthorized:false as const,releaseAuthorized:false as const,consumed:false as const,
  });
}

/** Cryptographic candidate review only. Boot epoch must be kernel-derived by
 * the future protected supervisor; wall clock, task Enabled, and the local
 * fence are not substitutes. This function grants no OS effect. */
export function reviewScheduledAgentV6Evidence(input:ScheduledAgentV6ReviewInput){
  const f=reviewScheduledAgentV6ForwardEvidence(input);
  const actual=Object.freeze(assignment.parse(input.observedAssignment));
  const now=millis.parse(input.nowMs),r=signedRelease.parse(input.releaseEnvelope);
  const rk=key(input.releaseSpkiBase64,input.releaseSpkiSha256);
  checkSignature(r.signature,scheduledAgentV6ReleaseSigningBytes(r.payload),rk);
  checkTime(r.payload,now,SCHEDULED_AGENT_V6_RELEASE_MAX_MS);
  if(!bytes(r.payload.binding).equals(bytes(f.verifiedBinding)))fail('BOOT_OR_BINDING_MISMATCH');
  if(actual.sessionId!==f.verifiedBinding.sessionId||!bytes(r.payload.assignment).equals(bytes(actual)))
    fail('ASSIGNMENT_MISMATCH');
  if(r.payload.forwardSha256!==f.forwardSha256||
     r.payload.issuedAtMs<f.forwardIssuedAtMs||
     r.payload.expiresAtMs>f.forwardExpiresAtMs)fail('FORWARD_CHAIN_MISMATCH');
  return Object.freeze({...f,verifiedAssignment:actual,
    releaseSha256:digest(bytes(r)),releaseIssuedAtMs:r.payload.issuedAtMs,
    releaseExpiresAtMs:r.payload.expiresAtMs});
}
