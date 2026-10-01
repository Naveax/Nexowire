import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

export class SecretFileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SecretFileError';
  }
}

export interface SecretFileOptions {
  maxBytes?: number;
  allowMultiline?: boolean;
}

export function readSecretFile(
  fileInput: string,
  label: string,
  options: SecretFileOptions = {},
): string {
  const file = fileInput.trim();
  if (!file) {
    throw new SecretFileError(
      'SECRET_FILE_PATH_EMPTY',
      label + ' secret-file path is empty.',
    );
  }
  if (file.length > 4096) {
    throw new SecretFileError(
      'SECRET_FILE_PATH_TOO_LONG',
      label + ' secret-file path is too long.',
    );
  }

  const maxBytes = Math.min(
    1_048_576,
    Math.max(1, options.maxBytes ?? 65_536),
  );

  let resolved: string;
  try {
    resolved = realpathSync(file);
  } catch (error) {
    throw new SecretFileError(
      'SECRET_FILE_UNAVAILABLE',
      label + ' secret file could not be resolved.',
      {
        path: path.resolve(file),
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }

  let descriptor: number | undefined;
  let raw: string;
  try {
    const noFollow =
      process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(
      resolved,
      constants.O_RDONLY | noFollow,
    );
    const stat = fstatSync(descriptor);

    if (!stat.isFile()) {
      throw new SecretFileError(
        'SECRET_FILE_NOT_FILE',
        label + ' secret path is not a regular file.',
        { path: resolved },
      );
    }
    if (stat.size > maxBytes) {
      throw new SecretFileError(
        'SECRET_FILE_TOO_LARGE',
        label + ' secret file exceeds the configured byte bound.',
        {
          path: resolved,
          bytes: stat.size,
          maxBytes,
        },
      );
    }

    raw = readFileSync(descriptor, {
      encoding: 'utf8',
    });
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError(
      'SECRET_FILE_UNAVAILABLE',
      label + ' secret file could not be read safely.',
      {
        path: resolved,
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort; descriptor is no longer used.
      }
    }
  }

  if (raw.includes('\0')) {
    throw new SecretFileError(
      'SECRET_FILE_INVALID',
      label + ' secret file contains a NUL byte.',
      { path: resolved },
    );
  }

  const value = raw.trim();
  if (!value) {
    throw new SecretFileError(
      'SECRET_FILE_EMPTY',
      label + ' secret file is empty.',
      { path: resolved },
    );
  }

  if (
    options.allowMultiline !== true &&
    /[\r\n]/.test(value)
  ) {
    throw new SecretFileError(
      'SECRET_FILE_MULTILINE',
      label + ' secret file must contain exactly one non-empty line.',
      { path: resolved },
    );
  }

  return value;
}

export function readSecretListFile(
  fileInput: string,
  label: string,
  options: Omit<SecretFileOptions, 'allowMultiline'> = {},
): string {
  return readSecretFile(fileInput, label, {
    ...options,
    allowMultiline: true,
  })
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
}

export function optionalSecretFile(
  fileInput: string | undefined,
  label: string,
  options: SecretFileOptions = {},
): string | undefined {
  const file = fileInput?.trim();
  return file ? readSecretFile(file, label, options) : undefined;
}

export function optionalSecretListFile(
  fileInput: string | undefined,
  label: string,
  options: Omit<SecretFileOptions, 'allowMultiline'> = {},
): string | undefined {
  const file = fileInput?.trim();
  return file
    ? readSecretListFile(file, label, options)
    : undefined;
}

export function resolveSingleSecret(
  inlineValue: string | undefined,
  fileInput: string | undefined,
  label: string,
): string | undefined {
  const inline = inlineValue?.trim() || undefined;
  const fromFile = optionalSecretFile(fileInput, label);

  if (inline && fromFile && inline !== fromFile) {
    throw new SecretFileError(
      'SECRET_SOURCE_CONFLICT',
      label +
        ' is configured through both an inline value and a secret file with different contents.',
    );
  }

  return inline ?? fromFile;
}
