import { spawn } from 'node:child_process';

export class WindowsDpapiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WindowsDpapiError';
  }
}

const ENTROPY = 'Nexowire/privileged-broker/v1';

async function runDpapi(
  operation: 'protect' | 'unprotect',
  value: Buffer,
): Promise<Buffer> {
  if (process.platform !== 'win32') {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_REQUIRED',
      'Windows DPAPI is available only on Windows.',
    );
  }

  const method =
    operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    "$inputBytes=[Convert]::FromBase64String($env:NEXOWIRE_DPAPI_INPUT)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes($env:NEXOWIRE_DPAPI_ENTROPY)",
    '$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser',
    `$output=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$entropy,$scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($output))',
  ].join('; ');

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_DPAPI_INPUT: value.toString('base64'),
          NEXOWIRE_DPAPI_ENTROPY: ENTROPY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
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
        resolve(Buffer.from(out, 'base64'));
      } catch {
        reject(
          new WindowsDpapiError(
            'WINDOWS_DPAPI_INVALID_RESPONSE',
            'Windows DPAPI returned invalid base64.',
          ),
        );
      }
    });
  });
}

export async function protectWindowsUserSecret(
  plaintext: string,
): Promise<string> {
  const protectedBytes = await runDpapi(
    'protect',
    Buffer.from(plaintext, 'utf8'),
  );
  return protectedBytes.toString('base64');
}

export async function unprotectWindowsUserSecret(
  ciphertext: string,
): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new WindowsDpapiError(
      'WINDOWS_DPAPI_INVALID_CIPHERTEXT',
      'DPAPI ciphertext is not valid base64.',
    );
  }
  const plaintext = await runDpapi('unprotect', bytes);
  return plaintext.toString('utf8');
}
