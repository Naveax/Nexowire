import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { isLoopbackHost } from '../config.js';
import {
  matchesBearerHeader,
  parseTokenList,
} from '../security/tokens.js';
import {
  HubToRelayMessageSchema,
  RELAY_AGENT_PATH,
  RELAY_HUB_PATH,
} from './protocol.js';

export interface RelayServerOptions {
  host?: string;
  port?: number;
  hubTokens: readonly string[];
  agentTokens: readonly string[];
  tlsCertFile?: string;
  tlsKeyFile?: string;
  allowInsecureRemote?: boolean;
  heartbeatMs?: number;
  maxPayloadBytes?: number;
}

export interface RunningRelayServer {
  host: string;
  port: number;
  secure: boolean;
  hubUrl: string;
  agentUrl: string;
  close(): Promise<void>;
}

type RelayHttpServer = HttpServer | HttpsServer;

function normalizedTokenList(tokens: readonly string[]): string[] {
  return parseTokenList(...tokens);
}

function assertRelaySecurity(options: RelayServerOptions): void {
  if (normalizedTokenList(options.hubTokens).length === 0) {
    throw new Error('Relay hub authentication token is required.');
  }
  if (normalizedTokenList(options.agentTokens).length === 0) {
    throw new Error('Relay agent authentication token is required.');
  }
  if (Boolean(options.tlsCertFile) !== Boolean(options.tlsKeyFile)) {
    throw new Error(
      'Relay TLS certificate and key files must be configured together.',
    );
  }

  const host = options.host ?? '127.0.0.1';
  if (
    !isLoopbackHost(host) &&
    !options.tlsCertFile &&
    !options.allowInsecureRemote
  ) {
    throw new Error(
      'Refusing non-loopback relay plaintext transport without TLS or explicit insecure-private-network override.',
    );
  }
}

function unauthorized(socket: Duplex): void {
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
  );
  socket.destroy();
}

function unavailable(socket: Duplex): void {
  socket.write(
    'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
  );
  socket.destroy();
}

function conflict(socket: Duplex): void {
  socket.write(
    'HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n',
  );
  socket.destroy();
}

function attachHeartbeat(
  sockets: () => Iterable<WebSocket>,
  heartbeatMs: number,
): () => void {
  const alive = new WeakSet<WebSocket>();
  const tracked = new WeakSet<WebSocket>();

  const timer = setInterval(() => {
    for (const socket of sockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;

      if (!tracked.has(socket)) {
        tracked.add(socket);
        alive.add(socket);
        socket.on('pong', () => alive.add(socket));
      }

      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }

      alive.delete(socket);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, heartbeatMs);
  timer.unref();

  return () => clearInterval(timer);
}

export async function startRelayServer(
  options: RelayServerOptions,
): Promise<RunningRelayServer> {
  assertRelaySecurity(options);

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const secure = Boolean(options.tlsCertFile && options.tlsKeyFile);
  const maxPayload = Math.min(
    64 * 1024 * 1024,
    Math.max(1 * 1024 * 1024, options.maxPayloadBytes ?? 32 * 1024 * 1024),
  );
  const heartbeatMs = Math.min(
    120_000,
    Math.max(1_000, options.heartbeatMs ?? 30_000),
  );
  const hubTokens = normalizedTokenList(options.hubTokens);
  const agentTokens = normalizedTokenList(options.agentTokens);

  const requestHandler: import('node:http').RequestListener = (
    request,
    response,
  ) => {
    if (request.url === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(
        JSON.stringify({
          ok: true,
          service: 'nexowire-relay',
          secure,
          hubConnected:
            currentHub?.readyState === WebSocket.OPEN,
          agents: agents.size,
          time: new Date().toISOString(),
        }),
      );
      return;
    }

    response.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ error: 'not_found' }));
  };

  let server: RelayHttpServer;
  if (secure) {
    server = createHttpsServer(
      {
        cert: await readFile(options.tlsCertFile!),
        key: await readFile(options.tlsKeyFile!),
        minVersion: 'TLSv1.2',
      },
      requestHandler,
    );
  } else {
    server = createHttpServer(requestHandler);
  }

  const hubWss = new WebSocketServer({
    noServer: true,
    maxPayload,
  });
  const agentWss = new WebSocketServer({
    noServer: true,
    maxPayload,
  });

  let currentHub: WebSocket | undefined;
  const agents = new Map<string, WebSocket>();

  const closeAgent = (
    connectionId: string,
    code = 1012,
    reason = 'Relay route unavailable',
  ): void => {
    const agent = agents.get(connectionId);
    if (!agent) return;
    agents.delete(connectionId);
    if (
      agent.readyState === WebSocket.OPEN ||
      agent.readyState === WebSocket.CONNECTING
    ) {
      agent.close(code, reason);
    }
  };

  hubWss.on('connection', (hub) => {
    currentHub = hub;

    hub.on('message', (raw) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        hub.close(1008, 'Invalid relay JSON');
        return;
      }

      const parsed = HubToRelayMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        hub.close(1008, 'Invalid relay control message');
        return;
      }

      const agent = agents.get(parsed.data.connectionId);
      if (!agent) return;

      if (parsed.data.type === 'agent.send') {
        if (agent.readyState === WebSocket.OPEN) {
          agent.send(parsed.data.data);
        }
        return;
      }

      closeAgent(
        parsed.data.connectionId,
        parsed.data.code ?? 1000,
        parsed.data.reason ?? 'Closed by hub',
      );
    });

    const closeHub = (): void => {
      if (currentHub !== hub) return;
      currentHub = undefined;
      for (const connectionId of [...agents.keys()]) {
        closeAgent(
          connectionId,
          1012,
          'Relay hub disconnected',
        );
      }
    };

    hub.on('close', closeHub);
    hub.on('error', closeHub);
  });

  agentWss.on('connection', (agent) => {
    const hub = currentHub;
    if (!hub || hub.readyState !== WebSocket.OPEN) {
      agent.close(1013, 'Relay hub unavailable');
      return;
    }

    const connectionId = randomUUID();
    agents.set(connectionId, agent);

    hub.send(
      JSON.stringify({
        type: 'agent.open',
        connectionId,
      }),
    );

    agent.on('message', (raw) => {
      const activeHub = currentHub;
      if (
        activeHub?.readyState !== WebSocket.OPEN ||
        agents.get(connectionId) !== agent
      ) {
        agent.close(1012, 'Relay hub unavailable');
        return;
      }

      const data = raw.toString();
      if (Buffer.byteLength(data, 'utf8') > maxPayload) {
        agent.close(1009, 'Relay message too large');
        return;
      }

      activeHub.send(
        JSON.stringify({
          type: 'agent.message',
          connectionId,
          data,
        }),
      );
    });

    const notifyClose = (code?: number, reason?: Buffer): void => {
      if (agents.get(connectionId) !== agent) return;
      agents.delete(connectionId);
      const activeHub = currentHub;
      if (activeHub?.readyState !== WebSocket.OPEN) return;
      activeHub.send(
        JSON.stringify({
          type: 'agent.close',
          connectionId,
          ...(code ? { code } : {}),
          ...(reason && reason.length > 0
            ? { reason: reason.toString('utf8').slice(0, 1024) }
            : {}),
        }),
      );
    };

    agent.on('close', notifyClose);
    agent.on('error', () => notifyClose());
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === RELAY_HUB_PATH) {
      if (
        !matchesBearerHeader(
          request.headers.authorization,
          hubTokens,
        )
      ) {
        unauthorized(socket);
        return;
      }
      if (currentHub?.readyState === WebSocket.OPEN) {
        conflict(socket);
        return;
      }

      hubWss.handleUpgrade(request, socket, head, (ws) => {
        hubWss.emit('connection', ws, request);
      });
      return;
    }

    if (url.pathname === RELAY_AGENT_PATH) {
      if (
        !matchesBearerHeader(
          request.headers.authorization,
          agentTokens,
        )
      ) {
        unauthorized(socket);
        return;
      }
      if (currentHub?.readyState !== WebSocket.OPEN) {
        unavailable(socket);
        return;
      }

      agentWss.handleUpgrade(request, socket, head, (ws) => {
        agentWss.emit('connection', ws, request);
      });
      return;
    }

    socket.write(
      'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n',
    );
    socket.destroy();
  });

  const stopHeartbeat = attachHeartbeat(
    () => [
      ...(currentHub ? [currentHub] : []),
      ...agents.values(),
    ],
    heartbeatMs,
  );

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
    server.listen(port, host);
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error('Relay server did not publish a listening address.');
  }

  const scheme = secure ? 'wss' : 'ws';
  const urlHost =
    address.address.includes(':')
      ? '[' + address.address + ']'
      : address.address;

  return {
    host: address.address,
    port: address.port,
    secure,
    hubUrl:
      scheme +
      '://' +
      urlHost +
      ':' +
      address.port +
      RELAY_HUB_PATH,
    agentUrl:
      scheme +
      '://' +
      urlHost +
      ':' +
      address.port +
      RELAY_AGENT_PATH,
    close: async () => {
      stopHeartbeat();

      if (currentHub) {
        currentHub.close(1001, 'Relay shutting down');
        currentHub = undefined;
      }
      for (const connectionId of [...agents.keys()]) {
        closeAgent(connectionId, 1001, 'Relay shutting down');
      }

      for (const client of hubWss.clients) {
        client.close(1001, 'Relay shutting down');
      }
      for (const client of agentWss.clients) {
        client.close(1001, 'Relay shutting down');
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      hubWss.close();
      agentWss.close();
    },
  };
}

function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(name + ' is required.');
  }
  return value;
}

export async function runRelayServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const relay = await startRelayServer({
    host: env.NEXOWIRE_RELAY_HOST?.trim() || '127.0.0.1',
    port: Number.parseInt(
      env.NEXOWIRE_RELAY_PORT?.trim() || '43111',
      10,
    ),
    hubTokens: parseTokenList(
      requiredEnv(env, 'NEXOWIRE_RELAY_HUB_TOKEN'),
    ),
    agentTokens: parseTokenList(
      requiredEnv(env, 'NEXOWIRE_RELAY_AGENT_TOKEN'),
    ),
    ...(env.NEXOWIRE_RELAY_TLS_CERT_FILE?.trim()
      ? {
          tlsCertFile:
            env.NEXOWIRE_RELAY_TLS_CERT_FILE.trim(),
        }
      : {}),
    ...(env.NEXOWIRE_RELAY_TLS_KEY_FILE?.trim()
      ? {
          tlsKeyFile:
            env.NEXOWIRE_RELAY_TLS_KEY_FILE.trim(),
        }
      : {}),
    allowInsecureRemote: envFlag(
      env.NEXOWIRE_RELAY_ALLOW_INSECURE_REMOTE,
    ),
  });

  process.stderr.write(
    'Nexowire relay listening on ' +
      relay.hubUrl.replace(RELAY_HUB_PATH, '') +
      '\n',
  );

  const stop = async (): Promise<void> => {
    await relay.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  return await new Promise<never>(() => undefined);
}
