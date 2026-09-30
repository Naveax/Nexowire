import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { NexowireError } from '../src/core/errors.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

const queuedMessages = new WeakMap<WebSocket, unknown[]>();

interface HubFixture {
  http: Server;
  broker: AgentBroker;
  wss: WebSocketServer;
  port: number;
}

async function createHub(): Promise<HubFixture> {
  const http = createServer();
  const broker = new AgentBroker({
    reconnectGraceMs: 1_000,
  });
  const wss = attachAgentWebSocketServer(
    http,
    broker,
    'continuity-token',
  );
  await new Promise<void>((resolve) =>
    http.listen(0, '127.0.0.1', resolve),
  );
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return {
    http,
    broker,
    wss,
    port: address.port,
  };
}

async function closeHub(fixture: HubFixture): Promise<void> {
  for (const client of fixture.wss.clients) client.close();
  fixture.wss.close();
  await new Promise<void>((resolve) =>
    fixture.http.close(() => resolve()),
  );
}

async function connectAgent(
  fixture: HubFixture,
  deviceId: string,
  instanceId: string,
  capabilities: string[],
): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.port}/agent`,
    {
      headers: {
        Authorization: 'Bearer continuity-token',
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const queue: unknown[] = [];
  queuedMessages.set(socket, queue);
  socket.on('message', (raw) => {
    try {
      queue.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore malformed test traffic.
    }
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId,
      device: {
        id: deviceId,
        name: 'Continuity Device',
        platform: process.platform,
        arch: process.arch,
        agentVersion: 'test',
        capabilities,
      },
    }),
  );

  for (let i = 0; i < 100 && !fixture.broker.has(deviceId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fixture.broker.has(deviceId), true);
  return socket;
}

async function nextRequest(socket: WebSocket): Promise<{
  requestId: string;
  capability: string;
  input: unknown;
}> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const queue = queuedMessages.get(socket);
    const next = queue?.shift();
    if (next) {
      return next as {
        requestId: string;
        capability: string;
        input: unknown;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for hub request.');
}

async function waitOffline(
  broker: AgentBroker,
  deviceId: string,
): Promise<void> {
  for (let i = 0; i < 100 && broker.has(deviceId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has(deviceId), false);
}

test('same native-agent instance resumes a pending mutation with the same request ID', async (t) => {
  const fixture = await createHub();
  t.after(() => closeHub(fixture));

  const instanceId = '11111111-1111-4111-8111-111111111111';
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const first = await connectAgent(
    fixture,
    'continuity-mutation',
    instanceId,
    ['files.write'],
  );

  const resultPromise = fixture.broker.request(
    'continuity-mutation',
    'files.write',
    { path: 'x.txt', content: 'hello' },
    4_000,
    requestId,
  );
  const original = await nextRequest(first);
  assert.equal(original.requestId, requestId);
  assert.equal(original.capability, 'files.write');

  first.terminate();
  await waitOffline(fixture.broker, 'continuity-mutation');

  const second = await connectAgent(
    fixture,
    'continuity-mutation',
    instanceId,
    ['files.write'],
  );
  const resumed = await nextRequest(second);
  assert.equal(resumed.requestId, requestId);
  assert.equal(resumed.capability, 'files.write');
  assert.deepEqual(resumed.input, {
    path: 'x.txt',
    content: 'hello',
  });

  second.send(
    JSON.stringify({
      type: 'response',
      requestId,
      ok: true,
      data: { data: { written: true } },
    }),
  );

  assert.deepEqual(await resultPromise, {
    data: { written: true },
  });
});

test('new native-agent process instance never replays a pending mutation', async (t) => {
  const fixture = await createHub();
  t.after(() => closeHub(fixture));

  const first = await connectAgent(
    fixture,
    'continuity-new-process-mutation',
    '22222222-2222-4222-8222-222222222222',
    ['files.write'],
  );

  const pending = fixture.broker.request(
    'continuity-new-process-mutation',
    'files.write',
    { path: 'x.txt', content: 'hello' },
    4_000,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const observed = pending.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await nextRequest(first);

  first.terminate();
  await waitOffline(
    fixture.broker,
    'continuity-new-process-mutation',
  );

  const second = await connectAgent(
    fixture,
    'continuity-new-process-mutation',
    '33333333-3333-4333-8333-333333333333',
    ['files.write'],
  );

  const result = await observed;
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok &&
      result.error instanceof NexowireError &&
      result.error.code === 'AGENT_INSTANCE_CHANGED',
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(queuedMessages.get(second)?.length ?? 0, 0);
});

test('read-only request can resume after a native-agent process restart', async (t) => {
  const fixture = await createHub();
  t.after(() => closeHub(fixture));

  const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const first = await connectAgent(
    fixture,
    'continuity-read',
    '44444444-4444-4444-8444-444444444444',
    ['machine.snapshot'],
  );

  const resultPromise = fixture.broker.request(
    'continuity-read',
    'machine.snapshot',
    {},
    4_000,
    requestId,
  );
  await nextRequest(first);

  first.terminate();
  await waitOffline(fixture.broker, 'continuity-read');

  const second = await connectAgent(
    fixture,
    'continuity-read',
    '55555555-5555-4555-8555-555555555555',
    ['machine.snapshot'],
  );
  const resumed = await nextRequest(second);
  assert.equal(resumed.requestId, requestId);
  assert.equal(resumed.capability, 'machine.snapshot');

  second.send(
    JSON.stringify({
      type: 'response',
      requestId,
      ok: true,
      data: { data: { hostname: 'resumed-host' } },
    }),
  );

  assert.deepEqual(await resultPromise, {
    data: { hostname: 'resumed-host' },
  });
});
