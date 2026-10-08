import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  protectWindowsUserSecret,
  unprotectWindowsUserSecret,
} from './windows-dpapi.js';

const SecretFileSchema = z.object({
  version: z.literal(1),
  protection: z.literal('windows-dpapi-current-user'),
  ciphertext: z.string().min(1),
});

export interface PrivilegedBrokerSecretOptions {
  file?: string;
}

export function defaultPrivilegedBrokerSecretFile(): string {
  return path.join(
    os.homedir(),
    '.nexowire',
    'secrets',
    'privileged-broker-token.dpapi.json',
  );
}

async function readSecret(file: string): Promise<string> {
  const parsed = SecretFileSchema.parse(
    JSON.parse(await fs.readFile(file, 'utf8')),
  );
  return await unprotectWindowsUserSecret(parsed.ciphertext);
}

async function acquireLock(lockFile: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fs.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    'Timed out waiting for privileged-broker secret lock.',
  );
}

/** Read-only: never creates a token or changes the protected secret file. */
export async function readExistingPrivilegedBrokerToken(
  options: PrivilegedBrokerSecretOptions = {},
): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Protected broker token inspection requires Windows DPAPI.');
  }
  return await readSecret(options.file ?? defaultPrivilegedBrokerSecretFile());
}

export async function loadOrCreatePrivilegedBrokerToken(
  options: PrivilegedBrokerSecretOptions = {},
): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Automatic privileged-broker secret storage currently requires Windows DPAPI.',
    );
  }

  const file =
    options.file ?? defaultPrivilegedBrokerSecretFile();
  await fs.mkdir(path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });

  try {
    return await readSecret(file);
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    ) {
      throw error;
    }
  }

  const lockFile = file + '.lock';
  const lock = await acquireLock(lockFile);
  try {
    try {
      return await readSecret(file);
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw error;
      }
    }

    const token =
      'nwxpb1.' + randomBytes(32).toString('base64url');
    const ciphertext = await protectWindowsUserSecret(token);
    const payload = SecretFileSchema.parse({
      version: 1,
      protection: 'windows-dpapi-current-user',
      ciphertext,
    });
    const temp =
      file +
      '.tmp-' +
      process.pid +
      '-' +
      randomBytes(4).toString('hex');
    await fs.writeFile(
      temp,
      JSON.stringify(payload, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(temp, file);
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // Windows secrecy is provided by DPAPI; ACL hardening is best effort.
    }
    return token;
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
