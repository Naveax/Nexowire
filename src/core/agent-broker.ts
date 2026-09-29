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
  private readonly onDeviceState?: (
    event: DeviceStateEvent,
  ) => void | Promise<void>;
  private nextEventSeq = 1;
  private eventBytes = 0;

  constructor(options: AgentBrokerOptions = {}) {
    this.maxEvents = options.maxEvents ?? 5_000;
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024;
    this.onDeviceState = options.onDeviceState;
  }

  register(socket: WebSocket, hello: AgentHello): void {
    const deviceId = hello.device.id;
    const existing = this.agents.get(deviceId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(4001, 'Replaced by a newer connection');
    }

    const connectedAt = new Date().toISOString();
    this.agents.set(deviceId, {
      socket,
      device: hello.device,
      connectedAt,
    });
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
      },
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
