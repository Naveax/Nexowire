import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  normalizeCloudflareAccountId,
  normalizeGitHubRepositorySlug,
  OWNER_DEPLOYMENT_SECRET_SPECS,
  parseD1DatabaseId,
  parseWranglerWhoamiAccount,
  REQUIRED_GITHUB_DEPLOYMENT_SECRET_NAMES,
  resolveCloudflareCliInvocation,
} from '../src/ops/cloudflare-ci-credentials.js';
import { readProtectedSecretFile } from '../src/security/protected-secret-files.js';

const WORKER_NAME = 'nexowire-control-plane';
const D1_NAME = 'nexowire-control-plane';

interface Options {
  apply: boolean;
  repo: string;
  accountId?: string;
}

function help(): string {
  return [
    'Usage:',
    '  npm run cloudflare:ci-provision -- [--apply]',
    '    [--repo Naveax/Nexowire]',
    '    [--account-id <32-hex-id>]',
    '',
    'The Cloudflare API token is never accepted as a command-line argument.',
    'It is read from a hidden TTY prompt or stdin, preflighted against the',
    'existing Nexowire Worker and D1 database, then written directly to',
    'GitHub Actions secrets only when --apply is supplied. The apply step',
    'also copies the three existing DPAPI-protected Nexowire owner deploy',
    'secrets directly into GitHub Actions without printing their values.',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const output: Options = {
    apply: false,
    repo: 'Naveax/Nexowire',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(help() + '\n');
      process.exit(0);
    }
    if (arg === '--apply') {
      output.apply = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for ' + arg);
    }
    if (arg === '--repo') {
      output.repo = normalizeGitHubRepositorySlug(value);
    } else if (arg === '--account-id') {
      output.accountId =
        normalizeCloudflareAccountId(value);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
    index += 1;
  }

  output.repo = normalizeGitHubRepositorySlug(output.repo);
  return output;
}

async function run(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    maxOutputBytes?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        fail(new Error('COMMAND_STDOUT_LIMIT'));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        child.kill();
        fail(new Error('COMMAND_STDERR_LIMIT'));
        return;
      }
      stderr.push(chunk);
    });

    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(
            'COMMAND_FAILED:' +
              executable +
              ':' +
              String(code) +
              (err.trim()
                ? ':' + err.trim().slice(0, 1200)
                : ''),
          ),
        );
        return;
      }
      resolve({ stdout: out, stderr: err });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function runCli(
  name: 'npx' | 'gh',
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    maxOutputBytes?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const invocation = resolveCloudflareCliInvocation(
    name,
    args,
    {
      platform: process.platform,
      nodeExecutable: process.execPath,
      npmExecPath: process.env.npm_execpath,
    },
  );
  return await run(
    invocation.executable,
    invocation.args,
    options,
  );
}

async function readHiddenToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += String(chunk);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error('CLOUDFLARE_API_TOKEN_EMPTY');
    }
    return trimmed;
  }

  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  process.stdout.write('Cloudflare CI API token: ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('TOKEN_INPUT_CANCELLED'));
          return;
        }
        if (char === '\r' || char === '\n') {
          const trimmed = value.trim();
          cleanup();
          if (!trimmed) {
            reject(new Error('CLOUDFLARE_API_TOKEN_EMPTY'));
          } else if (
            trimmed.length < 20 ||
            trimmed.length > 4096 ||
            /\s/.test(trimmed)
          ) {
            reject(new Error('CLOUDFLARE_API_TOKEN_INVALID'));
          } else {
            resolve(trimmed);
          }
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function resolveAccount(
  explicitAccountId?: string,
) {
  const oauthEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_EMAIL',
    'CLOUDFLARE_ACCOUNT_ID',
  ]) {
    delete oauthEnv[key];
  }
  const result = await runCli(
    'npx',
    [
      '--yes',
      'wrangler@4',
      'whoami',
      '--json',
    ],
    { env: oauthEnv },
  );
  return parseWranglerWhoamiAccount(
    result.stdout,
    explicitAccountId,
  );
}

async function preflight(
  token: string,
  accountId: string,
): Promise<{ d1DatabaseId: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };

  await runCli(
    'npx',
    [
      '--yes',
      'wrangler@4',
      'deployments',
      'list',
      '--name',
      WORKER_NAME,
    ],
    { env },
  );

  const d1 = await runCli(
    'npx',
    ['--yes', 'wrangler@4', 'd1', 'list', '--json'],
    { env },
  );

  return {
    d1DatabaseId: parseD1DatabaseId(
      d1.stdout,
      D1_NAME,
    ),
  };
}

async function setGitHubSecret(
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  await runCli(
    'gh',
    ['secret', 'set', name, '--repo', repo],
    { input: value },
  );
}

function readOwnerDeploymentSecrets(): Array<{
  name: string;
  value: string;
}> {
  const directory = path.join(
    os.homedir(),
    '.nexowire',
    'control-plane',
  );
  return OWNER_DEPLOYMENT_SECRET_SPECS.map((spec) => ({
    name: spec.githubName,
    value: readProtectedSecretFile(
      path.join(directory, spec.fileName),
      spec.purpose,
      spec.label,
    ),
  }));
}

async function verifyGitHubSecretNames(
  repo: string,
): Promise<void> {
  const result = await runCli('gh', [
    'secret',
    'list',
    '--repo',
    repo,
    '--json',
    'name',
  ]);
  const rows = JSON.parse(result.stdout) as Array<{
    name?: string;
  }>;
  const names = new Set(
    rows.map((row) => row.name).filter(Boolean),
  );
  for (const required of REQUIRED_GITHUB_DEPLOYMENT_SECRET_NAMES) {
    if (!names.has(required)) {
      throw new Error(
        'GITHUB_SECRET_NOT_VISIBLE:' + required,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const account = await resolveAccount(options.accountId);
  const token = await readHiddenToken();
  const checked = await preflight(token, account.id);

  if (options.apply) {
    await runCli('gh', ['auth', 'status']);

    const ownerDeploymentSecrets =
      readOwnerDeploymentSecrets();

    await setGitHubSecret(
      options.repo,
      'CLOUDFLARE_API_TOKEN',
      token,
    );
    await setGitHubSecret(
      options.repo,
      'CLOUDFLARE_ACCOUNT_ID',
      account.id,
    );
    for (const secret of ownerDeploymentSecrets) {
      await setGitHubSecret(
        options.repo,
        secret.name,
        secret.value,
      );
    }

    await verifyGitHubSecretNames(options.repo);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        apply: options.apply,
        repository: options.repo,
        accountId: account.id,
        accountName: account.name,
        worker: WORKER_NAME,
        d1Database: D1_NAME,
        d1DatabaseId: checked.d1DatabaseId,
        githubSecretsConfigured: options.apply,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    }) + '\n',
  );
  process.exitCode = 1;
});
