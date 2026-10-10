import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import * as z from 'zod';
import {
  AdminBridgeModeIntentSchema,
  AdminBridgeModeReceiptSchema,
  verifyAdminBridgeModeReceipt,
  type AdminBridgeModeIntent,
} from './admin-bridge-intent.js';

const revision = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const GuardianReceiptToSignSchema = z.strictObject({
  type: z.literal('guardian.signed-bridge-receipt'),
  version: z.literal(1),
  intent: AdminBridgeModeIntentSchema,
  preferenceRevision: revision,
  receipt: AdminBridgeModeReceiptSchema,
  keyId: digest,
});
export const GuardianSignedReceiptSchema = GuardianReceiptToSignSchema.extend({
  signature,
});
export type GuardianReceiptToSign = z.infer<typeof GuardianReceiptToSignSchema>;
export type GuardianSignedReceipt = z.infer<typeof GuardianSignedReceiptSchema>;

/** Key ID is a fingerprint, not evidence that a key belongs to a device. */
export function guardianPublicKeyId(publicKey: KeyObject): string {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('GUARDIAN_RECEIPT_UNTRUSTED_PUBLIC_KEY_TYPE');
  }
  return createHash('sha256').update(
    publicKey.export({type:'spki',format:'der'}),
  ).digest('hex');
}

/**
 * Domain-separated, deterministic transcript with fixed field order.
 * Never sign an unvalidated object or its arbitrary property enumeration.
 */
export function guardianReceiptSigningBytes(raw: GuardianReceiptToSign): Buffer {
  const msg = GuardianReceiptToSignSchema.parse(raw);
  const i = msg.intent;
  const r = msg.receipt;
  const fields = [
    'nexowire.guardian.signed-bridge-receipt.v1',
    msg.type,msg.version,
    i.type,i.version,i.requestId,i.deviceId,i.ownerAccountId,
    i.credentialBinding,i.desiredMode,i.issuedAt,i.expiresAt,
    msg.preferenceRevision,
    r.type,r.version,r.requestId,r.deviceId,r.credentialBinding,
    r.desiredMode,r.observedAt,r.result,r.taskState,r.taskVerified,
    r.brokerHealth,r.failureCode,
    msg.keyId,
  ];
  return Buffer.from(JSON.stringify(fields),'utf8');
}

/**
 * TEST/LOCAL-GUARDIAN ONLY. The private key must remain in a protected local
 * OS keystore. A signature does not independently prove a task/health claim.
 */
export function signGuardianModeReceipt(
  raw: GuardianReceiptToSign,
  privateKey: KeyObject,
): GuardianSignedReceipt {
  if (privateKey.type !== 'private' ||
      privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('GUARDIAN_RECEIPT_UNTRUSTED_PRIVATE_KEY_TYPE');
  }
  const payload=GuardianReceiptToSignSchema.parse(raw);
  return {
    ...payload,
    signature:sign(null,guardianReceiptSigningBytes(payload),privateKey)
      .toString('base64url'),
  };
}

/**
 * Never accept a caller-supplied public key. The trusted context must bind
 * the current Guardian key to the paired device and revoke old keys.
 */
export function verifyGuardianSignedModeReceipt(
  raw: unknown,
  context: {
    readonly expectedIntent: AdminBridgeModeIntent;
    readonly currentPreferenceRevision: string;
    readonly registeredDevicePublicKey: KeyObject;
    readonly now: Date;
  },
): { readonly verifiedSignature: true; readonly applied: boolean;
  readonly requestId: string; readonly keyId: string } {
  const envelope=GuardianSignedReceiptSchema.parse(raw);
  const expected=AdminBridgeModeIntentSchema.parse(context.expectedIntent);
  const {signature:encodedSignature,...signedPayload}=envelope;
  if (context.currentPreferenceRevision !== envelope.preferenceRevision ||
      !revision.safeParse(context.currentPreferenceRevision).success ||
      guardianReceiptSigningBytes({
        ...signedPayload,
        intent:expected,
      }).toString('utf8') !== guardianReceiptSigningBytes(signedPayload).toString('utf8')) {
    throw new Error('GUARDIAN_RECEIPT_CURRENT_INTENT_OR_REVISION_MISMATCH');
  }
  const time=context.now.getTime();
  const issued=Date.parse(expected.issuedAt);
  const expires=Date.parse(expected.expiresAt);
  if (!Number.isFinite(time) || time < issued-5000 || time>=expires) {
    throw new Error('GUARDIAN_RECEIPT_EXPIRED');
  }
  const expectedKeyId=guardianPublicKeyId(context.registeredDevicePublicKey);
  if (envelope.keyId!==expectedKeyId) {
    throw new Error('GUARDIAN_RECEIPT_UNREGISTERED_KEY');
  }
  const bytes=Buffer.from(encodedSignature,'base64url');
  if (bytes.length!==64 || bytes.toString('base64url')!==encodedSignature ||
      !verify(null,guardianReceiptSigningBytes(signedPayload),
        context.registeredDevicePublicKey,bytes)) {
    throw new Error('GUARDIAN_RECEIPT_BAD_SIGNATURE');
  }
  const assessment=verifyAdminBridgeModeReceipt(
    envelope.receipt,envelope.intent,
  );
  return {
    verifiedSignature:true,applied:assessment.applied,
    requestId:envelope.intent.requestId,keyId:envelope.keyId,
  };
}
