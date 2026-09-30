import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import type { Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import {
  assertSafeRelayConfig,
  relayHasTls,
  type NexowireRelayConfig,
} from './config.js';
import { matchesBearerHeader } from '../security/tokens.js';

type NodeServer = HttpServer | HttpsServer;

export interface RelayServerHandle {
  server: NodeServer;
  wss: WebSocketServer;
  url: string;
  close(): Promise<void>;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
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

function wireRelayPair(
  downstream: WebSocket,
  upstream: WebSocket,
  options: {
    maxPayloadBytes: number;
    heartbeatMs: number;
  },
): () => void {
  const queue: Array<{
    data: WebSocket.RawData;
    binary: boolean;
    bytes: number;
  }> = [];
  let queuedBytes = 0;
  let disposed = false;
  let downstreamAlive = true;
  let upstreamAlive = true;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
  };

  const forward = (
    destination: WebSocket,
    data: WebSocket.RawData,
    binary: boolean,
  ): void => {
    if (destination.readyState !== WebSocket.OPEN) return;
    if (
      destination.bufferedAmount >
      options.maxPayloadBytes * 2
    ) {
      closePeer(destination, 1013, 'Relay backpressure limit');
      return;
    }
    destination.send(data, { binary }, (error) => {
      if (error) {
        closePeer(destination, 1011, 'Relay forwarding error');
      }
    });
  };

  downstream.on('pong', () => {
    downstreamAlive = true;
  });
  upstream.on('pong', () => {
    upstreamAlive = true;
  });

  downstream.on('message', (data, binary) => {
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
      queuedBytes += bytes;
      if (
        queue.length >= 64 ||
        queuedBytes > options.maxPayloadBytes * 2
      ) {
        closePeer(downstream, 1013, 'Relay startup queue limit');
        closePeer(upstream, 1013, 'Relay startup queue limit');
        return;
      }
      queue.push({ data, binary, bytes });
      return;
    }

    forward(upstream, data, binary);
  });

  upstream.on('open', () => {
    for (const item of queue.splice(0)) {
      queuedBytes -= item.bytes;
      forward(upstream, item.data, item.binary);
    }
    queuedBytes = 0;
  });

  upstream.on('message', (data, binary) => {
    forward(downstream, data, binary);
  });

  downstream.once('close', (code, reason) => {
    dispose();
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
): Promise<RelayServerHandle> {
  assertSafeRelayConfig(config);

  const server: NodeServer = relayHasTls(config)
    ? createHttpsServer({
        cert: await fs.readFile(config.tlsCertFile!),
        key: await fs.readFile(config.tlsKeyFile!),
        minVersion: 'TLSv1.2',
      })
    : createHttpServer();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent') return;

    const authenticated =
      config.inboundAgentTokens.length > 0
        ? matchesBearerHeader(
            request.headers.authorization,
            config.inboundAgentTokens,
          )
        : isLoopbackAddress(request.socket.remoteAddress);

    if (!authenticated) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (downstream) => {
      wss.emit('connection', downstream, request);
    });
  });

  wss.on('connection', (downstream: WebSocket) => {
    const headers = config.upstreamAgentToken
      ? {
          Authorization:
            'Bearer ' + config.upstreamAgentToken,
        }
      : undefined;

    const upstream = new WebSocket(
      config.upstreamWsUrl,
      headers ? { headers } : undefined,
    );

    wireRelayPair(downstream, upstream, {
      maxPayloadBytes: config.maxPayloadBytes,
      heartbeatMs: config.heartbeatMs,
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
    async close(): Promise<void> {
      for (const client of wss.clients) {
        client.close(1001, 'Relay shutting down');
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
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
