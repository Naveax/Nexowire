import type { Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentBroker } from '../core/agent-broker.js';
import { AgentHelloSchema } from '../protocol/agent.js';
import { parseTokenList } from '../security/tokens.js';
import { authorizeBearer } from '../security/auth.js';
import type { CredentialStore } from '../security/credential-store.js';
import type { RemoteAgentAuthorization } from './control-plane-agent-auth.js';

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
  credentialStore?: CredentialStore;
  remoteCredentialVerifier?: (
    authorizationHeader: string | undefined,
  ) => Promise<RemoteAgentAuthorization | undefined>;
}

export function attachAgentWebSocketServer(
  server: HttpServer,
  broker: AgentBroker,
  agentTokens?: string | readonly string[],
  options: AgentWebSocketServerOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeatMs = Math.max(250, options.heartbeatMs ?? 30_000);
  const helloTimeoutMs = Math.max(250, options.helloTimeoutMs ?? 5_000);
  const alive = new WeakSet<WebSocket>();
  const configuredAgentTokens =
    typeof agentTokens === 'string'
      ? parseTokenList(agentTokens)
      : parseTokenList(...(agentTokens ?? []));

  const remotelyAuthorizedDeviceIds =
    new WeakMap<WebSocket, string>();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent') return;

    void (async () => {
      const localAuthConfigured =
        configuredAgentTokens.length > 0 ||
        options.credentialStore?.hasConfigured('agent') === true;
      const remoteAuthConfigured =
        options.remoteCredentialVerifier !== undefined;
      const authRequired =
        localAuthConfigured || remoteAuthConfigured;

      const locallyAuthenticated = localAuthConfigured
        ? authorizeBearer(
            request.headers.authorization,
            'agent',
            configuredAgentTokens,
            options.credentialStore,
          )
        : false;

      const remoteAuthorization =
        !locallyAuthenticated &&
        options.remoteCredentialVerifier
          ? await options.remoteCredentialVerifier(
              request.headers.authorization,
            )
          : undefined;

      const authenticated = authRequired
        ? locallyAuthenticated || Boolean(remoteAuthorization)
        : isLoopbackAddress(request.socket.remoteAddress);

      if (!authenticated) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        if (remoteAuthorization) {
          remotelyAuthorizedDeviceIds.set(
            ws,
            remoteAuthorization.deviceId,
          );
        }
        wss.emit('connection', ws, request);
      });
    })().catch(() => {
      if (!socket.destroyed) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
      }
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

      const authorizedDeviceId =
        remotelyAuthorizedDeviceIds.get(socket);
      if (
        authorizedDeviceId &&
        hello.data.device.id !== authorizedDeviceId
      ) {
        socket.close(
          1008,
          'Agent credential does not match device identity',
        );
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
