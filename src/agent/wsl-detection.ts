import { spawnSync } from 'node:child_process';

export interface WslDetectionResult {
  available: boolean;
  distros: string[];
}

export interface WslDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
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

  const sample = value.subarray(0, Math.min(value.length, 512));
  let nulBytes = 0;
  for (const byte of sample) {
    if (byte === 0) nulBytes++;
  }

  const encoding =
    sample.length > 0 && nulBytes / sample.length >= 0.2
      ? 'utf16le'
      : 'utf8';
  return value.toString(encoding).replaceAll('\u0000', '');
}

function defaultRun(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 5_000,
    maxBuffer: 512 * 1024,
    env,
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

  const result = options.run
    ? options.run('wsl.exe', ['--list', '--quiet'])
    : defaultRun(
        'wsl.exe',
        ['--list', '--quiet'],
        options.env ?? process.env,
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
