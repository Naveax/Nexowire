import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  AGENT_PROTOCOL_VERSION,
  HubRequestSchema,
} from '../protocol/agent.js';
import { capabilitiesForPlatform } from '../protocol/capabilities.js';
import { executeCapability, normalizeAgentError } from './executors.js';
import { parseAllowedRoots, PathPolicy } from './path-policy.js';
import { ProcessManager } from './process-manager.js';

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

export async function runNativeAgent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const identity = await loadIdentity();
  const hubUrl = env.NEXOWIRE_HUB_WS_URL?.trim() || 'ws://127.0.0.1:43110/agent';
  const token = env.NEXOWIRE_AGENT_TOKEN?.trim();
  const name = env.NEXOWIRE_DEVICE_NAME?.trim() || os.hostname();
  const policy = new PathPolicy(parseAllowedRoots(env.NEXOWIRE_ALLOWED_ROOTS));
  const processStateFile =
    env.NEXOWIRE_PROCESS_STATE_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'process-sessions.json');

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
    onEvent: (event) => emitAgentEvent(event.topic, event.data),
  });
  await processes.initialize();
  let reconnectDelay = 1_000;

  const stop = (): void => {
    stopped = true;
    currentSocket?.close(1001, 'Agent shutting down');
    void processes.stopAll();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const socket = new WebSocket(hubUrl, headers ? { headers } : undefined);
    currentSocket = socket;

    await new Promise<void>((resolve) => {
      socket.once('open', () => {
        reconnectDelay = 1_000;
        socket.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: AGENT_PROTOCOL_VERSION,
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

          try {
            const data = await executeCapability(
              request.data.capability,
              request.data.input,
              policy,
              { processes },
            );
            socket.send(
              JSON.stringify({
                type: 'response',
                requestId: request.data.requestId,
                ok: true,
                data,
              }),
            );
          } catch (error) {
            socket.send(
              JSON.stringify({
                type: 'response',
                requestId: request.data.requestId,
                ok: false,
                error: normalizeAgentError(error),
              }),
            );
          }
        });
      });

      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    });

    currentSocket = undefined;
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  process.exit(0);
}
