import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import * as z from 'zod';

/**
 * #323/#617 scoped local approval proof. This is an independent, pure
 * cryptographic *transcript verifier*, NOT a Windows UAC/consent adapter,
 * local key enrollment or privileged command authorization.
 */
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const guid=z.string().uuid().refine(s=>s===s.toLowerCase(),'canonical lowercase GUID required');
const localSid=z.string().regex(/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/);
const time=z.string().datetime({offset:true});
const ReceiptFields=z.strictObject({
  kind:z.literal('nexowire.hyperv.local-approval.v1'),
  requestId:guid,
  ownerAccountId:id,deviceId:id,vmId:guid,
  capability:z.enum(['hyperv.vm.start','hyperv.vm.stop']),
  policySha256:sha,pairedCredentialSha256:sha,
  brokerVersion:z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  localUserSid:localSid,
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt:time,expiresAt:time,
  /** A signature binds this assertion, not the actual UAC secure desktop. */
  claimedLocalConsent:z.literal('visible-user-consent'),
});
export const HypervLocalApprovalEnvelope=ReceiptFields.extend({
  signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type LocalApprovalFields=z.infer<typeof ReceiptFields>;
export type LocalApprovalEnvelope=z.infer<typeof HypervLocalApprovalEnvelope>;
export interface TrustedLocalApprovalContext {
  readonly requestId:string;
  readonly ownerAccountId:string;
  readonly deviceId:string;
  readonly vmId:string;
  readonly capability:'hyperv.vm.start'|'hyperv.vm.stop';
  readonly policySha256:string;
  readonly pairedCredentialSha256:string;
  readonly brokerVersion:string;
  readonly localUserSid:string;
  readonly now:Date;
  /** Independently registered and protected key for this pairing. */
  readonly registeredLocalPublicKey:KeyObject;
  /** Durable one-shot register; never accept a caller-provided boolean. */
  readonly wasRequestConsumed:(requestId:string)=>boolean;
}

export function localApprovalSigningBytes(payload:LocalApprovalFields):Buffer{
  const s=ReceiptFields.parse(payload);
  return Buffer.from(JSON.stringify([
    'nexowire.hyperv.local-approval.v1',s.requestId,
    s.ownerAccountId,s.deviceId,s.vmId,s.capability,s.policySha256,
    s.pairedCredentialSha256,s.brokerVersion,s.localUserSid,
    s.nonce,s.issuedAt,s.expiresAt,s.claimedLocalConsent,
  ]),'utf8');
}
export function verifyScopedLocalApproval(
  raw:unknown,ctx:TrustedLocalApprovalContext,
):Readonly<{
  signatureAndScopeVerified:true;
  requestId:string;publicKeySha256:string;
  physicalUacVerified:false;
  WindowsTokenAttested:false;
  productionExecutionAllowed:false;
}>{
  const payload=HypervLocalApprovalEnvelope.parse(raw);
  const {signature,...fields}=payload;
  for(const name of [
    'requestId','ownerAccountId','deviceId','vmId','capability',
    'policySha256','pairedCredentialSha256','brokerVersion','localUserSid',
  ] as const){
    if(fields[name]!==ctx[name])throw new Error('LOCAL_APPROVAL_SCOPE_MISMATCH');
  }
  const issued=Date.parse(fields.issuedAt),expires=Date.parse(fields.expiresAt);
  const now=ctx.now.getTime();
  if(!Number.isFinite(now)||!Number.isFinite(issued)||!Number.isFinite(expires)||
    expires<=issued||expires-issued>60_000||now<issued-5000||now>=expires){
    throw new Error('LOCAL_APPROVAL_EXPIRED_OR_UNTRUSTED_CLOCK');
  }
  const nonce=Buffer.from(fields.nonce,'base64url');
  if(nonce.length!==32||nonce.toString('base64url')!==fields.nonce||
    nonce.every(byte=>byte===0)){
    throw new Error('LOCAL_APPROVAL_NONCE_INVALID');
  }
  if(ctx.wasRequestConsumed(fields.requestId)){
    throw new Error('LOCAL_APPROVAL_REPLAY');
  }
  const key=ctx.registeredLocalPublicKey;
  if(key?.type!=='public'||key.asymmetricKeyType!=='ed25519'){
    throw new Error('LOCAL_APPROVAL_SIGNER_UNTRUSTED');
  }
  const bytes=Buffer.from(signature,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==signature||
    !verify(null,localApprovalSigningBytes(fields),key,bytes)){
    throw new Error('LOCAL_APPROVAL_BAD_SIGNATURE');
  }
  return Object.freeze({
    signatureAndScopeVerified:true as const,
    requestId:fields.requestId,
    publicKeySha256:createHash('sha256')
      .update(key.export({type:'spki',format:'der'})).digest('hex'),
    physicalUacVerified:false as const,
    WindowsTokenAttested:false as const,
    productionExecutionAllowed:false as const,
  });
}

/**
 * Diagnostic only. Even an all-verified synthetic snapshot remains an
 * untrusted candidate; an actual native admission gate must re-verify
 * identities, immutable VM GUID, token and consent at execution time.
 */
export interface HypervAuthorityFacts {
  readonly capability:'hyperv.vm.start'|'hyperv.vm.stop';
  readonly ownerPolicyExactVmGuid:boolean;
  readonly ownerDevicePairingCurrent:boolean;
  readonly scopedApprovalCryptographicallyMatched:boolean;
  readonly localUacConsent:'unknown'|'pending'|'rejected'|'physically-verified';
  readonly windowsToken:'medium-deny-only'|'unknown'|'high-enabled-admin';
  readonly brokerHealth:'unauthenticated-401'|'unverified'|'authenticated-pinned';
  readonly brokerVersion:'unknown'|'mismatch'|'matched-pinned';
  readonly protectedAcl:'unknown'|'unsafe-inherited-modify'|'verified-by-independent-observer';
  readonly guardian:'unknown'|'untrusted'|'independently-attested';
  readonly providerPolicy:'unverified'|'denied'|'allowed-independently';
  readonly dispatch:'not-sent'|'ack-unverified'|'lost-confirmation';
}
export function explainScopedHypervAuthority(f:HypervAuthorityFacts):Readonly<{
  state:'BLOCKED'|'CANDIDATE_ONLY'|'MUTATION_STATE_UNKNOWN';
  reasons:readonly string[];
  windowsElevationProvenByPreference:false;
  health401ProvesElevation:false;
  canExecute:false;
  effectVerified:false;
  automaticallyRetryable:false;
}>{
  const reasons:string[]=[];
  if(!f.ownerPolicyExactVmGuid)reasons.push('VM_GUID_POLICY_NOT_BOUND');
  if(!f.ownerDevicePairingCurrent)reasons.push('OWNER_DEVICE_PAIRING_UNVERIFIED');
  if(!f.scopedApprovalCryptographicallyMatched)reasons.push('SIGNED_LOCAL_APPROVAL_MISSING');
  if(f.localUacConsent!=='physically-verified')reasons.push('VISIBLE_UAC_CONSENT_UNVERIFIED');
  if(f.windowsToken!=='high-enabled-admin')reasons.push('WINDOWS_ADMIN_ENABLED_TOKEN_UNVERIFIED');
  if(f.brokerHealth!=='authenticated-pinned')reasons.push('BROKER_HEALTH_NOT_AUTHENTICATED');
  if(f.brokerVersion!=='matched-pinned')reasons.push('BROKER_VERSION_UNTRUSTED');
  if(f.protectedAcl!=='verified-by-independent-observer')reasons.push('PROTECTED_SOURCE_ACL_UNVERIFIED');
  if(f.guardian!=='independently-attested')reasons.push('GUARDIAN_INDEPENDENT_TRUST_MISSING');
  if(f.providerPolicy!=='allowed-independently')reasons.push('PROVIDER_POLICY_UNVERIFIED');
  const state=f.dispatch!=='not-sent'?'MUTATION_STATE_UNKNOWN':
    reasons.length>0?'BLOCKED':'CANDIDATE_ONLY';
  return Object.freeze({
    state,
    reasons:Object.freeze(reasons),
    windowsElevationProvenByPreference:false,
    health401ProvesElevation:false,
    canExecute:false,effectVerified:false,automaticallyRetryable:false,
  });
}
