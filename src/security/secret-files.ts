import { readFileSync, statSync } from 'node:fs';
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

  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    throw new SecretFileError(
      'SECRET_FILE_UNAVAILABLE',
      label + ' secret file could not be read.',
      {
        path: path.resolve(file),
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (!stat.isFile()) {
    throw new SecretFileError(
      'SECRET_FILE_NOT_FILE',
      label + ' secret path is not a regular file.',
      { path: path.resolve(file) },
    );
  }
  if (stat.size > maxBytes) {
    throw new SecretFileError(
      'SECRET_FILE_TOO_LARGE',
      label + ' secret file exceeds the configured byte bound.',
      {
        path: path.resolve(file),
        bytes: stat.size,
        maxBytes,
      },
    );
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new SecretFileError(
      'SECRET_FILE_UNAVAILABLE',
      label + ' secret file could not be read.',
      {
        path: path.resolve(file),
        cause:
          error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (raw.includes('\0')) {
    throw new SecretFileError(
      'SECRET_FILE_INVALID',
      label + ' secret file contains a NUL byte.',
      { path: path.resolve(file) },
    );
  }

  const value = raw.trim();
  if (!value) {
    throw new SecretFileError(
      'SECRET_FILE_EMPTY',
      label + ' secret file is empty.',
      { path: path.resolve(file) },
    );
  }

  if (
    options.allowMultiline !== true &&
    /[\r\n]/.test(value)
  ) {
    throw new SecretFileError(
      'SECRET_FILE_MULTILINE',
      label + ' secret file must contain exactly one non-empty line.',
      { path: path.resolve(file) },
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
