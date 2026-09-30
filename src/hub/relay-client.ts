import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AgentBroker } from '../core/agent-broker.js';
import {
  AGENT_SOCKET_CLOSED,
  AGENT_SOCKET_OPEN,
  type AgentSocketLike,
} from '../core/agent-socket.js';
import { acceptAgentSocket } from './agent-websocket.js';
import {
  RelayToHubMessageSchema,
  type HubToRelayMessage,
} from '../relay/protocol.js';

class RelayAgentSocket
  extends EventEmitter
  implements AgentSocketLike
{
  readyState = AGENT_SOCKET_OPEN;

  constructor(
    readonly connectionId: string,
    private readonly sendControl: (
      message: HubToRelayMessage,
    ) => void,
  ) {
    super();
  }

  send(data: string): void {
    if (this.readyState !== AGENT_SOCKET_OPEN) {
      throw new Error('Relay agent socket is not open.');
    }
    this.sendControl({
      type: 'agent.send',
      connectionId: this.connectionId,
      data,
    });
  }

  close(code = 1000, reason = 'Closed by hub'): void {
    if (this.readyState === AGENT_SOCKET_CLOSED) return;
    try {
      this.sendControl({
        type: 'agent.close',
        connectionId: this.connectionId,
        code,
        reason: reason.slice(0, 1024),
      });
    } catch {
      // The outer relay route may already be gone.
    }
    this.finishClose();
  }

  receive(data: string): void {
    if (this.readyState !== AGENT_SOCKET_OPEN) return;
    this.emit('message', Buffer.from(data, 'utf8'));
  }

  remoteClose(): void {
    this.finishClose();
  }

  private finishClose(): void {
    if (this.readyState === AGENT_SOCKET_CLOSED) return;
    this.readyState = AGENT_SOCKET_CLOSED;
    this.emit('close');
    this.removeAllListeners();
  }
}

export interface RelayHubClientOptions {
  url: string;
  token: string;
  broker: AgentBroker;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  helloTimeoutMs?: number;
}

function validateRelayHubUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid Nexowire relay hub URL.');
  }

  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Nexowire relay hub URL must use ws:// or wss://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      'Nexowire relay hub URL must not embed credentials.',
    );
  }
  if (parsed.hash) {
    throw new Error(
      'Nexowire relay hub URL must not include a fragment.',
    );
  }
  return parsed.toString();
}

function reconnectDelay(
  baseMs: number,
  maxMs: number,
): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(
    250,
    Math.min(maxMs, Math.round(baseMs * jitter)),
  );
}

export class RelayHubClient {
  private readonly url: string;
  private readonly token: string;
  private readonly broker: AgentBroker;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly helloTimeoutMs: number;
  private readonly virtualSockets = new Map<
    string,
    RelayAgentSocket
  >();
  private stopped = false;
  private outer?: WebSocket;
  private runPromise?: Promise<void>;

  constructor(options: RelayHubClientOptions) {
    this.url = validateRelayHubUrl(options.url);
    this.token = options.token.trim();
    if (!this.token) {
      throw new Error('Nexowire relay hub token is required.');
    }
    this.broker = options.broker;
    this.reconnectMinMs = Math.max(
      250,
      options.reconnectMinMs ?? 1_000,
    );
    this.reconnectMaxMs = Math.max(
      this.reconnectMinMs,
      options.reconnectMaxMs ?? 30_000,
    );
    this.helloTimeoutMs = Math.max(
      250,
      options.helloTimeoutMs ?? 5_000,
    );
  }

  start(): void {
    if (this.runPromise) return;
    this.stopped = false;
    this.runPromise = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.outer?.close(1000, 'Hub relay client stopping');
    this.closeVirtualSockets();
    await this.runPromise;
    this.runPromise = undefined;
  }

  isConnected(): boolean {
    return this.outer?.readyState === WebSocket.OPEN;
  }

  private async run(): Promise<void> {
    let backoffMs = this.reconnectMinMs;

    while (!this.stopped) {
      const socket = new WebSocket(this.url, {
        headers: {
          Authorization: 'Bearer ' + this.token,
        },
        maxPayload: 64 * 1024 * 1024,
      });
      this.outer = socket;

      let consumePromise: Promise<void> | undefined;
      const opened = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        socket.once('open', () => {
          consumePromise = this.consume(socket);
          finish(true);
        });
        socket.once('error', () => finish(false));
        socket.once('close', () => finish(false));
      });

      if (opened) {
        backoffMs = this.reconnectMinMs;
        await consumePromise;
      }

      if (this.outer === socket) this.outer = undefined;
      this.closeVirtualSockets();
      if (this.stopped) break;

      const waitMs = reconnectDelay(
        backoffMs,
        this.reconnectMaxMs,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, waitMs),
      );
      backoffMs = Math.min(
        backoffMs * 2,
        this.reconnectMaxMs,
      );
    }
  }

  private async consume(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.on('message', (raw) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          socket.close(1008, 'Invalid relay JSON');
          return;
        }

        const parsed =
          RelayToHubMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          socket.close(1008, 'Invalid relay message');
          return;
        }

        const message = parsed.data;
        if (message.type === 'agent.open') {
          if (
            this.virtualSockets.has(message.connectionId)
          ) {
            socket.close(
              1008,
              'Duplicate relay connection ID',
            );
            return;
          }

          const virtual = new RelayAgentSocket(
            message.connectionId,
            (control) => this.sendControl(socket, control),
          );
          this.virtualSockets.set(
            message.connectionId,
            virtual,
          );
          virtual.once('close', () => {
            if (
              this.virtualSockets.get(
                message.connectionId,
              ) === virtual
            ) {
              this.virtualSockets.delete(
                message.connectionId,
              );
            }
          });
          acceptAgentSocket(
            virtual,
            this.broker,
            this.helloTimeoutMs,
          );
          return;
        }

        const virtual = this.virtualSockets.get(
          message.connectionId,
        );
        if (!virtual) return;

        if (message.type === 'agent.message') {
          virtual.receive(message.data);
          return;
        }

        virtual.remoteClose();
        this.virtualSockets.delete(
          message.connectionId,
        );
      });

      socket.once('close', finish);
      socket.once('error', finish);
    });
  }

  private sendControl(
    socket: WebSocket,
    message: HubToRelayMessage,
  ): void {
    if (
      socket !== this.outer ||
      socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error('Relay hub route is offline.');
    }
    socket.send(JSON.stringify(message));
  }

  private closeVirtualSockets(): void {
    const sockets = [...this.virtualSockets.values()];
    this.virtualSockets.clear();
    for (const socket of sockets) socket.remoteClose();
  }
}
