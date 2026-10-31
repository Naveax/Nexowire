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
  authorizationCheckMs?: number;
  authorizationTimeoutMs?: number;
  credentialStore?: CredentialStore;
  remoteCredentialVerifier?: (
    authorizationHeader: string | undefined,
    signal?: AbortSignal,
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
  const authorizationCheckMs = options.authorizationCheckMs ?? 60_000;
  const authorizationTimeoutMs = options.authorizationTimeoutMs ?? 5_000;
  for (const [name,value,min,max] of [
    ['authorizationCheckMs',authorizationCheckMs,250,300_000],
    ['authorizationTimeoutMs',authorizationTimeoutMs,250,10_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  const alive = new WeakSet<WebSocket>();
  const configuredAgentTokens =
    typeof agentTokens === 'string'
      ? parseTokenList(agentTokens)
      : parseTokenList(...(agentTokens ?? []));

  const remotelyAuthorizedDeviceIds =
    new WeakMap<WebSocket, string>();
  const sessionChecks = new WeakMap<WebSocket, () => Promise<boolean>>();

  // Bound even a verifier implementation which ignores cancellation. Late
  // success cannot upgrade a closed socket or resurrect a revoked session.
  async function verifyRemote(header:string|undefined, lifetime:AbortSignal) {
    const controller = new AbortController();
    let timer:NodeJS.Timeout|undefined;
    let onAbort:()=>void = ()=>{};
    try {
      return await Promise.race([
        Promise.resolve().then(()=>options.remoteCredentialVerifier?.(header,controller.signal))
          .catch(()=>undefined),
        new Promise<undefined>(resolve=>{
          onAbort=()=>{controller.abort();resolve(undefined);};
          lifetime.addEventListener('abort',onAbort,{once:true});
          timer=setTimeout(onAbort,authorizationTimeoutMs);
          if(lifetime.aborted)onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      lifetime.removeEventListener('abort',onAbort);
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent') return;
    const lifetime = new AbortController();
    socket.once('close',()=>lifetime.abort());

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
          ? await verifyRemote(
              request.headers.authorization,
              lifetime.signal,
            )
          : undefined;

      const authenticated = authRequired
        ? locallyAuthenticated || Boolean(remoteAuthorization)
        : isLoopbackAddress(request.socket.remoteAddress);

      if(socket.destroyed || lifetime.signal.aborted)return;

      if (!authenticated) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        if (remoteAuthorization) {
          const deviceId=remoteAuthorization.deviceId;
          remotelyAuthorizedDeviceIds.set(
            ws,
            deviceId,
          );
          sessionChecks.set(ws,async()=>
            (await verifyRemote(request.headers.authorization,lifetime.signal))?.deviceId===deviceId);
        } else {
          // Preserve the original trust mode; never turn a revoked credential
          // into anonymous loopback admission or another remote identity.
          sessionChecks.set(ws,async()=>locallyAuthenticated
            ? authorizeBearer(request.headers.authorization,'agent',configuredAgentTokens,options.credentialStore)
            : !configuredAgentTokens.length && !options.credentialStore?.hasConfigured('agent') &&
              !options.remoteCredentialVerifier && isLoopbackAddress(request.socket.remoteAddress));
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
    let closed=false;
    let recheck:NodeJS.Timeout|undefined;
    const schedule=()=>{
      recheck=setTimeout(async()=>{
        let valid=false;
        try {valid=await sessionChecks.get(socket)?.()===true;} catch {}
        if(closed)return;
        if(!valid){socket.terminate();return;}
        schedule();
      },authorizationCheckMs);
      recheck.unref();
    };
    schedule();
    socket.once('close',()=>{closed=true;clearTimeout(recheck);clearTimeout(timer);});
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
        broker.noteHeartbeatTimeout(socket);
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      try {
        socket.ping();
        broker.noteHeartbeatPing(socket);
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
