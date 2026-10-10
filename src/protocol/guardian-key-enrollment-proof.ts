import { createHash, createPublicKey, verify } from 'node:crypto';
import * as z from 'zod';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const binding=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().uuid();
const date=z.string().datetime({offset:true});
const challengeSchema=z.strictObject({
  type:z.literal('guardian.key-enrollment-challenge'),
  version:z.literal(1),
  requestId:uuid,
  deviceId:id,
  ownerAccountId:id,
  credentialBinding:binding,
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  purpose:z.literal('bridge-mode-receipts'),
  issuedAt:date,
  expiresAt:date,
});
export const GuardianKeyEnrollmentProofSchema=z.strictObject({
  type:z.literal('guardian.key-enrollment-proof'),
  version:z.literal(1),
  challenge:challengeSchema,
  publicKeySpki:z.string().min(40).max(1024).regex(/^[A-Za-z0-9_-]+$/),
  signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type GuardianKeyEnrollmentChallenge=z.infer<typeof challengeSchema>;
export type GuardianKeyEnrollmentProof=z.infer<typeof GuardianKeyEnrollmentProofSchema>;

/** Deterministic, domain-separated signing transcript. */
export function guardianKeyEnrollmentSigningBytes(
  raw: Pick<GuardianKeyEnrollmentProof,'challenge'|'publicKeySpki'>,
): Buffer {
  const challenge=challengeSchema.parse(raw.challenge);
  if (typeof raw.publicKeySpki!=='string' ||
      raw.publicKeySpki.length>1024 ||
      !/^[A-Za-z0-9_-]{40,1024}$/.test(raw.publicKeySpki)) {
    throw new Error('GUARDIAN_KEY_PROOF_INVALID_PUBLIC_KEY_ENCODING');
  }
  return Buffer.from(JSON.stringify([
    'nexowire.guardian.key-enrollment.v1',
    challenge.type,challenge.version,challenge.requestId,
    challenge.deviceId,challenge.ownerAccountId,challenge.credentialBinding,
    challenge.nonce,challenge.purpose,challenge.issuedAt,challenge.expiresAt,
    raw.publicKeySpki,
  ]),'utf8');
}
export interface GuardianEnrollmentProofContext {
  readonly deviceId:string;
  readonly ownerAccountId:string;
  readonly currentCredentialBinding:string;
  readonly ownerApprovedRequestId:string;
  readonly now:Date;
  /** A read-only check; the future enrollment store must ALSO atomically consume. */
  readonly hasConsumedChallenge:(requestId:string)=>boolean;
}

/**
 * A proof of possession is NOT trusted enrollment or permission to actuate.
 * Future registration requires an owner-confirmed atomic challenge consume,
 * authenticated paired Guardian transport and validated protected key storage.
 */
export function verifyGuardianKeyEnrollmentProof(
  raw:unknown,ctx:GuardianEnrollmentProofContext,
): {
  readonly possessionVerified:true;
  readonly enrollmentAuthorized:false;
  readonly deviceId:string;
  readonly requestId:string;
  readonly publicKeyFingerprint:string;
} {
  const proof=GuardianKeyEnrollmentProofSchema.parse(raw);
  const c=proof.challenge;
  if (c.deviceId!==ctx.deviceId || c.ownerAccountId!==ctx.ownerAccountId ||
      c.credentialBinding!==ctx.currentCredentialBinding ||
      c.requestId!==ctx.ownerApprovedRequestId) {
    throw new Error('GUARDIAN_KEY_PROOF_CURRENT_OWNER_OR_PAIRING_MISMATCH');
  }
  const now=ctx.now.getTime();
  const issued=Date.parse(c.issuedAt),expiry=Date.parse(c.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(issued) ||
      !Number.isFinite(expiry) ||
      new Date(issued).toISOString()!==c.issuedAt ||
      new Date(expiry).toISOString()!==c.expiresAt ||
      expiry<=issued || expiry-issued>120000 ||
      now<issued-5000 || now>=expiry) {
    throw new Error('GUARDIAN_KEY_PROOF_EXPIRED_OR_INVALID');
  }
  const nonce=Buffer.from(c.nonce,'base64url');
  if (nonce.length!==32 || nonce.toString('base64url')!==c.nonce ||
      nonce.every(byte=>byte===0)) {
    throw new Error('GUARDIAN_KEY_PROOF_INVALID_NONCE');
  }
  if (ctx.hasConsumedChallenge(c.requestId)) {
    throw new Error('GUARDIAN_KEY_PROOF_REPLAY');
  }
  const spki=Buffer.from(proof.publicKeySpki,'base64url');
  if (spki.toString('base64url')!==proof.publicKeySpki ||
      spki.length<40 || spki.length>512) {
    throw new Error('GUARDIAN_KEY_PROOF_NONCANONICAL_SPKI');
  }
  let key;
  try {
    key=createPublicKey({key:spki,format:'der',type:'spki'});
  } catch {
    throw new Error('GUARDIAN_KEY_PROOF_INVALID_ED25519_KEY');
  }
  if (key.type!=='public' || key.asymmetricKeyType!=='ed25519' ||
      !key.export({format:'der',type:'spki'}).equals(spki)) {
    throw new Error('GUARDIAN_KEY_PROOF_INVALID_ED25519_KEY');
  }
  const signatureBytes=Buffer.from(proof.signature,'base64url');
  if (signatureBytes.length!==64 ||
      signatureBytes.toString('base64url')!==proof.signature ||
      !verify(null,guardianKeyEnrollmentSigningBytes(proof),key,signatureBytes)) {
    throw new Error('GUARDIAN_KEY_PROOF_BAD_SIGNATURE');
  }
  return Object.freeze({
    possessionVerified:true as const,
    enrollmentAuthorized:false as const,
    deviceId:c.deviceId,requestId:c.requestId,
    publicKeyFingerprint:createHash('sha256').update(spki).digest('hex'),
  });
}
