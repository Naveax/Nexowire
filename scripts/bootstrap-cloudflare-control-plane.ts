import {
  randomBytes,
} from 'node:crypto';
import {
  spawn,
} from 'node:child_process';
import {
  promises as fs,
} from 'node:fs';
import {
  createServer,
} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../src/security/protected-secret-files.js';

const ROOT = process.cwd();
const WRANGLER_VERSION = '4';
const DB_NAME = 'nexowire-control-plane';

function command(name: string): string {
  return process.platform === 'win32'
    ? name + '.cmd'
    : name;
}

async function run(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
    allowFailure?: boolean;
  } = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
    };
    const isWindowsBatch =
      process.platform === 'win32' &&
      /\.(?:cmd|bat)$/i.test(executable);
    const childExecutable = isWindowsBatch
      ? 'powershell.exe'
      : executable;
    const childArgs = isWindowsBatch
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          [
            "$ErrorActionPreference='Stop'",
            '$exe=$env:NEXOWIRE_BOOTSTRAP_CHILD_EXE',
            '$argv=@(ConvertFrom-Json -InputObject $env:NEXOWIRE_BOOTSTRAP_CHILD_ARGS_JSON)',
            '& $exe @argv',
            'exit $LASTEXITCODE',
          ].join(';'),
        ]
      : args;

    if (isWindowsBatch) {
      childEnv.NEXOWIRE_BOOTSTRAP_CHILD_EXE =
        executable;
      childEnv.NEXOWIRE_BOOTSTRAP_CHILD_ARGS_JSON =
        JSON.stringify(args);
    }

    const child = spawn(
      childExecutable,
      childArgs,
      {
        cwd: ROOT,
        env: childEnv,
        windowsHide: options.inherit !== true,
        stdio: options.inherit
          ? 'inherit'
          : ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!options.inherit) {
      child.stdout?.on(
        'data',
        (chunk: Buffer) => stdout.push(chunk),
      );
      child.stderr?.on(
        'data',
        (chunk: Buffer) => stderr.push(chunk),
      );
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (
        result.code !== 0 &&
        options.allowFailure !== true
      ) {
        reject(
          new Error(
            result.stderr.trim() ||
              result.stdout.trim() ||
              executable + ' failed.',
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function wrangler(
  args: string[],
  options: Parameters<typeof run>[2] = {},
) {
  return await run(
    command('npx'),
    ['--yes', 'wrangler@' + WRANGLER_VERSION, ...args],
    options,
  );
}

async function callbackPortAvailable(
  port = 8976,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'EADDRINUSE'
      ) {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(
      {
        host: '127.0.0.1',
        port,
        exclusive: true,
      },
      () => {
        server.close((error) => {
          if (error) reject(error);
          else resolve(true);
        });
      },
    );
  });
}

async function waitForWranglerCallbackPort(
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await callbackPortAvailable(8976)) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 250),
    );
  }
  throw new Error(
    'Cloudflare OAuth callback port 8976 is still in use. Close the stale Wrangler login process and retry.',
  );
}

async function ensureCloudflareLogin(): Promise<void> {
  const current = await wrangler(
    ['whoami', '--json'],
    { allowFailure: true },
  );
  if (current.code === 0) return;

  process.stdout.write(
    JSON.stringify({
      stage: 'cloudflare-login',
      actionRequired:
        'Cloudflare browser authorization',
    }) + '\n',
  );
  await waitForWranglerCallbackPort();
  const login = await wrangler(
    ['login'],
    { inherit: true, allowFailure: true },
  );
  if (login.code !== 0) {
    throw new Error(
      'Cloudflare authorization was not completed.',
    );
  }

  const verified = await wrangler(
    ['whoami', '--json'],
    { allowFailure: true },
  );
  if (verified.code !== 0) {
    throw new Error(
      'Wrangler is still not authenticated.',
    );
  }
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (
      !key ||
      ![
        '--agent-url',
        '--mcp-url',
        '--admin-github-id',
        '--free-capacity',
      ].includes(key)
    ) {
      throw new Error(
        'Unknown control-plane bootstrap option: ' +
          String(key),
      );
    }
    const value = argv[++i]?.trim();
    if (!value) {
      throw new Error(key + ' requires a value.');
    }
    values.set(key, value);
  }
  return values;
}

async function nodeStatus(): Promise<any> {
  const result = await run(
    command('nexowire'),
    ['node', 'status'],
  );
  return JSON.parse(result.stdout);
}

function validateEndpoint(
  raw: string,
  protocol: 'https:' | 'wss:',
  pathName: '/mcp' | '/agent',
): string {
  const url = new URL(raw);
  if (
    url.protocol !== protocol ||
    url.pathname !== pathName ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      raw +
        ' must be a clean ' +
        protocol +
        ' URL ending in ' +
        pathName,
    );
  }
  return url.toString();
}

async function resolveEndpoints(args: Map<string, string>) {
  const status = await nodeStatus();
  const inferredMcp =
    status?.tailscale?.funnelConfigured &&
    status?.tailscale?.dnsName
      ? 'https://' +
        status.tailscale.dnsName +
        '/mcp'
      : undefined;
  const inferredAgent =
    status?.tailscale?.funnelConfigured &&
    status?.tailscale?.dnsName
      ? 'wss://' +
        status.tailscale.dnsName +
        '/agent'
      : undefined;

  const mcpUrl =
    args.get('--mcp-url') ??
    process.env.NEXOWIRE_MCP_RESOURCE_URL ??
    inferredMcp;
  const agentUrl =
    args.get('--agent-url') ??
    process.env.NEXOWIRE_AGENT_WS_URL ??
    inferredAgent;

  if (!mcpUrl || !agentUrl) {
    throw new Error(
      'Public MCP/agent URLs are unavailable. Enable Nexowire Tailscale Funnel or pass --mcp-url and --agent-url.',
    );
  }

  return {
    status,
    mcpUrl: validateEndpoint(
      mcpUrl,
      'https:',
      '/mcp',
    ),
    agentUrl: validateEndpoint(
      agentUrl,
      'wss:',
      '/agent',
    ),
  };
}

async function d1DatabaseId(): Promise<string> {
  const list = async () => {
    const result = await wrangler(
      ['d1', 'list', '--json'],
    );
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) {
      throw new Error(
        'Wrangler D1 list returned invalid JSON.',
      );
    }
    const row = rows.find(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        entry.name === DB_NAME,
    );
    return String(
      row?.uuid ?? row?.id ?? '',
    ).trim();
  };

  let id = await list();
  if (!id) {
    await wrangler(['d1', 'create', DB_NAME]);
    id = await list();
  }
  if (!/^[0-9a-f-]{16,64}$/i.test(id)) {
    throw new Error(
      'Could not resolve the Nexowire D1 database ID.',
    );
  }
  return id;
}

async function ensureSecret(input: {
  file: string;
  purpose: string;
  create: () => string;
}): Promise<string> {
  try {
    await fs.access(input.file);
    return readProtectedSecretFile(
      input.file,
      input.purpose,
      input.purpose,
    );
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: string }).code !== 'ENOENT'
    ) {
      throw error;
    }
  }

  const value = input.create();
  await writeProtectedSecretFile(
    input.file,
    input.purpose,
    value,
  );
  return value;
}

async function secureDeploymentSecrets() {
  if (process.platform !== 'win32') {
    throw new Error(
      'The zero-touch owner bootstrap currently requires Windows DPAPI. Use the GitHub Actions deployment workflow on other platforms.',
    );
  }
  const dir = path.join(
    os.homedir(),
    '.nexowire',
    'control-plane',
  );
  await fs.mkdir(dir, {
    recursive: true,
    mode: 0o700,
  });

  const sessionFile = path.join(
    dir,
    'session-secret.dpapi.json',
  );
  const serviceFile = path.join(
    dir,
    'service-token.dpapi.json',
  );
  const configKeyFile = path.join(
    dir,
    'config-encryption-key.dpapi.json',
  );

  return {
    sessionSecret: await ensureSecret({
      file: sessionFile,
      purpose: 'control-plane-session-secret',
      create: () =>
        randomBytes(48).toString('base64url'),
    }),
    serviceToken: await ensureSecret({
      file: serviceFile,
      purpose: 'control-plane-service-token',
      create: () =>
        'nwx_service_' +
        randomBytes(48).toString('base64url'),
    }),
    configEncryptionKey: await ensureSecret({
      file: configKeyFile,
      purpose:
        'control-plane-config-encryption-key',
      create: () =>
        randomBytes(32).toString('base64url'),
    }),
    serviceFile,
  };
}

function workerUrlFromDeploy(output: string): string {
  const matches = output.match(
    /https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/g,
  );
  const value = matches?.at(-1);
  if (!value) {
    throw new Error(
      'Wrangler deploy completed but the workers.dev URL could not be resolved from its output.',
    );
  }
  return value.replace(/\/$/, '');
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform === 'win32') {
    const child = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'start', '', url],
      {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.unref();
    return;
  }
  const executable =
    process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const child = spawn(executable, [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function fetchUntilOk(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
      lastStatus = response.status;
      if (response.ok) return response;
    } catch {
      // Deployment/restart propagation can briefly refuse connections.
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 500),
    );
  }
  throw new Error(
    'Endpoint did not become healthy in time: ' +
      url +
      (lastStatus ? ' (last HTTP ' + lastStatus + ')' : ''),
  );
}

async function githubSetup(
  workerUrl: string,
  serviceToken: string,
): Promise<void> {
  const start = await fetch(
    workerUrl +
      '/api/v1/internal/setup/github/start',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization:
          'Bearer ' + serviceToken,
      },
    },
  );
  if (!start.ok) {
    throw new Error(
      'GitHub App setup could not be started.',
    );
  }
  const body = await start.json() as {
    configured?: boolean;
    setupUrl?: string;
  };
  if (body.configured === true) return;
  if (
    typeof body.setupUrl !== 'string' ||
    !body.setupUrl.startsWith(
      workerUrl + '/setup/github?',
    )
  ) {
    throw new Error(
      'Control plane returned an invalid GitHub setup URL.',
    );
  }

  process.stdout.write(
    JSON.stringify({
      stage: 'github-app',
      actionRequired:
        'Approve Create GitHub App in the browser',
      setupUrl: body.setupUrl,
    }) + '\n',
  );
  await openBrowser(body.setupUrl);

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, 2_000),
    );
    const status = await fetch(
      workerUrl +
        '/api/v1/internal/setup/status',
      {
        headers: {
          accept: 'application/json',
          authorization:
            'Bearer ' + serviceToken,
        },
      },
    );
    if (!status.ok) continue;
    const statusBody = await status.json() as {
      githubConfigured?: boolean;
    };
    if (statusBody.githubConfigured === true) {
      return;
    }
  }

  throw new Error(
    'Timed out waiting for GitHub App creation.',
  );
}

async function configureHub(input: {
  workerUrl: string;
  mcpUrl: string;
  serviceFile: string;
  nodeStatus: any;
}): Promise<void> {
  const mcpHost = new URL(input.mcpUrl).hostname;
  const env: NodeJS.ProcessEnv = {
    NEXOWIRE_CONTROL_PLANE_URL:
      input.workerUrl,
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
      input.serviceFile,
    NEXOWIRE_MCP_RESOURCE_URL:
      input.mcpUrl,
    NEXOWIRE_HTTP_ALLOWED_HOSTS:
      mcpHost,
    NEXOWIRE_HTTP_HOST: '127.0.0.1',
    NEXOWIRE_HTTP_PORT: String(
      input.nodeStatus?.port ?? 43110,
    ),
    NEXOWIRE_STATE_DIR:
      String(
        input.nodeStatus?.stateDir ??
          path.join(
            os.homedir(),
            '.nexowire',
            'hub',
          ),
      ),
  };

  await run(
    command('nexowire'),
    ['hub', 'install'],
    { env },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureCloudflareLogin();
  const endpoints = await resolveEndpoints(args);
  const dbId = await d1DatabaseId();
  const secrets = await secureDeploymentSecrets();

  const temp = await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'nexowire-control-plane-',
    ),
  );
  const runtimeConfig = path.join(
    temp,
    'wrangler.runtime.json',
  );
  const secretsFile = path.join(
    temp,
    'secrets.json',
  );

  try {
    const prepareEnv = {
      ...process.env,
      NEXOWIRE_D1_DATABASE_ID: dbId,
      NEXOWIRE_AGENT_WS_URL:
        endpoints.agentUrl,
      NEXOWIRE_MCP_RESOURCE_URL:
        endpoints.mcpUrl,
      NEXOWIRE_ADMIN_GITHUB_ID:
        args.get('--admin-github-id') ??
        process.env.NEXOWIRE_ADMIN_GITHUB_ID ??
        '',
      NEXOWIRE_FREE_CAPACITY_PERCENT:
        args.get('--free-capacity') ??
        process.env.NEXOWIRE_FREE_CAPACITY_PERCENT ??
        '0',
    };

    await run(
      process.execPath,
      [
        path.join(
          ROOT,
          'scripts',
          'prepare-cloudflare-control-plane.mjs',
        ),
        path.join(
          ROOT,
          'cloudflare',
          'wrangler.jsonc',
        ),
        runtimeConfig,
      ],
      { env: prepareEnv },
    );

    await fs.writeFile(
      secretsFile,
      JSON.stringify({
        NEXOWIRE_SESSION_SECRET:
          secrets.sessionSecret,
        NEXOWIRE_INTERNAL_SERVICE_TOKEN:
          secrets.serviceToken,
        NEXOWIRE_CONFIG_ENCRYPTION_KEY:
          secrets.configEncryptionKey,
      }),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );

    await run(
      command('npm'),
      ['run', 'build'],
    );
    await wrangler([
      'd1',
      'migrations',
      'apply',
      DB_NAME,
      '--remote',
      '--config',
      runtimeConfig,
    ]);

    const deployed = await wrangler([
      'deploy',
      '--config',
      runtimeConfig,
      '--secrets-file',
      secretsFile,
      '--strict',
    ]);
    const workerUrl = workerUrlFromDeploy(
      deployed.stdout + '\n' + deployed.stderr,
    );

    await fetchUntilOk(
      workerUrl + '/health',
    );

    await githubSetup(
      workerUrl,
      secrets.serviceToken,
    );
    await configureHub({
      workerUrl,
      mcpUrl: endpoints.mcpUrl,
      serviceFile: secrets.serviceFile,
      nodeStatus: endpoints.status,
    });

    await fetchUntilOk(
      new URL(
        '/.well-known/oauth-protected-resource/mcp',
        endpoints.mcpUrl,
      ).toString(),
      {},
      20_000,
    );

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          controlPlaneUrl: workerUrl,
          githubConfigured: true,
          hubConfigured: true,
          mcpUrl: endpoints.mcpUrl,
          agentUrl: endpoints.agentUrl,
          serviceTokenStoredWithDpapi: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await fs.rm(temp, {
      recursive: true,
      force: true,
    });
  }
}

await main();
