import { spawn } from 'node:child_process';
import * as z from 'zod';

function validEnvironmentName(name: string): boolean {
  return !name.includes('\u0000') && !name.includes('=');
}

const ScopeSchema = z.enum(['process', 'user', 'machine']);

const EnvironmentListInputSchema = z.object({
  scope: ScopeSchema.default('process'),
  prefix: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(2048).default(512),
});

const EnvironmentReadInputSchema = z.object({
  scope: ScopeSchema.default('process'),
  names: z
    .array(
      z.string().min(1).max(1024).refine(validEnvironmentName, {
        message: 'Environment variable names cannot contain NUL or equals.',
      }),
    )
    .min(1)
    .max(64),
  reveal_sensitive: z.boolean().default(false),
});

const EnvironmentSetInputSchema = z.object({
  scope: ScopeSchema.default('process'),
  name: z.string().min(1).max(1024).refine(validEnvironmentName, {
    message: 'Environment variable names cannot contain NUL or equals.',
  }),
  value: z.string().max(32_767),
});

const EnvironmentDeleteInputSchema = z.object({
  scope: ScopeSchema.default('process'),
  name: z.string().min(1).max(1024).refine(validEnvironmentName, {
    message: 'Environment variable names cannot contain NUL or equals.',
  }),
});

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      'Windows environment capabilities require a Windows native agent.',
    );
  }
}

const SENSITIVE_NAME_RE =
  /(?:password|passwd|secret|token|api[_-]?key|credential|authorization|auth[_-]?key|cookie|session[_-]?(?:id|key|token)|private[_-]?key|access[_-]?key|client[_-]?secret)/i;

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_RE.test(name);
}

function processKey(name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(process.env).find((key) => key.toLowerCase() === lower);
}

function redactValue(
  name: string,
  value: string | null | undefined,
  revealSensitive: boolean,
) {
  const sensitive = isSensitiveName(name);
  const exists = value !== undefined && value !== null;
  return {
    name,
    exists,
    sensitive,
    redacted: exists && sensitive && !revealSensitive,
    value:
      !exists
        ? null
        : sensitive && !revealSensitive
          ? '<redacted>'
          : value,
  };
}

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) {
        reject(
          new Error(
            'PowerShell environment operation timed out after ' +
              timeoutMs +
              'ms.',
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        reject(
          new Error(
            err ||
              out ||
              'PowerShell exited with code ' +
                (exitCode ?? 'unknown') +
                '.',
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new Error(
            'PowerShell environment operation returned invalid JSON.',
          ),
        );
      }
    });
  });
}

const listScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$target = if ([string]$inputData.scope -eq 'user') {
  [EnvironmentVariableTarget]::User
} else {
  [EnvironmentVariableTarget]::Machine
}
$names = @(
  [Environment]::GetEnvironmentVariables($target).Keys |
    ForEach-Object { [string]$_ }
)
[pscustomobject]@{ names = $names } |
  ConvertTo-Json -Depth 4 -Compress
`;

const readScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$target = if ([string]$inputData.scope -eq 'user') {
  [EnvironmentVariableTarget]::User
} else {
  [EnvironmentVariableTarget]::Machine
}
$values = foreach ($name in @($inputData.names)) {
  $value = [Environment]::GetEnvironmentVariable([string]$name, $target)
  [pscustomobject]@{
    name = [string]$name
    value = $value
  }
}
[pscustomobject]@{ values = @($values) } |
  ConvertTo-Json -Depth 6 -Compress
`;

const setScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$target = if ([string]$inputData.scope -eq 'user') {
  [EnvironmentVariableTarget]::User
} else {
  [EnvironmentVariableTarget]::Machine
}
[Environment]::SetEnvironmentVariable(
  [string]$inputData.name,
  [string]$inputData.value,
  $target
)
$actual = [Environment]::GetEnvironmentVariable(
  [string]$inputData.name,
  $target
)
if ($actual -cne [string]$inputData.value) {
  throw 'Environment variable update verification failed.'
}
[pscustomobject]@{
  scope = [string]$inputData.scope
  name = [string]$inputData.name
  verified = $true
  processUpdated = $false
  requiresNewProcess = $true
} | ConvertTo-Json -Compress
`;

const deleteScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$target = if ([string]$inputData.scope -eq 'user') {
  [EnvironmentVariableTarget]::User
} else {
  [EnvironmentVariableTarget]::Machine
}
[Environment]::SetEnvironmentVariable(
  [string]$inputData.name,
  $null,
  $target
)
$actual = [Environment]::GetEnvironmentVariable(
  [string]$inputData.name,
  $target
)
if ($null -ne $actual) {
  throw 'Environment variable deletion verification failed.'
}
[pscustomobject]@{
  scope = [string]$inputData.scope
  name = [string]$inputData.name
  deleted = $true
  verified = $true
  processUpdated = $false
  requiresNewProcess = $true
} | ConvertTo-Json -Compress
`;

async function listEnvironment(input: unknown) {
  const parsed = EnvironmentListInputSchema.parse(input);
  assertWindows();

  let names: string[];
  if (parsed.scope === 'process') {
    names = Object.keys(process.env);
  } else {
    const result = await runPowerShellJson<{ names: string[] }>(
      listScript,
      parsed,
    );
    names = result.names ?? [];
  }

  const prefix = parsed.prefix?.toLowerCase();
  const matching = [...new Set(names)]
    .filter((name) => !prefix || name.toLowerCase().startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
  const filtered = matching.slice(0, parsed.limit);

  return {
    data: {
      scope: parsed.scope,
      names: filtered.map((name) => ({
        name,
        sensitive: isSensitiveName(name),
      })),
      truncated: matching.length > filtered.length,
    },
  };
}

async function readEnvironment(input: unknown) {
  const parsed = EnvironmentReadInputSchema.parse(input);
  assertWindows();

  if (parsed.scope === 'process') {
    return {
      data: {
        scope: parsed.scope,
        values: parsed.names.map((name) => {
          const key = processKey(name);
          return redactValue(
            name,
            key ? process.env[key] : undefined,
            parsed.reveal_sensitive,
          );
        }),
      },
    };
  }

  const result = await runPowerShellJson<{
    values: Array<{ name: string; value: string | null }>;
  }>(readScript, parsed);

  return {
    data: {
      scope: parsed.scope,
      values: result.values.map((entry) =>
        redactValue(
          entry.name,
          entry.value,
          parsed.reveal_sensitive,
        ),
      ),
    },
  };
}

async function setEnvironment(input: unknown) {
  const parsed = EnvironmentSetInputSchema.parse(input);
  assertWindows();

  if (parsed.scope === 'process') {
    const existing = processKey(parsed.name);
    if (existing && existing !== parsed.name) delete process.env[existing];
    process.env[parsed.name] = parsed.value;
    const actualKey = processKey(parsed.name);
    const actual = actualKey ? process.env[actualKey] : undefined;
    if (actual !== parsed.value) {
      throw new Error('Process environment update verification failed.');
    }
    return {
      data: {
        scope: parsed.scope,
        name: parsed.name,
        verified: true,
        processUpdated: true,
      },
    };
  }

  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      setScript,
      parsed,
    ),
  };
}

async function deleteEnvironment(input: unknown) {
  const parsed = EnvironmentDeleteInputSchema.parse(input);
  assertWindows();

  if (parsed.scope === 'process') {
    const existing = processKey(parsed.name);
    if (existing) delete process.env[existing];
    if (processKey(parsed.name)) {
      throw new Error('Process environment deletion verification failed.');
    }
    return {
      data: {
        scope: parsed.scope,
        name: parsed.name,
        deleted: true,
        verified: true,
        processUpdated: true,
      },
    };
  }

  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      deleteScript,
      parsed,
    ),
  };
}

export async function executeWindowsEnvironmentCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.environment.list':
      return await listEnvironment(input);
    case 'windows.environment.read':
      return await readEnvironment(input);
    case 'windows.environment.set':
      return await setEnvironment(input);
    case 'windows.environment.delete':
      return await deleteEnvironment(input);
    default:
      throw new Error(
        'Unsupported Windows environment capability: ' + capability,
      );
  }
}
