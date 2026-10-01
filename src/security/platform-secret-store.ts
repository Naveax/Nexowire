import {
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import * as z from 'zod';

const PurposeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/);

export type PlatformSecretPlatform = 'linux' | 'darwin';

export interface PlatformSecretReference {
  purpose: string;
  name: string;
}

export interface PlatformSecretRunner {
  runSync(
    command: string,
    args: string[],
    options?: {
      input?: string;
      maxBuffer?: number;
    },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };

  run(
    command: string,
    args: string[],
    options?: {
      input?: string;
      maxBuffer?: number;
    },
  ): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }>;
}

export interface PlatformSecretStoreOptions {
  platform?: NodeJS.Platform;
  runner?: PlatformSecretRunner;
}

export class PlatformSecretError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlatformSecretError';
  }
}

function validateReference(
  input: PlatformSecretReference,
): PlatformSecretReference {
  return {
    purpose: PurposeSchema.parse(input.purpose.trim()),
    name: NameSchema.parse(input.name.trim()),
  };
}

function validateSecret(
  value: string,
  options: { allowMultiline?: boolean } = {},
): string {
  if (!value.trim()) {
    throw new PlatformSecretError(
      'PLATFORM_SECRET_EMPTY',
      'Platform-backed secret is empty.',
    );
  }
  if (value.includes('\0')) {
    throw new PlatformSecretError(
      'PLATFORM_SECRET_INVALID',
      'Platform-backed secret contains a NUL byte.',
    );
  }
  if (Buffer.byteLength(value, 'utf8') > 1_048_576) {
    throw new PlatformSecretError(
      'PLATFORM_SECRET_TOO_LARGE',
      'Platform-backed secret exceeds 1 MiB.',
    );
  }
  const normalized = value.trim();
  if (
    options.allowMultiline !== true &&
    /[\r\n]/.test(normalized)
  ) {
    throw new PlatformSecretError(
      'PLATFORM_SECRET_MULTILINE',
      'Platform-backed secret must contain one non-empty line.',
    );
  }
  return normalized;
}

function ensureSupportedPlatform(
  platform: NodeJS.Platform,
): PlatformSecretPlatform {
  if (platform === 'linux' || platform === 'darwin') {
    return platform;
  }
  throw new PlatformSecretError(
    'PLATFORM_SECRET_UNSUPPORTED',
    platform === 'win32'
      ? 'Use Nexowire DPAPI protected secret files on Windows.'
      : 'No first-party platform secret-store adapter exists for this operating system.',
    { platform },
  );
}

function commandFor(
  platform: PlatformSecretPlatform,
): string {
  return platform === 'darwin'
    ? '/usr/bin/security'
    : 'secret-tool';
}

function attributes(
  reference: PlatformSecretReference,
): string[] {
  return [
    'application',
    'nexowire',
    'purpose',
    reference.purpose,
    'name',
    reference.name,
  ];
}

function macService(reference: PlatformSecretReference): string {
  return 'Nexowire/' + reference.purpose;
}

function defaultRunner(): PlatformSecretRunner {
  return {
    runSync(command, args, options = {}) {
      const result: SpawnSyncReturns<string> = spawnSync(
        command,
        args,
        {
          input: options.input,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
        },
      );
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error } : {}),
      };
    },

    async run(command, args, options = {}) {
      return await new Promise((resolve) => {
        const child = spawn(command, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        const maxBuffer =
          options.maxBuffer ?? 2 * 1024 * 1024;
        let overflow = false;
        let launchError: Error | undefined;

        const collect = (
          target: Buffer[],
          chunk: Buffer,
        ): void => {
          bytes += chunk.length;
          if (bytes > maxBuffer) {
            overflow = true;
            child.kill();
            return;
          }
          target.push(chunk);
        };

        child.stdout.on('data', (chunk: Buffer) =>
          collect(stdout, chunk),
        );
        child.stderr.on('data', (chunk: Buffer) =>
          collect(stderr, chunk),
        );
        child.once('error', (error) => {
          launchError = error;
        });
        child.once('close', (status) => {
          resolve({
            status,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            ...(launchError ? { error: launchError } : {}),
            ...(overflow
              ? {
                  error: new Error(
                    'Platform secret command output exceeded the bound.',
                  ),
                }
              : {}),
          });
        });
        child.stdin.end(options.input ?? '', 'utf8');
      });
    },
  };
}

function commandUnavailable(
  error: Error | undefined,
): boolean {
  return (
    error !== undefined &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOENT'
  );
}

function cleanErrorText(value: string): string {
  return value.trim().slice(0, 2_000);
}

function throwCommandFailure(
  platform: PlatformSecretPlatform,
  action: string,
  result: {
    status: number | null;
    stderr: string;
    error?: Error;
  },
): never {
  if (commandUnavailable(result.error)) {
    throw new PlatformSecretError(
      'PLATFORM_SECRET_TOOL_UNAVAILABLE',
      platform === 'linux'
        ? 'Linux Secret Service client "secret-tool" is not installed or not available in PATH.'
        : 'macOS Keychain command is unavailable.',
    );
  }
  throw new PlatformSecretError(
    'PLATFORM_SECRET_COMMAND_FAILED',
    'Platform secret-store ' + action + ' failed.',
    {
      platform,
      status: result.status,
      stderr: cleanErrorText(result.stderr),
      ...(result.error
        ? { error: result.error.message }
        : {}),
    },
  );
}

export class PlatformSecretStore {
  private readonly platform: PlatformSecretPlatform;
  private readonly runner: PlatformSecretRunner;

  constructor(options: PlatformSecretStoreOptions = {}) {
    this.platform = ensureSupportedPlatform(
      options.platform ?? process.platform,
    );
    this.runner = options.runner ?? defaultRunner();
  }

  readSync(
    referenceInput: PlatformSecretReference,
    options: { allowMultiline?: boolean } = {},
  ): string {
    const reference = validateReference(referenceInput);
    const command = commandFor(this.platform);
    const args =
      this.platform === 'darwin'
        ? [
            'find-generic-password',
            '-s',
            macService(reference),
            '-a',
            reference.name,
            '-w',
          ]
        : ['lookup', ...attributes(reference)];

    const result = this.runner.runSync(
      command,
      args,
      { maxBuffer: 2 * 1024 * 1024 },
    );

    if (result.status !== 0) {
      if (
        !result.error &&
        result.status !== null &&
        result.status !== 0 &&
        result.stdout.trim() === ''
      ) {
        throw new PlatformSecretError(
          'PLATFORM_SECRET_NOT_FOUND',
          'Platform-backed secret was not found.',
          {
            platform: this.platform,
            purpose: reference.purpose,
            name: reference.name,
          },
        );
      }
      throwCommandFailure(
        this.platform,
        'lookup',
        result,
      );
    }

    return validateSecret(
      result.stdout,
      options,
    );
  }

  async write(
    referenceInput: PlatformSecretReference,
    secretInput: string,
    options: {
      allowMultiline?: boolean;
      overwrite?: boolean;
    } = {},
  ): Promise<void> {
    const reference = validateReference(referenceInput);
    const secret = validateSecret(
      secretInput,
      options,
    );
    const command = commandFor(this.platform);

    if (
      options.overwrite !== true &&
      this.exists(reference)
    ) {
      throw new PlatformSecretError(
        'PLATFORM_SECRET_EXISTS',
        'Platform-backed secret already exists; explicit overwrite is required.',
        {
          platform: this.platform,
          purpose: reference.purpose,
          name: reference.name,
        },
      );
    }

    const args =
      this.platform === 'darwin'
        ? [
            'add-generic-password',
            ...(options.overwrite === true ? ['-U'] : []),
            '-s',
            macService(reference),
            '-a',
            reference.name,
            '-w',
            secret,
          ]
        : [
            'store',
            '--label=Nexowire ' +
              reference.purpose +
              '/' +
              reference.name,
            ...attributes(reference),
          ];

    const result = await this.runner.run(
      command,
      args,
      {
        input:
          this.platform === 'linux'
            ? secret
            : undefined,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error) {
      throwCommandFailure(
        this.platform,
        'write',
        result,
      );
    }
  }

  async delete(
    referenceInput: PlatformSecretReference,
  ): Promise<boolean> {
    const reference = validateReference(referenceInput);
    const command = commandFor(this.platform);
    const args =
      this.platform === 'darwin'
        ? [
            'delete-generic-password',
            '-s',
            macService(reference),
            '-a',
            reference.name,
          ]
        : ['clear', ...attributes(reference)];

    const result = await this.runner.run(
      command,
      args,
      { maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.status === 0 && !result.error) return true;
    if (
      !result.error &&
      result.status !== null &&
      result.stdout.trim() === ''
    ) {
      return false;
    }
    throwCommandFailure(
      this.platform,
      'delete',
      result,
    );
  }

  exists(
    referenceInput: PlatformSecretReference,
  ): boolean {
    try {
      this.readSync(referenceInput, {
        allowMultiline: true,
      });
      return true;
    } catch (error) {
      if (
        error instanceof PlatformSecretError &&
        error.code === 'PLATFORM_SECRET_NOT_FOUND'
      ) {
        return false;
      }
      throw error;
    }
  }
}

export function readPlatformSecretSync(
  purpose: string,
  name: string,
  options: {
    allowMultiline?: boolean;
    platform?: NodeJS.Platform;
    runner?: PlatformSecretRunner;
  } = {},
): string {
  return new PlatformSecretStore(options).readSync(
    { purpose, name },
    {
      allowMultiline: options.allowMultiline,
    },
  );
}

export function optionalPlatformSecretSync(
  nameInput: string | undefined,
  purpose: string,
  options: {
    allowMultiline?: boolean;
    platform?: NodeJS.Platform;
    runner?: PlatformSecretRunner;
  } = {},
): string | undefined {
  const name = nameInput?.trim();
  return name
    ? readPlatformSecretSync(
        purpose,
        name,
        options,
      )
    : undefined;
}
