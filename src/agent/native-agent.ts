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
import { executeCapability, normalizeAgentError } from './executors.js';
import { parseAllowedRoots, PathPolicy } from './path-policy.js';
import { ProcessManager } from './process-manager.js';
import { TaskGraphStore } from './task-graph-store.js';
import {
  AgentRequestCache,
  fingerprintAgentRequest,
} from './request-cache.js';

interface AgentIdentity {
  id: string;
}

async function loadIdentity(): Promise<AgentIdentity> {
  const dir = path.join(os.homedir(), '.nexowire');
  const file = path.join(dir, 'agent.json');
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

function agentVersion(): string {
  return '0.1.0-dev.1';
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

function heartbeatMs(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXOWIRE_AGENT_HEARTBEAT_MS?.trim();
  if (!raw) return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(120_000, Math.max(5_000, Math.round(parsed)));
}

export async function runNativeAgent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const identity = await loadIdentity();
  const instanceId = randomUUID();
  const hubUrl = env.NEXOWIRE_HUB_WS_URL?.trim() || 'ws://127.0.0.1:43110/agent';
  const token = env.NEXOWIRE_AGENT_TOKEN?.trim();
  const name = env.NEXOWIRE_DEVICE_NAME?.trim() || os.hostname();
  const policy = new PathPolicy(parseAllowedRoots(env.NEXOWIRE_ALLOWED_ROOTS));
  const processStateFile =
    env.NEXOWIRE_PROCESS_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'process-sessions.json');
  const taskGraphStateFile =
    env.NEXOWIRE_TASK_GRAPH_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'task-graphs.json');
  const socketHeartbeatMs = heartbeatMs(env);
  const requestCache = new AgentRequestCache<AgentResponse>();

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
  await Promise.all([processes.initialize(), taskGraphs.initialize()]);
  let reconnectDelay = 1_000;

  const stop = (): void => {
    stopped = true;
    currentSocket?.close(1001, 'Agent shutting down');
    void processes.shutdown();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const socket = new WebSocket(hubUrl, headers ? { headers } : undefined);
    currentSocket = socket;

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

      socket.once('open', () => {
        reconnectDelay = 1_000;
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
              capabilities: capabilitiesForPlatform(process.platform),
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
                    { processes, taskGraphs },
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
    const waitMs = reconnectWaitMs(reconnectDelay);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  process.exit(0);
}
