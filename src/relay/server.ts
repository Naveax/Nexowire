import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import {
  assertSafeRelayConfig,
  relayHasTls,
  type NexowireRelayConfig,
} from './config.js';
import { matchesBearerHeader } from '../security/tokens.js';
import { safelyRecordScaleMetric, type ScaleTransportMetrics } from '../ops/scale-transport-metrics.js';

type NodeServer = HttpServer | HttpsServer;

export interface RelayServerHandle {
  server: NodeServer;
  wss: WebSocketServer;
  url: string;
  close(): Promise<void>;
  /** Safe in-process gauges; never exports tokens or payloads. */
  resourceSnapshot(): RelayResourceSnapshot;
}

export interface RelayResourceSnapshot {
  activeConnections: number;
  connectingUpstreams: number;
  startupQueuedBytes: number;
  startupQueuedFrames: number;
  globalMemoryBudgetBytes: number;
  totalReservedBytes: number;
  peakTotalReservedBytes: number;
  connectionReservedBytes: number;
  reservedConnectionSlots: number;
  inflightReservedBytes: number;
  peakInflightReservedBytes: number;
  pendingAdmissions: number;
  pendingUpstreamHandshakes: number;
  budgetRejectionCount: number;
  peakPerConnectionQueuedBytes: number;
  peakPerConnectionInflightBytes: number;
  peakStartupQueuedBytes: number;
  peakStartupQueuedFrames: number;
  outboundBufferedBytes: number;
  overload503Count: number;
  disconnectCodes: Record<string, number>;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 503): void {
  const reason = status === 401 ? 'Unauthorized' :
    status === 404 ? 'Not Found' : 'Service Unavailable';
  socket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\n' +
    'Connection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n' +
    (status === 503 ? 'Retry-After: 1\r\n' : '') + '\r\n');
}

function closePeer(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    try {
      socket.close(code, reason.slice(0, 120));
    } catch {
      socket.terminate();
    }
  }
}

/** Accounting bound, not a guarantee about TLS, V8 or kernel socket RSS. */
type ReservationKind = 'connection' | 'queue' | 'inflight';
const PAIR_RESERVATION_BYTES = 64 * 1024;
const DEFAULT_GLOBAL_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
class RelayMemoryBudget {
  private readonly values: Record<ReservationKind, number> = {
    connection: 0, queue: 0, inflight: 0,
  };
  private readonly peaks: Record<ReservationKind, number> = {
    connection: 0, queue: 0, inflight: 0,
  };
  peakTotalReservedBytes = 0;
  constructor(readonly limitBytes: number) {}
  get connectionBytes(): number { return this.values.connection; }
  get queueBytes(): number { return this.values.queue; }
  get inflightBytes(): number { return this.values.inflight; }
  get peakQueueBytes(): number { return this.peaks.queue; }
  get peakInflightBytes(): number { return this.peaks.inflight; }
  get totalBytes(): number {
    return this.connectionBytes + this.queueBytes + this.inflightBytes;
  }
  reserve(kind: ReservationKind, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid relay reservation');
    if (bytes > this.limitBytes - this.totalBytes) return false;
    this.values[kind] += bytes;
    this.peaks[kind] = Math.max(this.peaks[kind], this.values[kind]);
    this.peakTotalReservedBytes = Math.max(this.peakTotalReservedBytes, this.totalBytes);
    return true;
  }
  release(kind: ReservationKind, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.values[kind]) {
      throw new Error('Relay memory reservation underflow: ' + kind);
    }
    this.values[kind] -= bytes;
  }
}

function wireRelayPair(
  downstream: WebSocket,
  upstream: WebSocket,
  options: {
    maxPayloadBytes: number;
    heartbeatMs: number;
    metrics?: ScaleTransportMetrics;
    onQueueDelta: (bytes: number, frames: number) => boolean;
    onInflightReserve: (bytes: number) => boolean;
    onInflightRelease: (bytes: number) => void;
    onPairLevels: (queuedBytes: number, inflightBytes: number) => void;
    onDownstreamClose?: (code: number) => void;
  },
): () => void {
  const queue: Array<{
    data: WebSocket.RawData;
    binary: boolean;
    bytes: number;
  }> = [];
  let queuedBytes = 0;
  let inflightBytes = 0;
  const inflight = new Set<{ bytes: number }>();
  const completeFlight = (entry: { bytes: number }): void => {
    if (!inflight.delete(entry)) return;
    inflightBytes -= entry.bytes;
    options.onInflightRelease(entry.bytes);
    options.onPairLevels(queuedBytes, inflightBytes);
  };
  // A slow upstream must not reserve 2 x 64-MiB payload per pending peer.
  const maxStartupQueueBytes = Math.min(options.maxPayloadBytes * 2, 2 * 1024 * 1024);
  let disposed = false;
  let downstreamAlive = true;
  let upstreamAlive = true;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    // Release retained frames even when a peer dies during handshake.
    if (queuedBytes > 0) options.onQueueDelta(-queuedBytes, -queue.length);
    queuedBytes = 0;
    queue.length = 0;
    for (const entry of inflight) completeFlight(entry);
    options.onPairLevels(queuedBytes, inflightBytes);
  };

  const failPair = (code: number, reason: string): void => {
    // Guard against already-buffered frames racing with WebSocket close events.
    dispose();
    closePeer(downstream, code, reason);
    closePeer(upstream, code, reason);
  };

  const forward = (
    destination: WebSocket,
    data: WebSocket.RawData,
    binary: boolean,
  ): void => {
    if (disposed || destination.readyState !== WebSocket.OPEN) return;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) :
      data instanceof ArrayBuffer ? data.byteLength :
      Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data.length;
    if (destination.bufferedAmount + bytes > options.maxPayloadBytes * 2) {
      failPair(1013, 'Relay peer backpressure limit');
      return;
    }
    if (!options.onInflightReserve(bytes)) {
      failPair(1013, 'Relay global memory budget exceeded');
      return;
    }
    const entry = { bytes };
    inflight.add(entry);
    inflightBytes += bytes;
    options.onPairLevels(queuedBytes, inflightBytes);
    try {
      destination.send(data, { binary }, (error) => {
        completeFlight(entry);
        if (error && !disposed) failPair(1011, 'Relay forwarding error');
      });
    } catch {
      completeFlight(entry);
      failPair(1011, 'Relay forwarding error');
      return;
    }
    safelyRecordScaleMetric(options.metrics,
      destination === upstream ? 'relay.upstream_frames' : 'relay.downstream_frames', bytes);
  };

  downstream.on('pong', () => {
    downstreamAlive = true;
  });
  upstream.on('pong', () => {
    upstreamAlive = true;
  });

  downstream.on('message', (data, binary) => {
    if (disposed || downstream.readyState !== WebSocket.OPEN) return;
    const bytes =
      typeof data === 'string'
        ? Buffer.byteLength(data)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : Array.isArray(data)
            ? data.reduce((sum, part) => sum + part.length, 0)
            : data.length;

    if (bytes > options.maxPayloadBytes) {
      closePeer(downstream, 1009, 'Relay payload too large');
      closePeer(upstream, 1009, 'Relay payload too large');
      return;
    }

    if (upstream.readyState !== WebSocket.OPEN) {
      if (queue.length >= 64 || queuedBytes + bytes > maxStartupQueueBytes) {
        failPair(1013, 'Relay startup queue limit');
        return;
      }
      if (!options.onQueueDelta(bytes, 1)) {
        failPair(1013, 'Relay global memory budget exceeded');
        return;
      }
      queuedBytes += bytes;
      queue.push({ data, binary, bytes });
      options.onPairLevels(queuedBytes, inflightBytes);
      return;
    }

    forward(upstream, data, binary);
  });

  upstream.on('open', () => {
    if (disposed) return;
    while (queue.length && !disposed) {
      const item = queue.shift()!;
      queuedBytes -= item.bytes;
      options.onQueueDelta(-item.bytes, -1);
      options.onPairLevels(queuedBytes, inflightBytes);
      if (upstream.readyState !== WebSocket.OPEN) break;
      forward(upstream, item.data, item.binary);
    }
  });

  upstream.on('message', (data, binary) => {
    if (disposed) return;
    forward(downstream, data, binary);
  });

  downstream.once('close', (code, reason) => {
    dispose();
    options.onDownstreamClose?.(code);
    closePeer(
      upstream,
      code >= 1000 && code <= 4999 ? code : 1001,
      reason.toString() || 'Relay downstream closed',
    );
  });
  upstream.once('close', (code, reason) => {
    dispose();
    closePeer(
      downstream,
      code >= 1000 && code <= 4999 ? code : 1011,
      reason.toString() || 'Relay upstream closed',
    );
  });
  downstream.once('error', () => {
    closePeer(upstream, 1011, 'Relay downstream error');
  });
  upstream.once('error', () => {
    closePeer(downstream, 1011, 'Relay upstream error');
  });

  const heartbeat = setInterval(() => {
    if (!downstreamAlive) downstream.terminate();
    if (!upstreamAlive) upstream.terminate();
    downstreamAlive = false;
    upstreamAlive = false;

    if (downstream.readyState === WebSocket.OPEN) {
      try {
        downstream.ping();
      } catch {
        downstream.terminate();
      }
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.ping();
      } catch {
        upstream.terminate();
      }
    }
  }, options.heartbeatMs);
  heartbeat.unref();

  return dispose;
}

export async function startRelayServer(
  config: NexowireRelayConfig,
  options: { metrics?: ScaleTransportMetrics } = {},
): Promise<RelayServerHandle> {
  assertSafeRelayConfig(config);

  const server: NodeServer = relayHasTls(config)
    ? createHttpsServer({
        cert: await fs.readFile(config.tlsCertFile!),
        key: await fs.readFile(config.tlsKeyFile!),
        minVersion: 'TLSv1.2',
      })
    : createHttpServer();

  // An upgraded downstream reserves one outbound WebSocket and a bounded
  // startup queue. Do not let unauthenticated/over-budget arrivals allocate it.
  const maxConnections = config.maxConnections ?? 128;
  const maxPendingHandshakes = config.maxPendingUpstreamHandshakes ?? maxConnections;
  const memory = new RelayMemoryBudget(config.globalMemoryBudgetBytes ?? DEFAULT_GLOBAL_MEMORY_BUDGET_BYTES);
  // Incomplete HTTP headers must not hold sockets for Node's long defaults.
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 64;
  const pairs = new Map<WebSocket, WebSocket>();
  const admissionReservations = new WeakMap<WebSocket, () => void>();
  let reservedConnectionSlots = 0;
  let pendingAdmissions = 0;
  let pendingUpstreamHandshakes = 0;
  let startupQueuedFrames = 0;
  let peakStartupQueuedFrames = 0;
  let peakPerConnectionQueuedBytes = 0;
  let peakPerConnectionInflightBytes = 0;
  let budgetRejectionCount = 0;
  let overload503Count = 0;
  const disconnectCodes = new Map<string, number>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  // Ordinary GET requests are not a relay API and must never hang.
  server.on('request', (_req, res) => {
    res.writeHead(404, {
      'connection': 'close', 'content-length': '0', 'cache-control': 'no-store',
    });
    res.end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  });

  server.on('upgrade', (request, socket, head) => {
    if (closing) { overload503Count++; rejectUpgrade(socket, 503); return; }
    // Reject queries and arbitrary paths before opening an upstream socket.
    if (request.url !== '/agent') { rejectUpgrade(socket, 404); return; }

    const authenticated =
      config.inboundAgentTokens.length > 0
        ? matchesBearerHeader(
            request.headers.authorization,
            config.inboundAgentTokens,
          )
        : isLoopbackAddress(request.socket.remoteAddress);

    if (!authenticated) {
      safelyRecordScaleMetric(options.metrics, 'relay.auth_denials');
      rejectUpgrade(socket, 401);
      return;
    }
    if (reservedConnectionSlots >= maxConnections ||
        pendingUpstreamHandshakes >= maxPendingHandshakes ||
        !memory.reserve('connection', PAIR_RESERVATION_BYTES)) {
      overload503Count++;
      rejectUpgrade(socket, 503);
      return;
    }
    reservedConnectionSlots++;
    pendingAdmissions++;
    let transferred = false;
    let released = false;
    const releaseSlot = (): void => {
      if (released) return;
      released = true;
      reservedConnectionSlots--;
      memory.release('connection', PAIR_RESERVATION_BYTES);
    };
    const onRawClose = (): void => {
      if (transferred) return;
      transferred = true;
      pendingAdmissions--;
      releaseSlot();
    };
    socket.once('close', onRawClose);
    try {
      wss.handleUpgrade(request, socket, head, downstream => {
        transferred = true;
        pendingAdmissions--;
        socket.off('close', onRawClose);
        admissionReservations.set(downstream, releaseSlot);
        wss.emit('connection', downstream, request);
      });
    } catch {
      if (!transferred) onRawClose();
      // Listener exceptions must never strand an admission reservation.
      else releaseSlot();
      socket.destroy();
    }
  });

  wss.on('connection', (downstream: WebSocket) => {
    safelyRecordScaleMetric(options.metrics, 'relay.connections');
    const headers = config.upstreamAgentToken
      ? {
          Authorization:
            'Bearer ' + config.upstreamAgentToken,
        }
      : undefined;

    const releaseSlot = admissionReservations.get(downstream);
    if (!releaseSlot) { downstream.terminate(); return; }
    const upstream = new WebSocket(config.upstreamWsUrl, {
      ...(headers ? { headers } : {}),
      handshakeTimeout: config.upstreamHandshakeTimeoutMs ?? 10_000,
      maxPayload: config.maxPayloadBytes,
      perMessageDeflate: false,
    });
    pairs.set(downstream, upstream);
    let downstreamClosed = false;
    let upstreamClosed = false;
    let finalized = false;
    const finalize = (): void => {
      if (finalized || !downstreamClosed || !upstreamClosed) return;
      finalized = true;
      pairs.delete(downstream);
      releaseSlot();
    };
    downstream.once('close', () => { downstreamClosed = true; finalize(); });
    upstream.once('close', () => { upstreamClosed = true; finalize(); });
    let pendingHandshake = true;
    ++pendingUpstreamHandshakes;
    const finishHandshake = (): void => {
      if (!pendingHandshake) return;
      pendingHandshake = false;
      --pendingUpstreamHandshakes;
    };
    upstream.once('open', finishHandshake);
    upstream.once('error', finishHandshake);
    upstream.once('close', finishHandshake);

    wireRelayPair(downstream, upstream, {
      maxPayloadBytes: config.maxPayloadBytes,
      heartbeatMs: config.heartbeatMs,
      metrics: options.metrics,
      onQueueDelta: (bytes, frames) => {
        if (bytes > 0 && !memory.reserve('queue', bytes)) {
          budgetRejectionCount++;
          return false;
        }
        if (bytes < 0) memory.release('queue', -bytes);
        startupQueuedFrames += frames;
        if (startupQueuedFrames < 0) throw new Error('Relay startup frame reservation underflow');
        peakStartupQueuedFrames = Math.max(peakStartupQueuedFrames, startupQueuedFrames);
        return true;
      },
      onInflightReserve: (bytes) => {
        if (memory.reserve('inflight', bytes)) return true;
        budgetRejectionCount++;
        return false;
      },
      onInflightRelease: (bytes) => { memory.release('inflight', bytes); },
      onPairLevels: (queued, inflight) => {
        peakPerConnectionQueuedBytes = Math.max(peakPerConnectionQueuedBytes, queued);
        peakPerConnectionInflightBytes = Math.max(peakPerConnectionInflightBytes, inflight);
      },
      onDownstreamClose: (code) => {
        const name = String(code);
        disconnectCodes.set(name, (disconnectCodes.get(name) ?? 0) + 1);
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Relay server did not expose a TCP address.');
  }

  const scheme = relayHasTls(config) ? 'wss' : 'ws';
  const host =
    config.host.includes(':') &&
    !config.host.startsWith('[')
      ? '[' + config.host + ']'
      : config.host;
  const url = `${scheme}://${host}:${address.port}/agent`;

  return {
    server,
    wss,
    url,
    resourceSnapshot(): RelayResourceSnapshot {
      let outboundBufferedBytes = 0;
      let connectingUpstreams = 0;
      for (const [downstream, upstream] of pairs) {
        outboundBufferedBytes += downstream.bufferedAmount + upstream.bufferedAmount;
        if (upstream.readyState === WebSocket.CONNECTING) connectingUpstreams++;
      }
      return {
        activeConnections: wss.clients.size,
        connectingUpstreams,
        startupQueuedBytes: memory.queueBytes,
        startupQueuedFrames,
        globalMemoryBudgetBytes: memory.limitBytes,
        totalReservedBytes: memory.totalBytes,
        peakTotalReservedBytes: memory.peakTotalReservedBytes,
        connectionReservedBytes: memory.connectionBytes,
        reservedConnectionSlots,
        inflightReservedBytes: memory.inflightBytes,
        peakInflightReservedBytes: memory.peakInflightBytes,
        pendingAdmissions,
        pendingUpstreamHandshakes,
        budgetRejectionCount,
        peakPerConnectionQueuedBytes,
        peakPerConnectionInflightBytes,
        peakStartupQueuedBytes: memory.peakQueueBytes,
        peakStartupQueuedFrames,
        outboundBufferedBytes,
        overload503Count,
        disconnectCodes: Object.fromEntries(disconnectCodes),
      };
    },
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true;
        for (const [downstream, upstream] of pairs) {
          closePeer(downstream, 1001, 'Relay shutting down');
          closePeer(upstream, 1001, 'Relay shutting down');
        }
        // Uncooperative clients/upstreams cannot hold process shutdown forever.
        const timer = setTimeout(() => {
          for (const [downstream, upstream] of pairs) {
            downstream.terminate();
            upstream.terminate();
          }
          server.closeAllConnections();
        }, config.shutdownGraceMs ?? 1_500);
        timer.unref();
        try {
          await Promise.all([
            new Promise<void>(resolve => wss.close(() => resolve())),
            new Promise<void>(resolve => server.close(() => resolve())),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
    },
  };
}

export async function runRelayServer(
  config: NexowireRelayConfig,
): Promise<never> {
  const handle = await startRelayServer(config);
  process.stdout.write(
    `Nexowire relay listening on ${handle.url} -> ${config.upstreamWsUrl}\n`,
  );

  const stop = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return await new Promise<never>(() => undefined);
}
