import { spawn, spawnSync } from 'node:child_process';

export class WindowsDpapiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WindowsDpapiError';
  }
}

const LEGACY_BROKER_ENTROPY = 'Nexowire/privileged-broker/v1';
const PROTECTED_SECRET_PREFIX = 'Nexowire/protected-secret/v1/';

export type WindowsDpapiScope =
  | 'current-user'
  | 'local-machine';

function dpapiScopeExpression(
  scope: WindowsDpapiScope,
): 'CurrentUser' | 'LocalMachine' {
  return scope === 'local-machine'
    ? 'LocalMachine'
    : 'CurrentUser';
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_REQUIRED',
      'Windows DPAPI is available only on Windows.',
    );
  }
}

function validatePurpose(purpose: string): string {
  const normalized = purpose.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_PURPOSE_INVALID',
      'DPAPI purpose must be 1-128 safe identifier characters.',
    );
  }
  return normalized;
}

function strictBase64(value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_INVALID_CIPHERTEXT',
      'DPAPI ciphertext is not valid base64.',
    );
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.length === 0 ||
    decoded.toString('base64') !== normalized
  ) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_INVALID_CIPHERTEXT',
      'DPAPI ciphertext is not canonical base64.',
    );
  }
  return decoded;
}

function powershellScript(
  operation: 'protect' | 'unprotect',
  scope: WindowsDpapiScope = 'current-user',
): string {
  const method =
    operation === 'protect' ? 'Protect' : 'Unprotect';
  const dataProtectionScope =
    dpapiScopeExpression(scope);
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$inputBytes=[Convert]::FromBase64String([string]$payload.input)',
    '$entropy=[Convert]::FromBase64String([string]$payload.entropy)',
    '$scope=[Security.Cryptography.DataProtectionScope]::' +
      dataProtectionScope,
    `$output=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$entropy,$scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($output))',
  ].join('; ');
}

function stdinPayload(value: Buffer, entropy: string): string {
  return JSON.stringify({
    input: value.toString('base64'),
    entropy: Buffer.from(entropy, 'utf8').toString('base64'),
  });
}

function decodeOutput(
  operation: 'protect' | 'unprotect',
  stdout: string,
): Buffer {
  const out = stdout.trim();
  try {
    return strictBase64(out);
  } catch (error) {
    if (
      error instanceof WindowsDpapiError &&
      error.code === 'WINDOWS_DPAPI_INVALID_CIPHERTEXT'
    ) {
      throw new WindowsDpapiError(
        'WINDOWS_DPAPI_INVALID_RESPONSE',
        `Windows DPAPI ${operation} returned invalid base64.`,
      );
    }
    throw error;
  }
}

async function runDpapi(
  operation: 'protect' | 'unprotect',
  value: Buffer,
  entropy: string,
  scope: WindowsDpapiScope = 'current-user',
): Promise<Buffer> {
  assertWindows();

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        powershellScript(operation, scope),
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();

      if (code !== 0) {
        reject(
          new WindowsDpapiError(
            'WINDOWS_DPAPI_FAILED',
            err || `Windows DPAPI ${operation} failed.`,
          ),
        );
        return;
      }

      try {
        resolve(decodeOutput(operation, out));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(stdinPayload(value, entropy), 'utf8');
  });
}

function runDpapiSync(
  operation: 'protect' | 'unprotect',
  value: Buffer,
  entropy: string,
  scope: WindowsDpapiScope = 'current-user',
): Buffer {
  assertWindows();

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      powershellScript(operation, scope),
    ],
    {
      windowsHide: true,
      input: stdinPayload(value, entropy),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_FAILED',
      result.stderr.trim() ||
        `Windows DPAPI ${operation} failed.`,
    );
  }
  return decodeOutput(operation, result.stdout);
}

function entropyForPurpose(purpose: string): string {
  return PROTECTED_SECRET_PREFIX + validatePurpose(purpose);
}

export async function protectWindowsUserSecret(
  plaintext: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    LEGACY_BROKER_ENTROPY,
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsUserSecret(
  ciphertext: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    LEGACY_BROKER_ENTROPY,
  );
  return plaintext.toString('utf8');
}

export async function protectWindowsUserSecretForPurpose(
  plaintext: string,
  purpose: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    entropyForPurpose(purpose),
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsUserSecretForPurpose(
  ciphertext: string,
  purpose: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
  );
  return plaintext.toString('utf8');
}

export function unprotectWindowsUserSecretForPurposeSync(
  ciphertext: string,
  purpose: string,
): string {
  return runDpapiSync(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
  ).toString('utf8');
}

export async function protectWindowsMachineSecretForPurpose(
  plaintext: string,
  purpose: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
    entropyForPurpose(purpose),
    'local-machine',
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsMachineSecretForPurpose(
  ciphertext: string,
  purpose: string,
): Promise<string> {
  const plaintext = await runDpapi(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
    'local-machine',
  );
  return plaintext.toString('utf8');
}

export function unprotectWindowsMachineSecretForPurposeSync(
  ciphertext: string,
  purpose: string,
): string {
  return runDpapiSync(
    'unprotect',
    strictBase64(ciphertext),
    entropyForPurpose(purpose),
    'local-machine',
  ).toString('utf8');
}
