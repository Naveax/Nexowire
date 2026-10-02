import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NexowireConfig } from './config.js';
import { CredentialStore } from './security/credential-store.js';
import {
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from './security/protected-secret-files.js';
import {
  hubLifecycleStatus,
  installHubLifecycle,
} from './hub/hub-lifecycle.js';
import {
  installNativeAgentLifecycle,
} from './agent/native-agent-lifecycle.js';
import {
  getAgentConnectionStatus,
  probeAgentHub,
} from './agent/native-agent-enrollment.js';
import { configureTailscaleExposure } from './tailscale-exposure.js';
import { discoverTailscale } from './agent/tailscale-discovery.js';

interface SelfHostState {
  version: 1;
  createdAt: string;
  stateDir: string;
  port: number;
  deviceName: string;
  mcpCredentialId: string;
  agentCredentialId: string;
  mcpSecretFile: string;
  agentSecretFile: string;
  funnelRequested: boolean;
}

export interface SelfHostBootstrapResult {
  bootstrapped: true;
  resumed: boolean;
  state: Omit<SelfHostState, 'mcpSecretFile' | 'agentSecretFile'> & {
    protectedSecrets: true;
  };
  hub: {
    lifecycle: Awaited<ReturnType<typeof hubLifecycleStatus>>;
    health: Record<string, unknown>;
  };
  agent: Awaited<ReturnType<typeof getAgentConnectionStatus>>;
  tailscale: Awaited<ReturnType<typeof discoverTailscale>>;
  funnel: {
    requested: boolean;
    configured: boolean;
    mcpUrl: string | null;
    agentUrl: string | null;
    error: string | null;
  };
  connector: {
    tokenShown: false;
    command: 'nexowire node connector';
  };
}

function selfHostRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, '.nexowire', 'self-host');
}

function stateFile(homeDir = os.homedir()): string {
  return path.join(selfHostRoot(homeDir), 'bootstrap.json');
}

function secretDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.nexowire', 'secrets');
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function readState(
  homeDir = os.homedir(),
): Promise<SelfHostState | null> {
  try {
    const decoded = JSON.parse(
      await fs.readFile(stateFile(homeDir), 'utf8'),
    ) as Partial<SelfHostState>;
    if (
      decoded.version !== 1 ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.stateDir !== 'string' ||
      typeof decoded.port !== 'number' ||
      typeof decoded.deviceName !== 'string' ||
      typeof decoded.mcpCredentialId !== 'string' ||
      typeof decoded.agentCredentialId !== 'string' ||
      typeof decoded.mcpSecretFile !== 'string' ||
      typeof decoded.agentSecretFile !== 'string' ||
      typeof decoded.funnelRequested !== 'boolean'
    ) {
      throw new Error('Self-host bootstrap state is invalid.');
    }
    return decoded as SelfHostState;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

async function writeState(
  state: SelfHostState,
  homeDir = os.homedir(),
): Promise<void> {
  const root = selfHostRoot(homeDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = stateFile(homeDir);
  const temp = file + '.tmp-' + process.pid;
  await fs.writeFile(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.rename(temp, file);
}

function boundedPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Self-host port must be an integer between 1 and 65535.');
  }
  return value;
}

function ttlMs(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('Self-host credential TTL must be 1-365 days.');
  }
  return days * 86_400_000;
}

async function waitForHubHealth(
  port: number,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(1_500) },
      );
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        if (body.service === 'nexowire' && body.ok === true) return body;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    'Nexowire Hub did not become healthy on loopback' +
      (lastError
        ? ': ' +
          (lastError instanceof Error ? lastError.message : String(lastError))
        : '.'),
  );
}

async function waitForLocalAgent(
  port: number,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> | undefined;

  while (Date.now() < deadline) {
    latest = await waitForHubHealth(port, 2_000);
    const agents = latest.agents;
    if (typeof agents === 'number' && agents > 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(
    'Local native agent did not register with the self-hosted Hub in time.',
  );
}

export interface SelfHostBootstrapOptions {
  deviceName?: string;
  allowedRoots?: string[];
  port?: number;
  ttlDays?: number;
  tailscaleFunnel?: boolean;
  homeDir?: string;
}

export async function bootstrapSelfHostedNode(
  configInput: NexowireConfig,
  options: SelfHostBootstrapOptions = {},
): Promise<SelfHostBootstrapResult> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Self-host bootstrap currently targets Windows because it installs Windows Hub/Agent Scheduled Tasks and DPAPI secrets.',
    );
  }

  const homeDir = options.homeDir ?? os.homedir();
  const existing = await readState(homeDir);
  const requestedPort = boundedPort(options.port ?? configInput.port);
  const requestedDeviceName =
    options.deviceName?.trim() || os.hostname();
  if (!requestedDeviceName || requestedDeviceName.length > 128) {
    throw new Error('Device name must be 1-128 characters.');
  }

  if (
    existing &&
    options.port !== undefined &&
    existing.port !== requestedPort
  ) {
    throw new Error(
      'Existing self-host state uses a different port; refusing an implicit migration.',
    );
  }
  if (
    existing &&
    options.deviceName !== undefined &&
    existing.deviceName !== requestedDeviceName
  ) {
    throw new Error(
      'Existing self-host state uses a different device name; refusing an implicit migration.',
    );
  }
  if (existing && existing.stateDir !== configInput.stateDir) {
    throw new Error(
      'Existing self-host state uses a different Hub state directory.',
    );
  }

  const stateDir = existing?.stateDir ?? configInput.stateDir;
  const store = new CredentialStore(stateDir);
  await store.initialize();

  let state: SelfHostState;
  let mcpToken: string;
  let agentToken: string;
  const resumed = existing !== null;

  if (existing) {
    state = {
      ...existing,
      funnelRequested:
        existing.funnelRequested ||
        options.tailscaleFunnel === true,
    };
    mcpToken = readProtectedSecretFile(
      state.mcpSecretFile,
      'mcp-bearer-token',
      'self-host MCP bearer token',
    );
    agentToken = readProtectedSecretFile(
      state.agentSecretFile,
      'agent-bearer-token',
      'self-host agent bearer token',
    );
    if (
      store.authenticate('mcp', mcpToken)?.id !==
        state.mcpCredentialId ||
      store.authenticate('agent', agentToken)?.id !==
        state.agentCredentialId
    ) {
      throw new Error(
        'Self-host bootstrap credentials are expired, revoked, or inconsistent with protected local state.',
      );
    }
    if (state.funnelRequested !== existing.funnelRequested) {
      await writeState(state, homeDir);
    }
  } else {
    const credentialTtl = ttlMs(options.ttlDays ?? 365);
    const secrets = secretDir(homeDir);
    const mcpSecretFile = path.join(
      secrets,
      'self-host-mcp-token.dpapi.json',
    );
    const agentSecretFile = path.join(
      secrets,
      'self-host-agent-token.dpapi.json',
    );
    if (
      (await fileExists(mcpSecretFile)) ||
      (await fileExists(agentSecretFile))
    ) {
      throw new Error(
        'Protected self-host secret files already exist without bootstrap state; refusing to overwrite ambiguous credentials.',
      );
    }

    const mcpIssued = await store.issue('mcp', {
      name: 'self-host-chatgpt',
      role: 'admin',
      ttlMs: credentialTtl,
    });
    let agentIssued:
      | Awaited<ReturnType<CredentialStore['issue']>>
      | undefined;
    try {
      agentIssued = await store.issue('agent', {
        name: 'self-host-local-agent',
        ttlMs: credentialTtl,
      });
    } catch (error) {
      await store.revoke(mcpIssued.credential.id).catch(() => undefined);
      throw error;
    }

    try {
      await writeProtectedSecretFile(
        mcpSecretFile,
        'mcp-bearer-token',
        mcpIssued.token,
        { overwrite: false },
      );
      await writeProtectedSecretFile(
        agentSecretFile,
        'agent-bearer-token',
        agentIssued.token,
        { overwrite: false },
      );

      state = {
        version: 1,
        createdAt: new Date().toISOString(),
        stateDir,
        port: requestedPort,
        deviceName: requestedDeviceName,
        mcpCredentialId: mcpIssued.credential.id,
        agentCredentialId: agentIssued.credential.id,
        mcpSecretFile,
        agentSecretFile,
        funnelRequested: options.tailscaleFunnel === true,
      };
      await writeState(state, homeDir);
    } catch (error) {
      await Promise.all([
        store.revoke(mcpIssued.credential.id).catch(() => undefined),
        store.revoke(agentIssued.credential.id).catch(() => undefined),
        fs.rm(mcpSecretFile, { force: true }).catch(() => undefined),
        fs.rm(agentSecretFile, { force: true }).catch(() => undefined),
      ]);
      throw error;
    }

    mcpToken = mcpIssued.token;
    agentToken = agentIssued.token;
  }

  const port = state.port;
  const deviceName = state.deviceName;
  const tailscaleBeforeHub = await discoverTailscale();
  const httpAllowedHosts = new Set(
    (process.env.NEXOWIRE_HTTP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    tailscaleBeforeHub.running &&
    tailscaleBeforeHub.dnsName
  ) {
    httpAllowedHosts.add(
      tailscaleBeforeHub.dnsName.toLowerCase(),
    );
  }

  const hubEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEXOWIRE_STATE_DIR: state.stateDir,
    NEXOWIRE_HTTP_HOST: '127.0.0.1',
    NEXOWIRE_HTTP_PORT: String(port),
    ...(httpAllowedHosts.size > 0
      ? {
          NEXOWIRE_HTTP_ALLOWED_HOSTS:
            [...httpAllowedHosts].join(','),
        }
      : {}),
  };
  delete hubEnv.NEXOWIRE_MCP_BEARER_TOKEN;
  delete hubEnv.NEXOWIRE_MCP_BEARER_TOKENS;
  delete hubEnv.NEXOWIRE_AGENT_TOKEN;
  delete hubEnv.NEXOWIRE_AGENT_TOKENS;

  const hubLifecycle = await installHubLifecycle({
    env: hubEnv,
    homeDir,
  });
  let health = await waitForHubHealth(port);

  const agentEndpoint = `ws://127.0.0.1:${port}/agent`;
  const authProbe = await probeAgentHub(
    agentEndpoint,
    agentToken,
    5_000,
  );
  if (!authProbe.authenticated) {
    throw new Error(
      'Self-hosted Hub rejected the generated native-agent credential.',
    );
  }

  const agentEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEXOWIRE_HUB_WS_URL: agentEndpoint,
    NEXOWIRE_DEVICE_NAME: deviceName,
    NEXOWIRE_ALLOWED_ROOTS: (
      options.allowedRoots?.length
        ? options.allowedRoots.map((entry) => path.resolve(entry))
        : [homeDir]
    ).join(path.delimiter),
    NEXOWIRE_AGENT_TOKEN_DPAPI_FILE: state.agentSecretFile,
  };
  delete agentEnv.NEXOWIRE_AGENT_TOKEN;
  delete agentEnv.NEXOWIRE_AGENT_TOKENS;
  delete agentEnv.NEXOWIRE_AGENT_TOKEN_FILE;
  delete agentEnv.NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME;

  await installNativeAgentLifecycle({
    env: agentEnv,
    homeDir,
  });
  health = await waitForLocalAgent(port);

  let funnel: SelfHostBootstrapResult['funnel'] = {
    requested: state.funnelRequested,
    configured: false,
    mcpUrl: null,
    agentUrl: null,
    error: null,
  };

  if (state.funnelRequested) {
    try {
      const exposure = await configureTailscaleExposure(
        {
          ...configInput,
          host: '127.0.0.1',
          port,
          stateDir: state.stateDir,
        },
        'funnel',
      );
      funnel = {
        requested: true,
        configured: true,
        mcpUrl: exposure.mcpUrl,
        agentUrl: exposure.agentUrl,
        error: null,
      };
    } catch (error) {
      funnel = {
        requested: true,
        configured: false,
        mcpUrl: null,
        agentUrl: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const agent = await getAgentConnectionStatus({
    homeDir,
    probe: true,
    timeoutMs: 2_000,
  });
  const tailscale = await discoverTailscale();

  return {
    bootstrapped: true,
    resumed,
    state: {
      version: state.version,
      createdAt: state.createdAt,
      stateDir: state.stateDir,
      port: state.port,
      deviceName: state.deviceName,
      mcpCredentialId: state.mcpCredentialId,
      agentCredentialId: state.agentCredentialId,
      funnelRequested: state.funnelRequested,
      protectedSecrets: true,
    },
    hub: {
      lifecycle: hubLifecycle,
      health,
    },
    agent,
    tailscale,
    funnel,
    connector: {
      tokenShown: false,
      command: 'nexowire node connector',
    },
  };
}

export async function selfHostedNodeStatus(
  configInput: NexowireConfig,
  homeDir = os.homedir(),
): Promise<Record<string, unknown>> {
  const state = await readState(homeDir);
  if (!state) {
    return {
      bootstrapped: false,
      hub: await hubLifecycleStatus({ homeDir }),
      tailscale: await discoverTailscale(),
    };
  }

  let health: Record<string, unknown> | null = null;
  let healthError: string | null = null;
  try {
    health = await waitForHubHealth(state.port, 2_000);
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  }

  return {
    bootstrapped: true,
    createdAt: state.createdAt,
    port: state.port,
    deviceName: state.deviceName,
    credentialIds: {
      mcp: state.mcpCredentialId,
      agent: state.agentCredentialId,
    },
    protectedSecrets: true,
    hub: await hubLifecycleStatus({ homeDir }),
    health,
    healthError,
    agent: await getAgentConnectionStatus({
      homeDir,
      probe: true,
      timeoutMs: 2_000,
    }),
    tailscale: await discoverTailscale(),
    connectorCommand: 'nexowire node connector',
    stateDir: state.stateDir,
  };
}

export async function selfHostedConnectorInfo(
  homeDir = os.homedir(),
): Promise<{
  mcpUrl: string | null;
  mcpToken: string;
  tokenSource: 'windows-dpapi-current-user';
  warning: string;
}> {
  const state = await readState(homeDir);
  if (!state) {
    throw new Error('This machine has not been self-host bootstrapped.');
  }
  const tailscale = await discoverTailscale();
  const mcpToken = readProtectedSecretFile(
    state.mcpSecretFile,
    'mcp-bearer-token',
    'self-host MCP bearer token',
  );
  return {
    mcpUrl:
      tailscale.running &&
      tailscale.dnsName &&
      tailscale.funnelConfigured
        ? `https://${tailscale.dnsName}/mcp`
        : null,
    mcpToken,
    tokenSource: 'windows-dpapi-current-user',
    warning:
      'This command intentionally reveals the connector bearer token. Treat the output as a secret.',
  };
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
): number {
  if (!raw) throw new Error(name + ' requires a value.');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' requires a positive integer.');
  }
  return value;
}

export function parseSelfHostBootstrapArgs(
  args: readonly string[],
): SelfHostBootstrapOptions {
  const options: SelfHostBootstrapOptions = {};
  const roots: string[] = [];

  const readValue = (index: number, name: string): string => {
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(name + ' requires a value.');
    }
    return value;
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--tailscale-funnel') {
      options.tailscaleFunnel = true;
      continue;
    }
    if (arg === '--device-name') {
      options.deviceName = readValue(index, arg);
      index++;
      continue;
    }
    if (arg.startsWith('--device-name=')) {
      options.deviceName = arg.slice('--device-name='.length);
      continue;
    }
    if (arg === '--allow-root') {
      roots.push(readValue(index, arg));
      index++;
      continue;
    }
    if (arg.startsWith('--allow-root=')) {
      roots.push(arg.slice('--allow-root='.length));
      continue;
    }
    if (arg === '--port') {
      options.port = parsePositiveInteger(arg, readValue(index, arg));
      index++;
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = parsePositiveInteger(
        '--port',
        arg.slice('--port='.length),
      );
      continue;
    }
    if (arg === '--ttl-days') {
      options.ttlDays = parsePositiveInteger(arg, readValue(index, arg));
      index++;
      continue;
    }
    if (arg.startsWith('--ttl-days=')) {
      options.ttlDays = parsePositiveInteger(
        '--ttl-days',
        arg.slice('--ttl-days='.length),
      );
      continue;
    }
    throw new Error('Unknown node bootstrap option: ' + arg);
  }

  if (roots.length > 0) options.allowedRoots = roots;
  return options;
}

export async function runSelfHostedNodeCommand(
  config: NexowireConfig,
  args: readonly string[],
): Promise<void> {
  const action = args[0] ?? 'status';

  if (action === 'bootstrap') {
    const result = await bootstrapSelfHostedNode(
      config,
      parseSelfHostBootstrapArgs(args.slice(1)),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (action === 'status') {
    process.stdout.write(
      JSON.stringify(
        await selfHostedNodeStatus(config),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (action === 'connector') {
    process.stdout.write(
      JSON.stringify(
        await selfHostedConnectorInfo(),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  throw new Error(
    'Usage: nexowire node [bootstrap|status|connector]',
  );
}
