import {
  createHash,
  randomBytes,
} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../security/protected-secret-files.js';
import { SecretFileError } from '../security/secret-files.js';

const DEVICE_ANCHOR_PURPOSE = 'device-anchor-v1';

export interface DeviceAnchorIdentity {
  anchorHash: string;
  storageFile: string;
  protection: 'windows-dpapi-current-user';
}

export function deriveDeviceAnchorHash(secret: string): string {
  const value = secret.trim();
  if (!value) {
    throw new Error('Device anchor secret is empty.');
  }
  return createHash('sha256')
    .update('nexowire-device-anchor-v1\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function defaultDeviceAnchorFile(
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(
    env.NEXOWIRE_DEVICE_ANCHOR_DPAPI_FILE?.trim() ||
      path.join(
        os.homedir(),
        '.nexowire',
        'secrets',
        'device-anchor.dpapi.json',
      ),
  );
}

function readAnchor(file: string): string {
  return readProtectedSecretFile(
    file,
    DEVICE_ANCHOR_PURPOSE,
    'device anchor',
  );
}

export async function getOrCreateDeviceAnchor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceAnchorIdentity> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Device anchor secure storage currently requires Windows DPAPI.',
    );
  }

  const file = defaultDeviceAnchorFile(env);
  let secret: string;

  try {
    secret = readAnchor(file);
  } catch (error) {
    if (
      !(error instanceof SecretFileError) ||
      error.code !== 'SECRET_FILE_UNAVAILABLE'
    ) {
      throw error;
    }

    const generated = randomBytes(32).toString('base64url');
    try {
      await writeProtectedSecretFile(
        file,
        DEVICE_ANCHOR_PURPOSE,
        generated,
      );
      secret = generated;
    } catch (writeError) {
      if (
        writeError instanceof SecretFileError &&
        writeError.code === 'PROTECTED_SECRET_EXISTS'
      ) {
        secret = readAnchor(file);
      } else {
        throw writeError;
      }
    }
  }

  return {
    anchorHash: deriveDeviceAnchorHash(secret),
    storageFile: file,
    protection: 'windows-dpapi-current-user',
  };
}
