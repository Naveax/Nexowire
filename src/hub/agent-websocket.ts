import type { Server as HttpServer, IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentBroker } from '../core/agent-broker.js';
import { AgentHelloSchema } from '../protocol/agent.js';

function bearerFrom(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export interface AgentWebSocketServerOptions {
  heartbeatMs?: number;
  helloTimeoutMs?: number;
}

export function attachAgentWebSocketServer(
  server: HttpServer,
  broker: AgentBroker,
  agentToken?: string,
  options: AgentWebSocketServerOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 30_000);
  const helloTimeoutMs = Math.max(1_000, options.helloTimeoutMs ?? 5_000);
  const alive = new WeakSet<WebSocket>();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent') return;

    const authenticated = agentToken
      ? bearerFrom(request) === agentToken
      : isLoopbackAddress(request.socket.remoteAddress);

    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));

    const timer = setTimeout(() => {
      socket.close(1008, 'Agent hello timeout');
    }, helloTimeoutMs);

    socket.once('message', (raw) => {
      clearTimeout(timer);
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'Invalid JSON');
        return;
      }

      const hello = AgentHelloSchema.safeParse(decoded);
      if (!hello.success) {
        socket.close(1008, 'Invalid agent hello');
        return;
      }

      broker.register(socket, hello.data);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
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
  heartbeat.unref();

  wss.once('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}
