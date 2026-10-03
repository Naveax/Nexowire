import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import type {
  D1DatabaseLike,
} from './d1-control-plane-store.js';

const AAD = Buffer.from(
  'nexowire-control-plane-runtime-config-v1',
  'utf8',
);

interface EnvelopeV1 {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

function keyBytes(input: string): Buffer {
  const raw = input.trim();
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64url');
  } catch {
    throw new Error(
      'NEXOWIRE_CONFIG_ENCRYPTION_KEY must be base64url.',
    );
  }
  if (key.length !== 32) {
    throw new Error(
      'NEXOWIRE_CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes.',
    );
  }
  return key;
}

export function encryptRuntimeConfig(
  value: unknown,
  encryptionKey: string,
): string {
  const key = keyBytes(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    key,
    iv,
  );
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(
    JSON.stringify(value),
    'utf8',
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const envelope: EnvelopeV1 = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  return JSON.stringify(envelope);
}

export function decryptRuntimeConfig<T>(
  encrypted: string,
  encryptionKey: string,
): T {
  const key = keyBytes(encryptionKey);
  let envelope: EnvelopeV1;
  try {
    envelope = JSON.parse(encrypted) as EnvelopeV1;
  } catch {
    throw new Error(
      'Encrypted runtime config envelope is invalid.',
    );
  }
  if (
    envelope?.version !== 1 ||
    envelope.algorithm !== 'aes-256-gcm' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error(
      'Encrypted runtime config envelope is invalid.',
    );
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(
    Buffer.from(envelope.tag, 'base64url'),
  );
  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(envelope.ciphertext, 'base64url'),
    ),
    decipher.final(),
  ]);
  return JSON.parse(
    plaintext.toString('utf8'),
  ) as T;
}

export class D1EncryptedRuntimeConfigStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        'SELECT encrypted_value FROM control_plane_runtime_config WHERE key = ?',
      )
      .bind(key)
      .first<{ encrypted_value: string }>();
    return row?.encrypted_value ?? null;
  }

  async put(
    key: string,
    encryptedValue: string,
    updatedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO control_plane_runtime_config
          (key, encrypted_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           encrypted_value = excluded.encrypted_value,
           updated_at = excluded.updated_at`,
      )
      .bind(key, encryptedValue, updatedAt)
      .run();
  }
}
