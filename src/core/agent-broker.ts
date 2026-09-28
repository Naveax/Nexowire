import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  AgentResponseSchema,
  type AgentDevice,
  type AgentHello,
} from '../protocol/agent.js';
import { NexowireError } from './errors.js';

interface AgentConnection {
  socket: WebSocket;
  device: AgentDevice;
  connectedAt: string;
}

interface PendingRequest {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectedAgent extends AgentDevice {
  connectedAt: string;
}

export class AgentBroker {
  private readonly agents = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, PendingRequest>();

  register(socket: WebSocket, hello: AgentHello): void {
    const deviceId = hello.device.id;
    const existing = this.agents.get(deviceId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(4001, 'Replaced by a newer connection');
    }

    this.agents.set(deviceId, {
      socket,
      device: hello.device,
      connectedAt: new Date().toISOString(),
    });

    socket.on('message', (raw) => this.handleMessage(deviceId, raw.toString()));
    socket.on('close', () => this.handleDisconnect(deviceId, socket));
    socket.on('error', () => this.handleDisconnect(deviceId, socket));
  }

  list(): ConnectedAgent[] {
    return [...this.agents.values()]
      .map(({ device, connectedAt }) => ({ ...device, connectedAt }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  has(deviceId: string): boolean {
    const connection = this.agents.get(deviceId);
    return connection?.socket.readyState === WebSocket.OPEN;
  }

  async request(
    deviceId: string,
    capability: string,
    input: unknown,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    const connection = this.agents.get(deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new NexowireError(
        'AGENT_OFFLINE',
        `Native agent "${deviceId}" is not connected.`,
      );
    }

    const requestId = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new NexowireError(
            'AGENT_TIMEOUT',
            `Agent request timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        deviceId,
        resolve,
        reject,
        timer,
      });

      try {
        connection.socket.send(
          JSON.stringify({
            type: 'request',
            requestId,
            capability,
            input,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private handleMessage(deviceId: string, raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }

    const parsed = AgentResponseSchema.safeParse(decoded);
    if (!parsed.success) return;

    const pending = this.pending.get(parsed.data.requestId);
    if (!pending || pending.deviceId !== deviceId) return;

    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.requestId);

    if (parsed.data.ok) {
      pending.resolve(parsed.data.data);
      return;
    }

    pending.reject(
      new NexowireError(
        parsed.data.error?.code ?? 'AGENT_ERROR',
        parsed.data.error?.message ?? 'Agent operation failed.',
        parsed.data.error?.details,
      ),
    );
  }

  private handleDisconnect(deviceId: string, socket: WebSocket): void {
    const current = this.agents.get(deviceId);
    if (current?.socket !== socket) return;

    this.agents.delete(deviceId);
    for (const [requestId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timer);
      pending.reject(
        new NexowireError(
          'AGENT_DISCONNECTED',
          `Agent "${deviceId}" disconnected during an operation.`,
        ),
      );
      this.pending.delete(requestId);
    }
  }
}
