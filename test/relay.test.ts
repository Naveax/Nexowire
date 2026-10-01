import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import {
  assertSafeRelayConfig,
  loadRelayConfig,
  type NexowireRelayConfig,
} from '../src/relay/config.js';
import { startRelayServer } from '../src/relay/server.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for relay condition.'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('relay config rejects insecure remote exposure and plaintext remote upstreams', () => {
  const config = loadRelayConfig({
    NEXOWIRE_RELAY_HOST: '0.0.0.0',
    NEXOWIRE_RELAY_PORT: '43111',
    NEXOWIRE_RELAY_AGENT_TOKENS: 'relay-a,relay-b',
    NEXOWIRE_RELAY_UPSTREAM_WS_URL:
      'wss://hub.example.test/agent',
    NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN: 'hub-token',
  });

  assert.throws(
    () => assertSafeRelayConfig(config),
    /plaintext relay transport/i,
  );

  assert.doesNotThrow(() =>
    assertSafeRelayConfig({
      ...config,
      allowInsecureRemote: true,
    }),
  );

  assert.throws(
    () =>
      assertSafeRelayConfig({
        ...config,
        host: '127.0.0.1',
        upstreamWsUrl: 'ws://10.0.0.10:43110/agent',
      }),
    /plaintext non-loopback relay upstream/i,
  );
});

test('first-party relay forwards native-agent protocol bidirectionally', async (t) => {
  const upstreamHttp = createServer();
  const broker = new AgentBroker();
  const upstreamWss = attachAgentWebSocketServer(
    upstreamHttp,
    broker,
    'upstream-agent-token',
    { heartbeatMs: 1_000, helloTimeoutMs: 2_000 },
  );
  await new Promise<void>((resolve) =>
    upstreamHttp.listen(0, '127.0.0.1', resolve),
  );

  const upstreamAddress = upstreamHttp.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

  const relayConfig: NexowireRelayConfig = {
    host: '127.0.0.1',
    port: 0,
    upstreamWsUrl:
      'ws://127.0.0.1:' + upstreamAddress.port + '/agent',
    inboundAgentTokens: ['relay-agent-token'],
    upstreamAgentToken: 'upstream-agent-token',
    heartbeatMs: 1_000,
    maxPayloadBytes: 2 * 1024 * 1024,
  };
  const relay = await startRelayServer(relayConfig);

  t.after(async () => {
    await relay.close();
    for (const client of upstreamWss.clients) {
      client.close();
    }
    await new Promise<void>((resolve) =>
      upstreamWss.close(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      upstreamHttp.close(() => resolve()),
    );
  });

  const agent = new WebSocket(relay.url, {
    headers: {
      Authorization: 'Bearer relay-agent-token',
    },
  });
  t.after(() => agent.close());

  await new Promise<void>((resolve, reject) => {
    agent.once('open', resolve);
    agent.once('error', reject);
  });

  agent.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId: randomUUID(),
      device: {
        id: 'relay-device',
        name: 'Relay Device',
        platform: 'linux',
        arch: 'x64',
        agentVersion: 'relay-test',
        capabilities: ['machine.snapshot'],
      },
    }),
  );

  await waitFor(() => broker.has('relay-device'));

  agent.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as {
      type?: string;
      requestId?: string;
      capability?: string;
    };
    if (
      request.type !== 'request' ||
      typeof request.requestId !== 'string'
    ) {
      return;
    }
    agent.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        data: {
          data: {
            via: 'relay',
            capability: request.capability,
          },
        },
      }),
    );
  });

  const response = (await broker.request(
    'relay-device',
    'machine.snapshot',
    {},
    5_000,
  )) as {
    data?: {
      via?: string;
      capability?: string;
    };
  };

  assert.equal(response.data?.via, 'relay');
  assert.equal(
    response.data?.capability,
    'machine.snapshot',
  );
});

test('relay rejects invalid inbound agent bearer token', async (t) => {
  const upstreamHttp = createServer();
  await new Promise<void>((resolve) =>
    upstreamHttp.listen(0, '127.0.0.1', resolve),
  );
  const upstreamAddress = upstreamHttp.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    upstreamWsUrl:
      'ws://127.0.0.1:' + upstreamAddress.port + '/agent',
    inboundAgentTokens: ['correct-token'],
    heartbeatMs: 1_000,
    maxPayloadBytes: 1024 * 1024,
  });

  t.after(async () => {
    await relay.close();
    await new Promise<void>((resolve) =>
      upstreamHttp.close(() => resolve()),
    );
  });

  const status = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(relay.url, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('open', () => {
      reject(new Error('Relay unexpectedly accepted invalid token.'));
      socket.close();
    });
    socket.once('error', () => {
      // unexpected-response is authoritative for this assertion.
    });
  });

  assert.equal(status, 401);
});

test('relay config can consume platform-backed inbound and upstream credentials', () => {
  const config = loadRelayConfig(
    {
      NEXOWIRE_RELAY_AGENT_TOKEN_PLATFORM_NAME: 'relay-primary',
      NEXOWIRE_RELAY_AGENT_TOKENS_PLATFORM_NAME: 'relay-rotation',
      NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_PLATFORM_NAME: 'upstream-primary',
    },
    {
      platformSingle: (name, purpose) => {
        if (!name) return undefined;
        if (purpose === 'relay-upstream-agent-token') {
          return 'upstream-platform-token';
        }
        return 'relay-platform-token';
      },
      platformList: (name, purpose) => {
        assert.equal(name, 'relay-rotation');
        assert.equal(purpose, 'relay-inbound-agent-token-list');
        return 'relay-old,relay-next';
      },
    },
  );

  assert.deepEqual(config.inboundAgentTokens, [
    'relay-platform-token',
    'relay-old',
    'relay-next',
  ]);
  assert.equal(
    config.upstreamAgentToken,
    'upstream-platform-token',
  );
});

test('relay upstream platform secret conflicts fail closed', () => {
  assert.throws(
    () =>
      loadRelayConfig(
        {
          NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN: 'inline-token',
          NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_PLATFORM_NAME:
            'upstream-primary',
        },
        {
          platformSingle: (name, purpose) => {
            if (!name) return undefined;
            if (purpose === 'relay-upstream-agent-token') {
              return 'different-platform-token';
            }
            return undefined;
          },
          platformList: () => undefined,
        },
      ),
    /multiple secret sources with different contents/i,
  );
});
