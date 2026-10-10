import * as z from 'zod';

const id = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utcDateTime = z.string().datetime({offset: true});

export const AdminBridgeModeIntentSchema = z.strictObject({
  type: z.literal('admin-bridge.mode-intent'),
  version: z.literal(1),
  requestId: z.string().uuid(),
  deviceId: id,
  ownerAccountId: id,
  credentialBinding: digest,
  desiredMode: z.enum(['auto', 'on', 'off']),
  issuedAt: utcDateTime,
  expiresAt: utcDateTime,
});

export type AdminBridgeModeIntent = z.infer<typeof AdminBridgeModeIntentSchema>;

export const AdminBridgeModeReceiptSchema = z.strictObject({
  type: z.literal('admin-bridge.mode-receipt'),
  version: z.literal(1),
  requestId: z.string().uuid(),
  deviceId: id,
  credentialBinding: digest,
  desiredMode: z.enum(['auto', 'on', 'off']),
  observedAt: utcDateTime,
  result: z.enum(['applied', 'failed']),
  taskState: z.enum(['Running', 'Ready', 'Disabled', 'Unknown']),
  taskVerified: z.boolean(),
  brokerHealth: z.enum(['authenticated-ready', 'absent', 'unverified']),
  failureCode: z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(),
});

export type AdminBridgeModeReceipt = z.infer<typeof AdminBridgeModeReceiptSchema>;

export interface AdminBridgeIntentContext {
  deviceId: string;
  ownerAccountId: string;
  /** Fresh credential digest from the authoritative current pairing. */
  credentialBinding: string;
  now: Date;
  /** Must come from an atomic durable replay register, not in-memory alone. */
  hasConsumedRequestId: (requestId: string) => boolean;
}

const MAX_INTENT_LIFETIME_MS = 120_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export function validateAdminBridgeModeIntent(
  raw: unknown,
  context: AdminBridgeIntentContext,
): AdminBridgeModeIntent {
  const intent = AdminBridgeModeIntentSchema.parse(raw);
  if (
    intent.deviceId !== context.deviceId ||
    intent.ownerAccountId !== context.ownerAccountId ||
    intent.credentialBinding !== context.credentialBinding
  ) {
    throw new Error('BRIDGE_INTENT_IDENTITY_MISMATCH');
  }
  const issued = Date.parse(intent.issuedAt);
  const expiry = Date.parse(intent.expiresAt);
  const now = context.now.getTime();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expiry) ||
    expiry <= issued ||
    expiry - issued > MAX_INTENT_LIFETIME_MS ||
    issued > now + MAX_CLOCK_SKEW_MS ||
    now >= expiry
  ) {
    throw new Error('BRIDGE_INTENT_EXPIRED_OR_INVALID');
  }
  if (context.hasConsumedRequestId(intent.requestId)) {
    throw new Error('BRIDGE_INTENT_REPLAY');
  }
  return intent;
}

/**
 * A task-control acknowledgement is not evidence until it proves the
 * matching process/health postcondition. Transport authentication, durable
 * replay reservation and caller authorization remain separately mandatory.
 */
export function verifyAdminBridgeModeReceipt(
  raw: unknown,
  intent: AdminBridgeModeIntent,
): { receipt: AdminBridgeModeReceipt; applied: boolean } {
  const receipt = AdminBridgeModeReceiptSchema.parse(raw);
  if (
    receipt.requestId !== intent.requestId ||
    receipt.deviceId !== intent.deviceId ||
    receipt.credentialBinding !== intent.credentialBinding ||
    receipt.desiredMode !== intent.desiredMode
  ) {
    throw new Error('BRIDGE_RECEIPT_IDENTITY_MISMATCH');
  }
  const observed = Date.parse(receipt.observedAt);
  if (
    !Number.isFinite(observed) ||
    observed < Date.parse(intent.issuedAt) - MAX_CLOCK_SKEW_MS ||
    observed > Date.parse(intent.expiresAt) + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('BRIDGE_RECEIPT_STALE');
  }
  if (receipt.result === 'failed') {
    if (!receipt.failureCode) throw new Error('BRIDGE_RECEIPT_FAILURE_CODE_REQUIRED');
    return { receipt, applied: false };
  }
  if (receipt.failureCode !== null || !receipt.taskVerified) {
    throw new Error('BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION');
  }
  const valid = intent.desiredMode === 'off'
    ? receipt.taskState === 'Disabled' && receipt.brokerHealth === 'absent'
    : receipt.taskState === 'Running' && receipt.brokerHealth === 'authenticated-ready';
  if (!valid) throw new Error('BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION');
  return { receipt, applied: true };
}
