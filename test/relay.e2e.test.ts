import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { RelayHubClient } from '../src/hub/relay-client.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { startRelayServer } from '../src/relay/server.js';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for relay condition.');
}

test('first-party relay tunnels native agent traffic into AgentBroker', async (t) => {
  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    hubTokens: ['hub-secret'],
    agentTokens: ['agent-secret'],
    heartbeatMs: 1_000,
  });
  const broker = new AgentBroker({ reconnectGraceMs: 250 });
  const hub = new RelayHubClient({
    url: relay.hubUrl,
    token: 'hub-secret',
    broker,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    helloTimeoutMs: 1_000,
  });
  hub.start();

  let agent: WebSocket | undefined;
  t.after(async () => {
    agent?.close();
    await hub.stop();
    await relay.close();
  });

  await waitFor(() => hub.isConnected());

  agent = new WebSocket(relay.agentUrl, {
    headers: {
      Authorization: 'Bearer agent-secret',
    },
  });

  await new Promise<void>((resolve, reject) => {
    agent!.once('open', resolve);
    agent!.once('error', reject);
  });

  agent.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId: '11111111-1111-4111-8111-111111111111',
      device: {
        id: 'relay-device',
        name: 'Relay Device',
        platform: 'linux',
        arch: 'x64',
        agentVersion: 'test',
        capabilities: ['machine.snapshot'],
      },
    }),
  );

  agent.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as {
      requestId: string;
      capability: string;
    };
    agent!.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        data: {
          data: {
            hostname: 'relay-host',
            capability: request.capability,
          },
        },
      }),
    );
  });

  await waitFor(() => broker.has('relay-device'));

  const result = (await broker.request(
    'relay-device',
    'machine.snapshot',
    {},
    2_000,
  )) as {
    data: {
      hostname: string;
      capability: string;
    };
  };

  assert.equal(result.data.hostname, 'relay-host');
  assert.equal(result.data.capability, 'machine.snapshot');

  const listed = broker.list().find(
    (entry) => entry.id === 'relay-device',
  );
  assert.equal(listed?.name, 'Relay Device');
  assert.equal(listed?.platform, 'linux');
});

test('relay refuses agents until an authenticated hub route exists', async (t) => {
  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    hubTokens: ['hub-secret'],
    agentTokens: ['agent-secret'],
  });
  t.after(async () => {
    await relay.close();
  });

  const agent = new WebSocket(relay.agentUrl, {
    headers: {
      Authorization: 'Bearer agent-secret',
    },
  });

  const statusCode = await new Promise<number>((resolve, reject) => {
    agent.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    agent.once('error', (error) => {
      if (
        error instanceof Error &&
        error.message.includes('Unexpected server response')
      ) {
        return;
      }
      reject(error);
    });
  });

  assert.equal(statusCode, 503);
});

test('relay rejects wrong hub credentials', async (t) => {
  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    hubTokens: ['hub-secret'],
    agentTokens: ['agent-secret'],
  });
  t.after(async () => {
    await relay.close();
  });

  const hub = new WebSocket(relay.hubUrl, {
    headers: {
      Authorization: 'Bearer wrong-secret',
    },
  });

  const statusCode = await new Promise<number>((resolve, reject) => {
    hub.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    hub.once('error', (error) => {
      if (
        error instanceof Error &&
        error.message.includes('Unexpected server response')
      ) {
        return;
      }
      reject(error);
    });
  });

  assert.equal(statusCode, 401);
});
