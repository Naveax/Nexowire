import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  AGENT_PROTOCOL_VERSION,
  HubRequestSchema,
  type AgentResponse,
} from '../protocol/agent.js';
import { capabilitiesForPlatform } from '../protocol/capabilities.js';
import { browserCapabilitiesAvailable } from './browser-manager.js';
import { detectWsl } from './wsl-detection.js';
import { executeCapability, normalizeAgentError } from './executors.js';
import { parseAllowedRoots, PathPolicy } from './path-policy.js';
import { ProcessManager } from './process-manager.js';
import { TaskGraphStore } from './task-graph-store.js';
import { RunbookStore } from './runbook-store.js';
import {
  AgentRequestCache,
  fingerprintAgentRequest,
} from './request-cache.js';
import { PrivilegedBrokerClient } from './privileged-broker-client.js';
import { loadOrCreatePrivilegedBrokerToken } from '../security/privileged-broker-secret.js';
import { resolveProtectedSingleSecret } from '../security/protected-secret-files.js';
import { optionalPlatformSecretSync } from '../security/platform-secret-store.js';
import { NEXOWIRE_VERSION } from '../version.js';
import { acquireNativeAgentSingleton } from './native-agent-singleton.js';

export interface AgentIdentity {
  id: string;
}

export async function loadOrCreateAgentIdentity(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentIdentity> {
  const file = path.resolve(
    env.NEXOWIRE_AGENT_IDENTITY_FILE?.trim() ||
      path.join(os.homedir(), '.nexowire', 'agent.json'),
  );
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });

  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as AgentIdentity;
    if (typeof parsed.id === 'string' && parsed.id.length > 0) return parsed;
  } catch {
    // Create a fresh identity below.
  }

  const identity = { id: randomUUID() };
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
  return identity;
}

export function agentVersion(): string {
  return NEXOWIRE_VERSION;
}

export function agentTokenFromEnv(
  env: NodeJS.ProcessEnv,
  platformSingle: (
    name: string | undefined,
    purpose: string,
  ) => string | undefined = (
    name: string | undefined,
    purpose: string,
  ) => optionalPlatformSecretSync(name, purpose),
): string | undefined {
  const platformToken = platformSingle(
    env.NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME,
    'agent-bearer-token',
  );
  return resolveProtectedSingleSecret(
    env.NEXOWIRE_AGENT_TOKEN,
    env.NEXOWIRE_AGENT_TOKEN_FILE,
    env.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE,
    'agent-bearer-token',
    'native-agent bearer token',
    platformToken,
  );
}

export function reconnectWaitMs(
  baseDelayMs: number,
  random: () => number = Math.random,
): number {
  const boundedBase = Math.min(30_000, Math.max(250, baseDelayMs));
  const sample = Math.min(1, Math.max(0, random()));
  const factor = 0.8 + sample * 0.4;
  return Math.min(30_000, Math.max(250, Math.round(boundedBase * factor)));
}

export function parseHubEndpoints(
  env: NodeJS.ProcessEnv,
): string[] {
  const raw: string[] = [];
  const primary = env.NEXOWIRE_HUB_WS_URL?.trim();
  if (primary) raw.push(primary);

  for (const part of env.NEXOWIRE_HUB_WS_URLS?.split(',') ?? []) {
    const value = part.trim();
    if (value) raw.push(value);
  }

  if (raw.length === 0) {
    raw.push('ws://127.0.0.1:43110/agent');
  }

  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const value of raw) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `Invalid Nexowire hub WebSocket URL: ${value}`,
      );
    }

    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      throw new Error(
        `Nexowire hub endpoints must use ws:// or wss://: ${value}`,
      );
    }
    if (parsed.username || parsed.password) {
      throw new Error(
        'Nexowire hub endpoint URLs must not embed credentials.',
      );
    }
    if (parsed.hash) {
      throw new Error(
        'Nexowire hub endpoint URLs must not contain fragments.',
      );
    }

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    endpoints.push(normalized);
  }

  return endpoints;
}

export interface NextHubAttempt {
  endpointIndex: number;
  waitMs: number;
  nextBackoffMs: number;
  stableConnection: boolean;
}

export function planNextHubAttempt(input: {
  currentIndex: number;
  endpointCount: number;
  backoffMs: number;
  connectedMs: number;
  random?: () => number;
}): NextHubAttempt {
  if (!Number.isInteger(input.endpointCount) || input.endpointCount < 1) {
    throw new Error('Hub endpoint count must be at least one.');
  }
  if (
    !Number.isInteger(input.currentIndex) ||
    input.currentIndex < 0 ||
    input.currentIndex >= input.endpointCount
  ) {
    throw new Error('Current hub endpoint index is out of range.');
  }

  const stableConnection = input.connectedMs >= 10_000;
  if (stableConnection) {
    return {
      endpointIndex: 0,
      waitMs: reconnectWaitMs(1_000, input.random),
      nextBackoffMs: 1_000,
      stableConnection: true,
    };
  }

  const endpointIndex =
    (input.currentIndex + 1) % input.endpointCount;
  if (endpointIndex !== 0) {
    return {
      endpointIndex,
      waitMs: 250,
      nextBackoffMs: Math.min(
        30_000,
        Math.max(1_000, input.backoffMs),
      ),
      stableConnection: false,
    };
  }

  const backoffMs = Math.min(
    30_000,
    Math.max(1_000, input.backoffMs),
  );
  return {
    endpointIndex,
    waitMs: reconnectWaitMs(backoffMs, input.random),
    nextBackoffMs: Math.min(backoffMs * 2, 30_000),
    stableConnection: false,
  };
}

function privilegeMode(
  env: NodeJS.ProcessEnv,
): 'direct' | 'broker' {
  const raw =
    env.NEXOWIRE_PRIVILEGE_MODE?.trim().toLowerCase() ??
    'direct';
  if (raw === 'direct' || raw === 'broker') return raw;
  throw new Error(
    'NEXOWIRE_PRIVILEGE_MODE must be direct or broker.',
  );
}

async function privilegedBrokerFromEnv(
  env: NodeJS.ProcessEnv,
  mode: 'direct' | 'broker',
): Promise<PrivilegedBrokerClient | undefined> {
  if (mode !== 'broker') return undefined;

  const url =
    env.NEXOWIRE_PRIVILEGED_BROKER_URL?.trim() ||
    'http://127.0.0.1:43112';
  const token =
    env.NEXOWIRE_PRIVILEGED_BROKER_TOKEN?.trim() ||
    (await loadOrCreatePrivilegedBrokerToken({
      ...(env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE?.trim()
        ? {
            file: env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE.trim(),
          }
        : {}),
    }));

  return new PrivilegedBrokerClient({ url, token });
}

function heartbeatMs(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXOWIRE_AGENT_HEARTBEAT_MS?.trim();
  if (!raw) return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(120_000, Math.max(5_000, Math.round(parsed)));
}

export function filterRuntimeCapabilities(
  platform: NodeJS.Platform,
  availability: {
    browser: boolean;
    wsl: boolean;
  },
): string[] {
  let capabilities = capabilitiesForPlatform(platform);

  if (!availability.browser) {
    capabilities = capabilities.filter(
      (capability) => !capability.startsWith('browser.'),
    );
  }

  if (platform === 'win32' && !availability.wsl) {
    capabilities = capabilities.filter(
      (capability) => capability !== 'wsl.exec',
    );
  }

  return capabilities;
}

export async function capabilitiesForAgent(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const [browser, wsl] = await Promise.all([
    browserCapabilitiesAvailable({
      platform,
      env,
    }),
    Promise.resolve(
      platform === 'win32'
        ? detectWsl({ platform, env }).available
        : false,
    ),
  ]);

  return filterRuntimeCapabilities(platform, {
    browser,
    wsl,
  });
}

export async function runNativeAgent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const identity = await loadOrCreateAgentIdentity(env);
  const instanceId = randomUUID();
  const hubEndpoints = parseHubEndpoints(env);
  const token = agentTokenFromEnv(env);
  const name = env.NEXOWIRE_DEVICE_NAME?.trim() || os.hostname();
  const policy = new PathPolicy(parseAllowedRoots(env.NEXOWIRE_ALLOWED_ROOTS));
  const processStateFile =
    env.NEXOWIRE_PROCESS_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'process-sessions.json');
  const taskGraphStateFile =
    env.NEXOWIRE_TASK_GRAPH_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'task-graphs.json');
  const runbookStateFile =
    env.NEXOWIRE_RUNBOOK_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'runbooks.json');
  const socketHeartbeatMs = heartbeatMs(env);
  const activePrivilegeMode = privilegeMode(env);
  const privilegedBroker = await privilegedBrokerFromEnv(
    env,
    activePrivilegeMode,
  );
  const requestCache = new AgentRequestCache<AgentResponse>();
  const advertisedCapabilities = await capabilitiesForAgent(
    process.platform,
    env,
  );

  let stopped = false;
  let currentSocket: WebSocket | undefined;
  const emitAgentEvent = (topic: string, data: unknown): void => {
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
    currentSocket.send(
      JSON.stringify({
        type: 'event',
        eventId: randomUUID(),
        at: new Date().toISOString(),
        topic,
        data,
      }),
    );
  };
  const processes = new ProcessManager({
    stateFile: processStateFile,
    workerRoot:
      env.NEXOWIRE_PROCESS_WORKER_ROOT?.trim() ||
      path.join(os.homedir(), '.nexowire', 'process-workers'),
    workerEntrypoint: process.argv[1],
    workerExecArgv: process.execArgv,
    onEvent: (event) => emitAgentEvent(event.topic, event.data),
  });
  const taskGraphs = new TaskGraphStore({ stateFile: taskGraphStateFile });
  const runbooks = new RunbookStore({ stateFile: runbookStateFile });
  // Acquire before initializing persisted worker/task state. Two installed
  // launchers using the same Windows user/device identity must never both
  // attach to the Hub or mutate the same state files.
  const singletonLock = await acquireNativeAgentSingleton(identity.id);
  try {
    await Promise.all([
      processes.initialize(),
      taskGraphs.initialize(),
      runbooks.initialize(),
    ]);
  } catch (error) {
    await singletonLock?.close();
    throw error;
  }
  let reconnectDelay = 1_000;
  let endpointIndex = 0;

  const stop = (): void => {
    stopped = true;
    currentSocket?.close(1001, 'Agent shutting down');
    void processes.shutdown();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    const hubUrl = hubEndpoints[endpointIndex]!;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const socket = new WebSocket(hubUrl, headers ? { headers } : undefined);
    currentSocket = socket;
    let openedAt: number | undefined;

    await new Promise<void>((resolve) => {
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let lastPongAt = Date.now();
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        resolve();
      };

      socket.once('open', async () => {
        openedAt = Date.now();
        lastPongAt = Date.now();
        socket.on('pong', () => {
          lastPongAt = Date.now();
        });
        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastPongAt > socketHeartbeatMs * 2.5) {
            socket.terminate();
            return;
          }
          if (socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.ping();
          } catch {
            socket.terminate();
          }
        }, socketHeartbeatMs);
        heartbeatTimer.unref();

        const bridgeProbe = privilegedBroker
          ? await privilegedBroker.probe()
          : {
              reachable: false,
              elevated: false,
            };
        socket.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: AGENT_PROTOCOL_VERSION,
            instanceId,
            device: {
              id: identity.id,
              name,
              platform: process.platform,
              arch: process.arch,
              agentVersion: agentVersion(),
              capabilities: advertisedCapabilities,
              privilegeMode: activePrivilegeMode,
              adminBridgeReady:
                activePrivilegeMode === 'broker' &&
                bridgeProbe.reachable &&
                bridgeProbe.elevated,
            },
          }),
        );

        socket.on('message', async (raw) => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw.toString());
          } catch {
            return;
          }

          const request = HubRequestSchema.safeParse(decoded);
          if (!request.success) return;

          let response: AgentResponse;
          try {
            const fingerprint = fingerprintAgentRequest(
              request.data.capability,
              request.data.input,
              request.data.accessMode,
            );
            response = await requestCache.run(
              request.data.requestId,
              fingerprint,
              async () => {
                try {
                  const data = await executeCapability(
                    request.data.capability,
                    request.data.input,
                    policy,
                    {
                      processes,
                      taskGraphs,
                      runbooks,
                      privilegeMode: activePrivilegeMode,
                      accessMode: request.data.accessMode,
                      ...(privilegedBroker
                        ? { privilegedBroker }
                        : {}),
                    },
                  );
                  return {
                    type: 'response' as const,
                    requestId: request.data.requestId,
                    ok: true,
                    data,
                  };
                } catch (error) {
                  return {
                    type: 'response' as const,
                    requestId: request.data.requestId,
                    ok: false,
                    error: normalizeAgentError(error),
                  };
                }
              },
            );
          } catch (error) {
            response = {
              type: 'response',
              requestId: request.data.requestId,
              ok: false,
              error: normalizeAgentError(error),
            };
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
          }
        });
      });

      socket.once('close', finish);
      socket.once('error', finish);
    });

    currentSocket = undefined;
    if (stopped) break;

    const connectedMs =
      openedAt === undefined ? 0 : Date.now() - openedAt;
    const plan = planNextHubAttempt({
      currentIndex: endpointIndex,
      endpointCount: hubEndpoints.length,
      backoffMs: reconnectDelay,
      connectedMs,
    });
    endpointIndex = plan.endpointIndex;
    reconnectDelay = plan.nextBackoffMs;
    await new Promise((resolve) =>
      setTimeout(resolve, plan.waitMs),
    );
  }

  process.exit(0);
}
