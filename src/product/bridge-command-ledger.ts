import type { BridgeQueuedCommand } from './control-plane-store.js';

const boundedId = /^[a-zA-Z0-9._:-]{1,128}$/;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Canonical millisecond UTC timestamps permit atomic SQLite text comparisons. */
export function isCanonicalBridgeTimestamp(input: string): boolean {
  if (typeof input !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    return false;
  }
  const ms = Date.parse(input);
  return Number.isFinite(ms) && new Date(ms).toISOString() === input;
}

export function isValidBridgeQueuedCommand(record: BridgeQueuedCommand): boolean {
  if (!record || !uuid.test(record.requestId) ||
      !boundedId.test(record.deviceId) ||
      !boundedId.test(record.ownerAccountId) ||
      !sha256.test(record.credentialBinding) ||
      !['auto','on','off'].includes(record.desiredMode) ||
      !isCanonicalBridgeTimestamp(record.issuedAt) ||
      !isCanonicalBridgeTimestamp(record.expiresAt)) return false;
  const lifetime = Date.parse(record.expiresAt) - Date.parse(record.issuedAt);
  return lifetime > 0 && lifetime <= 120_000;
}

export function validBridgeTransitionTime(
  at: string, issuedAt: string, expiresAt: string,
): boolean {
  if (!isCanonicalBridgeTimestamp(at)) return false;
  const time = Date.parse(at);
  return time >= Date.parse(issuedAt) && time < Date.parse(expiresAt);
}
