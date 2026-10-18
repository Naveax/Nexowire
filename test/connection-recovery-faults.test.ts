import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentBroker, type AgentBrokerOptions } from '../src/core/agent-broker.js';
import { NexowireError } from '../src/core/errors.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { ScaleTransportMetrics } from '../src/ops/scale-transport-metrics.js';

const TOKEN = 'isolated-fixture-token-not-for-production';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Fixture {
  http: Server;
  wss: WebSocketServer;
  broker: AgentBroker;
  metrics: ScaleTransportMetrics;
  url: string;
  sockets: WebSocket[];
}

async function fixture(options: AgentBrokerOptions = {}): Promise<Fixture> {
  const http = createServer();
  const metrics = new ScaleTransportMetrics();
  const broker = new AgentBroker({
    reconnectGraceMs: 500,
    metrics,
    ...options,
  });
  const wss = attachAgentWebSocketServer(http, broker, TOKEN, {
    heartbeatMs: 250,
    helloTimeoutMs: 1_000,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return {
    http, wss, broker, metrics,
    url: 'ws://127.0.0.1:' + address.port + '/agent',
    sockets: [],
  };
}

async function closeFixture(f: Fixture): Promise<void> {
  for (const s of f.sockets) s.terminate();
  for (const s of f.wss.clients) s.terminate();
  await new Promise<void>((resolve) => f.wss.close(() => resolve()));
  await new Promise<void>((resolve) => f.http.close(() => resolve()));
}

const inbound = new WeakMap<WebSocket, Array<{requestId: string; capability: string}>>();

async function waitFor(predicate: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'expected simulated condition before timeout');
}

async function openAgent(
  f: Fixture,
  deviceId: string,
  instanceId: string,
  capabilities: string[],
  expectedEpoch = 1,
): Promise<WebSocket> {
  const socket = new WebSocket(f.url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  f.sockets.push(socket);
  const q: Array<{requestId: string; capability: string}> = [];
  inbound.set(socket, q);
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString()) as {requestId: string; capability: string};
    if (value.requestId) q.push(value);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId,
    device: {
      id: deviceId, name: 'Fixture ' + deviceId,
      platform: 'win32', arch: 'x64',
      agentVersion: '1.0.5', capabilities,
    },
  }));
  await waitFor(() => f.broker.getConnectionHealth(deviceId)?.epoch === expectedEpoch);
  return socket;
}

async function nextRequest(socket: WebSocket): Promise<{requestId: string; capability: string}> {
  await waitFor(() => (inbound.get(socket)?.length ?? 0) > 0);
  return inbound.get(socket)!.shift()!;
}

function answer(socket: WebSocket, requestId: string, ok: boolean): void {
  socket.send(JSON.stringify({
    type: 'response', requestId, ok,
    ...(ok ? {data: {data: {confirmed: true}}} : {error: {code: 'SIMULATED_FAILURE', message: 'rejected'}}),
  }));
}

function captured(promise: Promise<unknown>): Promise<{ok: boolean; error?: unknown; result?: unknown}> {
  return promise.then(
    (result) => ({ok: true, result}),
    (error: unknown) => ({ok: false, error}),
  );
}

test('two simultaneous devices never cross-resolve request IDs or ACKs', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const naveax = await openAgent(f, 'sim-naveax', '11111111-1111-4111-8111-111111111111', ['machine.snapshot']);
  const workpc = await openAgent(f, 'sim-workpc', '22222222-2222-4222-8222-222222222222', ['machine.snapshot']);
  const reqA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const reqB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let finishedA = false;
  const promiseA = f.broker.request('sim-naveax', 'machine.snapshot', {}, 2_000, reqA)
    .then((result) => { finishedA = true; return result; });
  const promiseB = f.broker.request('sim-workpc', 'machine.snapshot', {}, 2_000, reqB);
  assert.equal((await nextRequest(naveax)).requestId, reqA);
  assert.equal((await nextRequest(workpc)).requestId, reqB);

  // Authenticated device B still cannot acknowledge a request belonging to A.
  answer(workpc, reqA, true);
  await delay(65);
  assert.equal(finishedA, false);
  assert.equal(f.broker.getConnectionHealth('sim-naveax')?.lastAgentAckAt, undefined);

  answer(workpc, reqB, true);
  answer(naveax, reqA, true);
  assert.deepEqual(await promiseA, {data: {confirmed: true}});
  assert.deepEqual(await promiseB, {data: {confirmed: true}});
  assert.equal(f.broker.getConnectionHealth('sim-naveax')?.lastAgentAckOk, true);
  assert.equal(f.broker.getConnectionHealth('sim-workpc')?.lastAgentAckOk, true);
});

test('delayed mutation ACK expires unknown; late response cannot turn it into success', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const socket = await openAgent(f, 'slow-ack', '33333333-3333-4333-8333-333333333333', ['files.write']);
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const result = captured(f.broker.request('slow-ack', 'files.write', {content: 'secret'}, 95, id));
  assert.equal((await nextRequest(socket)).requestId, id);
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof NexowireError);
  assert.equal(outcome.error.code, 'MUTATION_STATE_UNKNOWN');
  assert.equal(f.broker.getConnectionHealth('slow-ack')?.lastAgentAckAt, undefined);
  answer(socket, id, true);
  await delay(35);
  assert.equal(f.broker.getConnectionHealth('slow-ack')?.lastAgentAckAt, undefined);
});

test('duplicate socket for same instance fences mutation without sending again', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const instance = '44444444-4444-4444-8444-444444444444';
  const first = await openAgent(f, 'duplicate-agent', instance, ['files.write']);
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const result = captured(f.broker.request('duplicate-agent', 'files.write', {content: 'once'}, 2_000, id));
  await nextRequest(first);
  const second = await openAgent(f, 'duplicate-agent', instance, ['files.write'], 2);
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof NexowireError);
  assert.equal(outcome.error.code, 'MUTATION_STATE_UNKNOWN');
  await delay(40);
  assert.deepEqual(inbound.get(second), []);
  assert.equal(f.broker.getConnectionHealth('duplicate-agent')?.epoch, 2);
  assert.equal(f.broker.getConnectionHealth('duplicate-agent')?.reconnectCount, 1);
  assert.equal(f.broker.getConnectionHealth('duplicate-agent')?.lastDisconnectReason, 'replaced');
});

test('read-only reconnect has a strict replay budget and retains request ID', async (t) => {
  const f = await fixture({maxReadOnlyReplays: 1});
  t.after(() => closeFixture(f));
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const first = await openAgent(f, 'read-budget', '55555555-5555-4555-8555-555555555555', ['machine.snapshot']);
  const result = captured(f.broker.request('read-budget', 'machine.snapshot', {}, 3_000, id));
  assert.equal((await nextRequest(first)).requestId, id);
  first.terminate();
  await waitFor(() => !f.broker.has('read-budget'));
  const second = await openAgent(f, 'read-budget', '66666666-6666-4666-8666-666666666666', ['machine.snapshot'], 2);
  assert.equal((await nextRequest(second)).requestId, id);
  second.terminate();
  await waitFor(() => !f.broker.has('read-budget'));
  const third = await openAgent(f, 'read-budget', '77777777-7777-4777-8777-777777777777', ['machine.snapshot'], 3);
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof NexowireError);
  assert.equal(outcome.error.code, 'AGENT_RETRY_LIMIT');
  assert.deepEqual(inbound.get(third), []);
  assert.equal(f.metrics.snapshot()['agent.resumed_requests'].events, 1);
  assert.equal(f.metrics.snapshot()['agent.rejected_requests'].events, 1);
});

test('offline grace expiry reports unknown mutation without real network loss', async (t) => {
  const f = await fixture({reconnectGraceMs: 250});
  t.after(() => closeFixture(f));
  const first = await openAgent(f, 'offline-agent', '88888888-8888-4888-8888-888888888888', ['files.write']);
  const result = captured(f.broker.request('offline-agent', 'files.write', {content: 'once'}, 2_000));
  await nextRequest(first);
  first.terminate();
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof NexowireError);
  assert.equal(outcome.error.code, 'MUTATION_STATE_UNKNOWN');
  assert.equal(f.broker.getConnectionHealth('offline-agent')?.online, false);
  assert.equal(f.broker.getConnectionHealth('offline-agent')?.lastDisconnectReason, 'socket_closed');
});

test('ping, pong, success ACK and reconnect metrics contain no credentials or payloads', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const socket = await openAgent(f, 'telemetry-agent', '99999999-9999-4999-8999-999999999999', ['machine.snapshot']);
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const result = f.broker.request('telemetry-agent', 'machine.snapshot', {password: 'never-show-this'}, 2_000, id);
  await nextRequest(socket);
  answer(socket, id, true);
  await result;
  await delay(670);
  const h = f.broker.getConnectionHealth('telemetry-agent');
  assert.ok(h);
  assert.ok(h.pingCount >= 2);
  assert.ok(h.pongCount >= 1);
  assert.ok(h.lastSuccessfulAgentAckAt);
  assert.equal(h.transport, 'websocket'); // No unsupported P2P claim.
  const serialized = JSON.stringify(h);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('never-show-this'), false);
  const metrics = f.metrics.snapshot();
  assert.ok(metrics['agent.heartbeat_pings'].events >= 2);
  assert.equal(metrics['agent.ack_responses'].events, 1);
});


test('offline device is not dispatched or silently replaced by a different target', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  await assert.rejects(
    () => f.broker.request('sim-naveax', 'machine.snapshot', {}, 100),
    (error: unknown) =>
      error instanceof NexowireError && error.code === 'AGENT_OFFLINE',
  );
  await openAgent(f, 'sim-workpc', 'aaaa1111-1111-4111-8111-111111111111', ['machine.snapshot']);
  await assert.rejects(
    () => f.broker.request('sim-naveax', 'machine.snapshot', {}, 100),
    (error: unknown) =>
      error instanceof NexowireError && error.code === 'AGENT_OFFLINE',
  );
  assert.equal(f.broker.getConnectionHealth('sim-workpc')?.online, true);
  assert.equal(f.broker.getConnectionHealth('sim-naveax'), undefined);
});

test('heartbeat timeout is distinguished from ordinary socket close', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  await openAgent(f, 'stale-heartbeat', 'aaaa2222-2222-4222-8222-222222222222', ['machine.snapshot']);
  const serverSocket = [...f.wss.clients][0]!;
  f.broker.noteHeartbeatTimeout(serverSocket);
  serverSocket.terminate();
  await waitFor(() => f.broker.getConnectionHealth('stale-heartbeat')?.online === false);
  assert.equal(f.broker.getConnectionHealth('stale-heartbeat')?.lastDisconnectReason, 'heartbeat_timeout');
  assert.equal(f.broker.getConnectionHealth('stale-heartbeat')?.transport, 'websocket');
});

test('queued ACK/event from an old socket cannot affect a replacement socket', async (t) => {
  const f = await fixture();
  t.after(() => closeFixture(f));
  const id = '12345678-1234-4234-8234-123456789abc';
  const instance = 'aaaa3333-3333-4333-8333-333333333333';
  const first = await openAgent(f, 'stale-frame', instance, ['machine.snapshot']);
  const oldServerSocket = [...f.wss.clients][0]!;
  let completed = false;
  const promise = f.broker.request('stale-frame', 'machine.snapshot', {}, 2_000, id)
    .then((result) => { completed = true; return result; });
  await nextRequest(first);

  const second = await openAgent(f, 'stale-frame', instance, ['machine.snapshot'], 2);
  const continued = await nextRequest(second);
  assert.equal(continued.requestId, id);

  // Deterministic injection models a frame already queued on the old WSS
  // transport just as its close handshake races with a replacement hello.
  const deliver = (f.broker as unknown as {
    handleMessage: (deviceId: string, socket: WebSocket, raw: string) => void;
  }).handleMessage.bind(f.broker);
  deliver('stale-frame', oldServerSocket, JSON.stringify({
    type: 'response', requestId: id, ok: true, data: {data: {old: true}},
  }));
  deliver('stale-frame', oldServerSocket, JSON.stringify({
    type: 'event', eventId: 'aaaa4444-4444-4444-8444-444444444444',
    at: new Date().toISOString(), topic: 'sim.old.socket',
    data: { leaked: true },
  }));
  await delay(30);
  assert.equal(completed, false);
  const staleEvents = await f.broker.readEvents({ topics: ['sim.old.socket'] });
  assert.equal(staleEvents.events.length, 0);
  answer(second, id, true);
  assert.deepEqual(await promise, {data: {confirmed: true}});
  assert.equal(f.metrics.snapshot()['agent.ack_responses'].events, 1);
});
