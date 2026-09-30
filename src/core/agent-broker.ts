import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  AgentEventSchema,
  AgentResponseSchema,
  type AgentDevice,
  type AgentEvent,
  type AgentHello,
} from '../protocol/agent.js';
import { NexowireError } from './errors.js';
import { isReadOnlyCapability } from '../protocol/capabilities.js';

interface AgentConnection {
  socket: WebSocket;
  device: AgentDevice;
  instanceId: string;
  connectedAt: string;
}

interface PendingRequest {
  requestId: string;
  deviceId: string;
  capability: string;
  input: unknown;
  sentInstanceId: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
}

export interface ConnectedAgent extends AgentDevice {
  instanceId: string;
  connectedAt: string;
}

export interface BrokerEvent {
  seq: number;
  eventId: string;
  deviceId: string;
  topic: string;
  at: string;
  data: unknown;
}

interface StoredBrokerEvent extends BrokerEvent {
  sizeBytes: number;
}

export interface DeviceStateEvent {
  type: 'connected' | 'disconnected';
  device: AgentDevice;
  at: string;
}

export interface AgentBrokerOptions {
  maxEvents?: number;
  maxEventBytes?: number;
  reconnectGraceMs?: number;
  onDeviceState?: (
    event: DeviceStateEvent,
  ) => void | Promise<void>;
}

export interface ReadBrokerEventsInput {
  afterSeq?: number;
  maxEvents?: number;
  waitMs?: number;
  deviceId?: string;
  topics?: string[];
}

export class AgentBroker {
  private readonly agents = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: StoredBrokerEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly reconnectGraceMs: number;
  private readonly onDeviceState?: (
    event: DeviceStateEvent,
  ) => void | Promise<void>;
  private nextEventSeq = 1;
  private eventBytes = 0;

  constructor(options: AgentBrokerOptions = {}) {
    this.maxEvents = options.maxEvents ?? 5_000;
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024;
    this.reconnectGraceMs = Math.min(
      30_000,
      Math.max(250, options.reconnectGraceMs ?? 5_000),
    );
    this.onDeviceState = options.onDeviceState;
  }

  register(socket: WebSocket, hello: AgentHello): void {
    const deviceId = hello.device.id;
    const existing = this.agents.get(deviceId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(4001, 'Replaced by a newer connection');
    }

    const connectedAt = new Date().toISOString();
    const connection: AgentConnection = {
      socket,
      device: hello.device,
      instanceId: hello.instanceId,
      connectedAt,
    };
    this.agents.set(deviceId, connection);
    const continuity = this.resumePending(deviceId, connection);
    this.notifyDeviceState({
      type: 'connected',
      device: hello.device,
      at: connectedAt,
    });
    this.appendEvent(deviceId, {
      eventId: randomUUID(),
      at: connectedAt,
      topic: 'agent.connected',
      data: {
        name: hello.device.name,
        platform: hello.device.platform,
        arch: hello.device.arch,
        agentVersion: hello.device.agentVersion,
        instanceId: hello.instanceId,
        resumedRequests: continuity.resumed,
        rejectedRequests: continuity.rejected,
      },
    });

    socket.on('message', (raw) =>
      this.handleMessage(deviceId, hello.instanceId, raw.toString()),
    );
    socket.on('close', () => this.handleDisconnect(deviceId, socket));
    socket.on('error', () => this.handleDisconnect(deviceId, socket));
  }

  list(): ConnectedAgent[] {
    return [...this.agents.values()]
      .map(({ device, instanceId, connectedAt }) => ({
        ...device,
        instanceId,
        connectedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  has(deviceId: string): boolean {
    const connection = this.agents.get(deviceId);
    return connection?.socket.readyState === WebSocket.OPEN;
  }

  async readEvents(input: ReadBrokerEventsInput = {}) {
    const afterSeq = Math.max(0, input.afterSeq ?? 0);
    const maxEvents = Math.min(1_000, Math.max(1, input.maxEvents ?? 200));
    const waitMs = Math.min(10_000, Math.max(0, input.waitMs ?? 0));
    const topics = input.topics?.length ? new Set(input.topics) : undefined;
    const matches = (event: StoredBrokerEvent): boolean =>
      (!input.deviceId || event.deviceId === input.deviceId) &&
      (!topics || topics.has(event.topic));

    const select = () => {
      const oldestSeq = this.events[0]?.seq ?? this.nextEventSeq;
      const latestSeq = this.nextEventSeq - 1;
      const cursorExpired = afterSeq < oldestSeq - 1;
      const effectiveAfter = cursorExpired ? oldestSeq - 1 : afterSeq;
      const candidates = this.events.filter((event) => event.seq > effectiveAfter);
      const selected: StoredBrokerEvent[] = [];
      let scannedThrough = effectiveAfter;

      for (const event of candidates) {
        scannedThrough = event.seq;
        if (!matches(event)) continue;
        selected.push(event);
        if (selected.length >= maxEvents) break;
      }

      const hitLimit = selected.length >= maxEvents;
      const nextSeq = hitLimit
        ? selected.at(-1)!.seq
        : candidates.at(-1)?.seq ?? effectiveAfter;
      const hasMore = hitLimit
        ? this.events.some((event) => event.seq > nextSeq && matches(event))
        : false;

      return {
        events: selected.map(({ sizeBytes: _sizeBytes, ...event }) => event),
        nextSeq,
        oldestSeq,
        latestSeq,
        cursorExpired,
        hasMore,
        scannedThrough,
      };
    };

    let result = select();
    const deadline = Date.now() + waitMs;
    while (result.events.length === 0 && waitMs > 0 && Date.now() < deadline) {
      const observedSeq = this.nextEventSeq - 1;
      await this.waitForEvent(Math.max(1, deadline - Date.now()), observedSeq);
      result = select();
    }
    return result;
  }

  private notifyDeviceState(event: DeviceStateEvent): void {
    if (!this.onDeviceState) return;
    try {
      const result = this.onDeviceState(event);
      if (
        result &&
        typeof (result as Promise<void>).catch === 'function'
      ) {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Device-directory persistence must never break transport control.
    }
  }

  private appendEvent(
    deviceId: string,
    event: Omit<AgentEvent, 'type'>,
  ): void {
    const stored: StoredBrokerEvent = {
      seq: this.nextEventSeq++,
      eventId: event.eventId,
      deviceId,
      topic: event.topic,
      at: event.at,
      data: event.data,
      sizeBytes: Buffer.byteLength(JSON.stringify(event.data ?? null), 'utf8'),
    };
    this.events.push(stored);
    this.eventBytes += stored.sizeBytes;

    while (
      this.events.length > this.maxEvents ||
      this.eventBytes > this.maxEventBytes
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.eventBytes -= removed.sizeBytes;
    }

    for (const wake of this.eventWaiters) wake();
    this.eventWaiters.clear();
  }

  private async waitForEvent(timeoutMs: number, observedSeq: number): Promise<void> {
    if (this.nextEventSeq - 1 > observedSeq) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.eventWaiters.delete(wake);
        resolve();
      };
      this.eventWaiters.add(wake);
      timer = setTimeout(wake, timeoutMs);
      if (this.nextEventSeq - 1 > observedSeq) wake();
    });
  }

  async request(
    deviceId: string,
    capability: string,
    input: unknown,
    timeoutMs = 60_000,
    requestId: string = randomUUID(),
  ): Promise<unknown> {
    const connection = this.agents.get(deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new NexowireError(
        'AGENT_OFFLINE',
        `Native agent "${deviceId}" is not connected.`,
      );
    }

    if (this.pending.has(requestId)) {
      throw new NexowireError(
        'AGENT_REQUEST_EXISTS',
        `Agent request "${requestId}" is already pending.`,
      );
    }

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          requestId,
          new NexowireError(
            'AGENT_TIMEOUT',
            `Agent request timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      const pending: PendingRequest = {
        requestId,
        deviceId,
        capability,
        input,
        sentInstanceId: connection.instanceId,
        resolve,
        reject,
        timer,
      };
      this.pending.set(requestId, pending);

      try {
        this.sendPending(connection, pending);
      } catch (error) {
        this.rejectPending(requestId, error);
      }
    });
  }

  private handleMessage(
    deviceId: string,
    instanceId: string,
    raw: string,
  ): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }

    const event = AgentEventSchema.safeParse(decoded);
    if (event.success) {
      const { type: _type, ...payload } = event.data;
      this.appendEvent(deviceId, payload);
      return;
    }

    const parsed = AgentResponseSchema.safeParse(decoded);
    if (!parsed.success) return;

    const pending = this.pending.get(parsed.data.requestId);
    if (!pending || pending.deviceId !== deviceId) return;
    if (
      pending.sentInstanceId !== instanceId &&
      !isReadOnlyCapability(pending.capability)
    ) {
      return;
    }

    this.finishPending(parsed.data.requestId);

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
    const disconnectedAt = new Date().toISOString();
    this.notifyDeviceState({
      type: 'disconnected',
      device: current.device,
      at: disconnectedAt,
    });
    this.appendEvent(deviceId, {
      eventId: randomUUID(),
      at: disconnectedAt,
      topic: 'agent.disconnected',
      data: { name: current.device.name },
    });
    for (const pending of this.pending.values()) {
      if (pending.deviceId !== deviceId || pending.reconnectTimer) continue;
      pending.reconnectTimer = setTimeout(() => {
        this.rejectPending(
          pending.requestId,
          new NexowireError(
            'AGENT_RECONNECT_TIMEOUT',
            `Agent "${deviceId}" did not reconnect within ${this.reconnectGraceMs}ms while an operation was pending.`,
            {
              deviceId,
              capability: pending.capability,
              sentInstanceId: pending.sentInstanceId,
            },
          ),
        );
      }, this.reconnectGraceMs);
    }
  }

  private resumePending(
    deviceId: string,
    connection: AgentConnection,
  ): { resumed: number; rejected: number } {
    let resumed = 0;
    let rejected = 0;

    for (const pending of [...this.pending.values()]) {
      if (pending.deviceId !== deviceId) continue;

      const sameInstance =
        pending.sentInstanceId === connection.instanceId;
      if (!sameInstance && !isReadOnlyCapability(pending.capability)) {
        this.rejectPending(
          pending.requestId,
          new NexowireError(
            'AGENT_INSTANCE_CHANGED',
            `Agent "${deviceId}" restarted while mutation "${pending.capability}" had unknown final state.`,
            {
              deviceId,
              capability: pending.capability,
              previousInstanceId: pending.sentInstanceId,
              currentInstanceId: connection.instanceId,
            },
          ),
        );
        rejected++;
        continue;
      }

      if (pending.reconnectTimer) {
        clearTimeout(pending.reconnectTimer);
        pending.reconnectTimer = undefined;
      }
      pending.sentInstanceId = connection.instanceId;

      try {
        this.sendPending(connection, pending);
        resumed++;
      } catch (error) {
        this.rejectPending(pending.requestId, error);
        rejected++;
      }
    }

    return { resumed, rejected };
  }

  private sendPending(
    connection: AgentConnection,
    pending: PendingRequest,
  ): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new NexowireError(
        'AGENT_OFFLINE',
        `Native agent "${pending.deviceId}" is not connected.`,
      );
    }

    connection.socket.send(
      JSON.stringify({
        type: 'request',
        requestId: pending.requestId,
        capability: pending.capability,
        input: pending.input,
      }),
    );
  }

  private finishPending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    if (pending.reconnectTimer) clearTimeout(pending.reconnectTimer);
    this.pending.delete(requestId);
    return pending;
  }

  private rejectPending(requestId: string, error: unknown): void {
    const pending = this.finishPending(requestId);
    if (!pending) return;
    pending.reject(error);
  }
}
