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
import { safelyRecordScaleMetric, type ScaleTransportMetrics } from '../ops/scale-transport-metrics.js';

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
  accessMode: 'safe' | 'full';
  sentInstanceId: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  readOnlyReplays: number;
}

// Hub-local, redacted transport observations. No credential or payload data.
export interface AgentConnectionHealth {
  deviceId: string;
  online: boolean;
  transport: 'websocket';
  epoch: number;
  reconnectCount: number;
  pingCount: number;
  pongCount: number;
  lastAgentAckAt?: string;
  lastSuccessfulAgentAckAt?: string;
  lastAgentAckOk?: boolean;
  lastConnectedAt: string;
  lastDisconnectedAt?: string;
  lastDisconnectReason?: 'socket_closed' | 'socket_error' | 'heartbeat_timeout' | 'replaced';
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
  maxReadOnlyReplays?: number;
  metrics?: ScaleTransportMetrics;
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
  private readonly healthByDevice = new Map<string, AgentConnectionHealth>();
  private readonly socketDeviceIds = new WeakMap<WebSocket, string>();
  private readonly heartbeatTimedOut = new WeakSet<WebSocket>();
  private readonly events: StoredBrokerEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly reconnectGraceMs: number;
  private readonly maxReadOnlyReplays: number;
  private readonly metrics?: ScaleTransportMetrics;
  private readonly onDeviceState?: (
    event: DeviceStateEvent,
  ) => void | Promise<void>;
  private nextEventSeq = 1;
  private eventBytes = 0;

  constructor(options: AgentBrokerOptions = {}) {
    this.maxEvents = options.maxEvents ?? 5_000;
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024;
    this.metrics = options.metrics;
    this.reconnectGraceMs = Math.min(
      30_000,
      Math.max(250, options.reconnectGraceMs ?? 5_000),
    );
    this.maxReadOnlyReplays = Math.min(5, Math.max(0, options.maxReadOnlyReplays ?? 2));
    this.onDeviceState = options.onDeviceState;
  }

  register(socket: WebSocket, hello: AgentHello): void {
    const deviceId = hello.device.id;
    const existing = this.agents.get(deviceId);
    if (existing && existing.socket !== socket) {
      this.recordDisconnectReason(deviceId, 'replaced');
      existing.socket.close(4001, 'Replaced by a newer connection');
    }

    const connectedAt = new Date().toISOString();
    const previous = this.healthByDevice.get(deviceId);
    // Bounded, best-effort telemetry: evict the oldest snapshot first.
    if (!previous && this.healthByDevice.size >= 2_048) {
      const oldest = this.healthByDevice.keys().next().value;
      if (oldest !== undefined) this.healthByDevice.delete(oldest);
    }
    const reconnectCount = (previous?.reconnectCount ?? 0) + (previous ? 1 : 0);
    this.healthByDevice.set(deviceId, {
      deviceId,
      online: true,
      transport: 'websocket',
      epoch: (previous?.epoch ?? 0) + 1,
      reconnectCount,
      pingCount: previous?.pingCount ?? 0,
      pongCount: previous?.pongCount ?? 0,
      lastConnectedAt: connectedAt,
      ...(previous?.lastAgentAckAt ? { lastAgentAckAt: previous.lastAgentAckAt } : {}),
      ...(previous?.lastSuccessfulAgentAckAt ? { lastSuccessfulAgentAckAt: previous.lastSuccessfulAgentAckAt } : {}),
      ...(previous?.lastAgentAckOk !== undefined ? { lastAgentAckOk: previous.lastAgentAckOk } : {}),
      ...(previous?.lastDisconnectReason ? { lastDisconnectReason: previous.lastDisconnectReason } : {}),
      ...(previous?.lastDisconnectedAt ? { lastDisconnectedAt: previous.lastDisconnectedAt } : {}),
    });
    if (previous) safelyRecordScaleMetric(this.metrics, 'agent.reconnects');
    this.socketDeviceIds.set(socket, deviceId);
    const connection: AgentConnection = {
      socket,
      device: hello.device,
      instanceId: hello.instanceId,
      connectedAt,
    };
    this.agents.set(deviceId, connection);
    safelyRecordScaleMetric(this.metrics, 'agent.connections');
    const continuity = this.resumePending(deviceId, connection);
    safelyRecordScaleMetric(this.metrics, 'agent.resumed_requests', 0, continuity.resumed);
    safelyRecordScaleMetric(this.metrics, 'agent.rejected_requests', 0, continuity.rejected);
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

    socket.on('message', (raw) => {
      const message = raw.toString();
      safelyRecordScaleMetric(this.metrics, 'agent.rx_frames', Buffer.byteLength(message));
      this.handleMessage(deviceId, socket, message);
    });
    socket.on('pong', () => this.noteHeartbeatPong(socket));
    socket.on('close', () => this.handleDisconnect(deviceId, socket, 'socket_closed'));
    socket.on('error', () => this.handleDisconnect(deviceId, socket, 'socket_error'));
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

  getConnectionHealth(deviceId: string): AgentConnectionHealth | undefined {
    const health = this.healthByDevice.get(deviceId);
    return health ? { ...health } : undefined;
  }

  noteHeartbeatPing(socket: WebSocket): void {
    const deviceId = this.socketDeviceIds.get(socket);
    if (!deviceId || this.agents.get(deviceId)?.socket !== socket) return;
    const health = this.healthByDevice.get(deviceId);
    if (!health) return;
    health.pingCount++;
    safelyRecordScaleMetric(this.metrics, 'agent.heartbeat_pings');
  }

  noteHeartbeatTimeout(socket: WebSocket): void {
    const deviceId = this.socketDeviceIds.get(socket);
    if (deviceId && this.agents.get(deviceId)?.socket === socket) {
      this.heartbeatTimedOut.add(socket);
      this.recordDisconnectReason(deviceId, 'heartbeat_timeout');
    }
  }

  private noteHeartbeatPong(socket: WebSocket): void {
    const deviceId = this.socketDeviceIds.get(socket);
    if (!deviceId || this.agents.get(deviceId)?.socket !== socket) return;
    const health = this.healthByDevice.get(deviceId);
    if (!health) return;
    health.pongCount++;
    safelyRecordScaleMetric(this.metrics, 'agent.heartbeat_pongs');
  }

  private recordDisconnectReason(
    deviceId: string,
    reason: AgentConnectionHealth['lastDisconnectReason'],
  ): void {
    const health = this.healthByDevice.get(deviceId);
    if (health) health.lastDisconnectReason = reason;
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
    accessMode: 'safe' | 'full' = 'safe',
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
        const mutation = !isReadOnlyCapability(capability);
        this.rejectPending(
          requestId,
          new NexowireError(
            mutation ? 'MUTATION_STATE_UNKNOWN' : 'AGENT_TIMEOUT',
            mutation
              ? 'Agent acknowledgement timed out; mutation outcome is unknown. Reconcile by request ID, never blindly replay.'
              : 'Read-only agent request timed out.',
            { deviceId, capability, requestId, reason: 'ack_timeout' },
          ),
        );
      }, timeoutMs);

      const pending: PendingRequest = {
        requestId,
        deviceId,
        capability,
        input,
        accessMode,
        sentInstanceId: connection.instanceId,
        readOnlyReplays: 0,
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
    socket: WebSocket,
    raw: string,
  ): void {
    // Replaced sockets must not deliver stale ACKs or events.
    const current = this.agents.get(deviceId);
    if (!current || current.socket !== socket) return;
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
      pending.sentInstanceId !== current.instanceId
    ) {
      return;
    }

    this.finishPending(parsed.data.requestId);
    const health = this.healthByDevice.get(deviceId);
    if (health) {
      health.lastAgentAckAt = new Date().toISOString();
      if (parsed.data.ok) health.lastSuccessfulAgentAckAt = health.lastAgentAckAt;
      health.lastAgentAckOk = parsed.data.ok;
    }
    safelyRecordScaleMetric(this.metrics, 'agent.ack_responses');

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

  private handleDisconnect(
    deviceId: string,
    socket: WebSocket,
    reason: 'socket_closed' | 'socket_error',
  ): void {
    const current = this.agents.get(deviceId);
    if (current?.socket !== socket) return;

    this.agents.delete(deviceId);
    const health = this.healthByDevice.get(deviceId);
    if (health) {
      health.online = false;
      health.lastDisconnectedAt = new Date().toISOString();
      health.lastDisconnectReason = this.heartbeatTimedOut.has(socket)
        ? 'heartbeat_timeout'
        : reason;
    }
    safelyRecordScaleMetric(this.metrics, 'agent.disconnections');
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
            isReadOnlyCapability(pending.capability)
              ? 'AGENT_RECONNECT_TIMEOUT'
              : 'MUTATION_STATE_UNKNOWN',
            'Agent did not reconnect before the grace deadline; request outcome must be reconciled before any mutation retry.',
            {
              deviceId,
              requestId: pending.requestId,
              capability: pending.capability,
              reason: 'reconnect_grace_expired',
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
      // No mutation replay, even across reconnects of the SAME instance.
      if (!isReadOnlyCapability(pending.capability)) {
        this.rejectPending(
          pending.requestId,
          new NexowireError(
            sameInstance ? 'MUTATION_STATE_UNKNOWN' : 'AGENT_INSTANCE_CHANGED',
            'Agent connection changed before mutation acknowledgement. Reconcile request ID before any retry.',
            {
              deviceId,
              requestId: pending.requestId,
              capability: pending.capability,
              reason: sameInstance ? 'connection_replaced' : 'instance_changed',
            },
          ),
        );
        rejected++;
        continue;
      }

      if (pending.readOnlyReplays >= this.maxReadOnlyReplays) {
        this.rejectPending(
          pending.requestId,
          new NexowireError(
            'AGENT_RETRY_LIMIT',
            'Read-only request exceeded bounded reconnect replay budget.',
            { deviceId, requestId: pending.requestId, capability: pending.capability },
          ),
        );
        rejected++;
        continue;
      }

      if (!connection.device.capabilities.includes(pending.capability)) {
        this.rejectPending(
          pending.requestId,
          new NexowireError(
            'AGENT_CAPABILITY_CHANGED',
            `Agent "${deviceId}" reconnected without pending capability "${pending.capability}".`,
            {
              deviceId,
              capability: pending.capability,
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
      pending.readOnlyReplays++;

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

    const encoded = JSON.stringify({
      type: 'request',
      requestId: pending.requestId,
      capability: pending.capability,
      input: pending.input,
      accessMode: pending.accessMode,
    });
    connection.socket.send(encoded);
    safelyRecordScaleMetric(this.metrics, 'agent.tx_frames', Buffer.byteLength(encoded));
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
