import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import {
  protectWindowsUserSecretForPurpose,
  unprotectWindowsUserSecretForPurposeSync,
} from './windows-dpapi.js';
import {
  readSecretFile,
  SecretFileError,
} from './secret-files.js';

const PurposeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const EnvelopeSchema = z.object({
  version: z.literal(1),
  protection: z.literal('windows-dpapi-current-user'),
  purpose: PurposeSchema,
  ciphertext: z.string().min(4).max(2_000_000),
});

export interface ProtectedSecretMetadata {
  version: 1;
  protection: 'windows-dpapi-current-user';
  purpose: string;
  file: string;
}

function validatePlaintext(
  value: string,
  label: string,
  allowMultiline: boolean,
): string {
  if (!value.trim()) {
    throw new SecretFileError(
      'SECRET_FILE_EMPTY',
      label + ' protected secret is empty.',
    );
  }
  if (value.includes('\0')) {
    throw new SecretFileError(
      'SECRET_FILE_INVALID',
      label + ' protected secret contains a NUL byte.',
    );
  }
  if (
    Buffer.byteLength(value, 'utf8') > 1_048_576
  ) {
    throw new SecretFileError(
      'SECRET_FILE_TOO_LARGE',
      label + ' protected secret exceeds 1 MiB.',
    );
  }
  if (!allowMultiline && /[\r\n]/.test(value.trim())) {
    throw new SecretFileError(
      'SECRET_FILE_MULTILINE',
      label + ' protected secret must contain one non-empty line.',
    );
  }
  return value.trim();
}

export function readProtectedSecretFile(
  fileInput: string,
  purposeInput: string,
  label: string,
  options: { allowMultiline?: boolean } = {},
): string {
  const purpose = PurposeSchema.parse(purposeInput);
  const raw = readSecretFile(
    fileInput,
    label + ' protected envelope',
    {
      maxBytes: 2_000_000,
      allowMultiline: true,
    },
  );

  let envelope: z.infer<typeof EnvelopeSchema>;
  try {
    envelope = EnvelopeSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new SecretFileError(
      'PROTECTED_SECRET_INVALID',
      label + ' protected secret envelope is invalid.',
      {
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (envelope.purpose !== purpose) {
    throw new SecretFileError(
      'PROTECTED_SECRET_PURPOSE_MISMATCH',
      label + ' protected secret was sealed for a different purpose.',
      {
        expectedPurpose: purpose,
        actualPurpose: envelope.purpose,
      },
    );
  }

  let plaintext: string;
  try {
    plaintext = unprotectWindowsUserSecretForPurposeSync(
      envelope.ciphertext,
      purpose,
    );
  } catch (error) {
    throw new SecretFileError(
      'PROTECTED_SECRET_UNPROTECT_FAILED',
      label + ' protected secret could not be unprotected for this Windows user.',
      {
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }

  return validatePlaintext(
    plaintext,
    label,
    options.allowMultiline === true,
  );
}

export function readProtectedSecretListFile(
  fileInput: string,
  purpose: string,
  label: string,
): string {
  return readProtectedSecretFile(
    fileInput,
    purpose,
    label,
    { allowMultiline: true },
  )
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
}

export function optionalProtectedSecretFile(
  fileInput: string | undefined,
  purpose: string,
  label: string,
): string | undefined {
  const file = fileInput?.trim();
  return file
    ? readProtectedSecretFile(file, purpose, label)
    : undefined;
}

export function optionalProtectedSecretListFile(
  fileInput: string | undefined,
  purpose: string,
  label: string,
): string | undefined {
  const file = fileInput?.trim();
  return file
    ? readProtectedSecretListFile(file, purpose, label)
    : undefined;
}

export function resolveProtectedSingleSecret(
  inlineValue: string | undefined,
  plainFile: string | undefined,
  protectedFile: string | undefined,
  purpose: string,
  label: string,
): string | undefined {
  const inline = inlineValue?.trim() || undefined;
  const plain = plainFile?.trim()
    ? readSecretFile(plainFile, label)
    : undefined;
  const protectedValue = optionalProtectedSecretFile(
    protectedFile,
    purpose,
    label,
  );

  const values = [inline, plain, protectedValue].filter(
    (value): value is string => value !== undefined,
  );
  if (
    values.length > 1 &&
    values.some((value) => value !== values[0])
  ) {
    throw new SecretFileError(
      'SECRET_SOURCE_CONFLICT',
      label +
        ' is configured through multiple secret sources with different contents.',
    );
  }
  return values[0];
}

export async function writeProtectedSecretFile(
  fileInput: string,
  purposeInput: string,
  plaintextInput: string,
  options: {
    allowMultiline?: boolean;
    overwrite?: boolean;
  } = {},
): Promise<ProtectedSecretMetadata> {
  const purpose = PurposeSchema.parse(purposeInput);
  const plaintext = validatePlaintext(
    plaintextInput,
    purpose,
    options.allowMultiline === true,
  );
  const file = path.resolve(fileInput);
  await fs.mkdir(path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });

  if (options.overwrite !== true) {
    try {
      await fs.access(file);
      throw new SecretFileError(
        'PROTECTED_SECRET_EXISTS',
        'Protected secret file already exists; explicit overwrite is required.',
        { file },
      );
    } catch (error) {
      if (
        error instanceof SecretFileError
      ) {
        throw error;
      }
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }

  const ciphertext =
    await protectWindowsUserSecretForPurpose(
      plaintext,
      purpose,
    );
  const envelope = EnvelopeSchema.parse({
    version: 1,
    protection: 'windows-dpapi-current-user',
    purpose,
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
    JSON.stringify(envelope, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.rename(temp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows secrecy comes from DPAPI; ACL hardening remains best effort.
  }

  return {
    version: 1,
    protection: 'windows-dpapi-current-user',
    purpose,
    file,
  };
}

export function inspectProtectedSecretFile(
  fileInput: string,
): ProtectedSecretMetadata {
  const file = path.resolve(fileInput);
  const raw = readSecretFile(
    file,
    'protected secret envelope',
    {
      maxBytes: 2_000_000,
      allowMultiline: true,
    },
  );
  let envelope: z.infer<typeof EnvelopeSchema>;
  try {
    envelope = EnvelopeSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new SecretFileError(
      'PROTECTED_SECRET_INVALID',
      'Protected secret envelope is invalid.',
      {
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }
  return {
    version: envelope.version,
    protection: envelope.protection,
    purpose: envelope.purpose,
    file,
  };
}
