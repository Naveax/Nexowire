import { spawnSync } from 'node:child_process';

export interface WslDetectionResult {
  available: boolean;
  distros: string[];
}

export interface WslDetectionOptions {
  platform?: NodeJS.Platform;
  run?: (
    command: string,
    args: string[],
  ) => {
    status: number | null;
    stdout: string | Buffer;
    stderr?: string | Buffer;
    error?: Error;
  };
}

function decodeWslOutput(value: string | Buffer): string {
  if (typeof value === 'string') {
    return value.replaceAll('\u0000', '');
  }

  const utf16 = value.toString('utf16le').replaceAll('\u0000', '');
  if (/[
]/.test(utf16) || /^[\x20-\x7e\u0080-\uffff]*$/u.test(utf16)) {
    return utf16;
  }
  return value.toString('utf8').replaceAll('\u0000', '');
}

function defaultRun(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 5_000,
    maxBuffer: 512 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    ...(result.error ? { error: result.error } : {}),
  };
}

export function detectWsl(
  options: WslDetectionOptions = {},
): WslDetectionResult {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { available: false, distros: [] };
  }

  const result = (options.run ?? defaultRun)(
    'wsl.exe',
    ['--list', '--quiet'],
  );
  if (result.status !== 0 || result.error) {
    return { available: false, distros: [] };
  }

  const distros = decodeWslOutput(result.stdout)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    available: distros.length > 0,
    distros: [...new Set(distros)],
  };
}
