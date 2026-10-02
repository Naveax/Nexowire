import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const TOKEN_PREFIX = 'nwx_pair_';
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 15 * 60_000;

export interface PairingRecord {
  id: string;
  ownerAccountId: string;
  requestedDeviceId: string | null;
  requestedDeviceName: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface PairingChallenge {
  token: string;
  record: PairingRecord;
}

function boundedText(
  name: string,
  value: string,
  max: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(name + ' must be 1-' + max + ' characters.');
  }
  return normalized;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function tokenHashHex(token: string): string {
  return tokenDigest(token).toString('hex');
}

export function createPairingChallenge(
  ownerAccountIdInput: string,
  requestedDeviceNameInput: string,
  options: {
    now?: Date;
    ttlMs?: number;
    requestedDeviceId?: string;
  } = {},
): PairingChallenge {
  const ownerAccountId = boundedText(
    'ownerAccountId',
    ownerAccountIdInput,
    128,
  );
  const requestedDeviceName = boundedText(
    'requestedDeviceName',
    requestedDeviceNameInput,
    128,
  );
  const requestedDeviceId = options.requestedDeviceId
    ? boundedText(
        'requestedDeviceId',
        options.requestedDeviceId,
        128,
      )
    : null;
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < 30_000 ||
    ttlMs > MAX_TTL_MS
  ) {
    throw new Error(
      'pairing ttlMs must be between 30000 and ' +
        MAX_TTL_MS +
        '.',
    );
  }

  const id = randomBytes(16).toString('hex');
  const token =
    TOKEN_PREFIX + randomBytes(32).toString('base64url');

  return {
    token,
    record: {
      id,
      ownerAccountId,
      requestedDeviceId,
      requestedDeviceName,
      tokenHash: tokenHashHex(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      consumedAt: null,
    },
  };
}

export type PairingConsumeFailure =
  | 'already-consumed'
  | 'expired'
  | 'invalid-token';

export type PairingConsumeResult =
  | {
      ok: true;
      record: PairingRecord;
    }
  | {
      ok: false;
      reason: PairingConsumeFailure;
    };

export function consumePairingChallenge(
  record: PairingRecord,
  token: string,
  now = new Date(),
): PairingConsumeResult {
  if (record.consumedAt !== null) {
    return { ok: false, reason: 'already-consumed' };
  }

  if (now.getTime() >= Date.parse(record.expiresAt)) {
    return { ok: false, reason: 'expired' };
  }

  const expected = Buffer.from(record.tokenHash, 'hex');
  const actual = tokenDigest(token);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { ok: false, reason: 'invalid-token' };
  }

  return {
    ok: true,
    record: {
      ...record,
      consumedAt: now.toISOString(),
    },
  };
}
