import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';
import {
  boundHubRetryWait, classifyHubReconnectFailure, parseHubEndpoints,
  planNextHubAttempt,
} from '../src/agent/native-agent.js';
import {connectionContinuityState} from '../src/operations/agent-connection-journal-reconciliation.js';

const TOKEN = 'v2-07-isolated-fixture-only';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function eventually(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await wait(5);
  assert.equal(predicate(), true, 'bounded fixture deadline');
}

test('V2-07 retry decision table distinguishes transient, overload, reauthorization and policy violations', () => {
  for (const failure of [
    {wsCloseCode: 1006}, {wsCloseCode: 1011},
    {httpStatus: 500}, {httpStatus: 502}, {httpStatus: 504},
    {errorCode: 'ENOTFOUND'}, {errorCode: 'EAI_AGAIN'},
  ]) {
    const decision = classifyHubReconnectFailure(failure);
    assert.equal(decision.retryable, true, JSON.stringify(failure));
    assert.equal(decision.reason, 'transient');
  }
  for (const failure of [{wsCloseCode: 1013}, {httpStatus: 429}, {httpStatus: 503}]) {
    const decision = classifyHubReconnectFailure(failure);
    assert.equal(decision.retryable, true);
    assert.equal(decision.reason, 'overloaded');
    assert.ok(decision.minimumDelayMs >= 5_000);
  }
  for (const failure of [
    {httpStatus: 401}, {httpStatus: 403}, {wsCloseCode: 1008}, {wsCloseCode: 4001},
  ]) {
    assert.deepEqual(classifyHubReconnectFailure(failure), {
      retryable: false, minimumDelayMs: 0, reason: 'reauthorization_required',
    });
  }
  for (const failure of [
    {httpStatus: 404}, {wsCloseCode: 1002},
    {errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID'},
  ]) {
    assert.equal(classifyHubReconnectFailure(failure).retryable, false);
  }
});

test('V2-07 endpoint fallback, jitter, cooldown and cap cannot spin indefinitely', () => {
  const first = planNextHubAttempt({currentIndex: 0, endpointCount: 2,
    backoffMs: 1_000, connectedMs: 0, random: () => 0});
  assert.equal(first.endpointIndex, 1);
  assert.equal(first.waitMs, 250);
  const second = planNextHubAttempt({currentIndex: 1, endpointCount: 2,
    backoffMs: 1_000, connectedMs: 0, random: () => 1});
  assert.equal(second.endpointIndex, 0);
  assert.equal(second.waitMs, 1200);
  assert.equal(boundHubRetryWait({scheduledMs: first.waitMs, consecutiveFailures: 7}), 250);
  assert.equal(boundHubRetryWait({scheduledMs: first.waitMs, consecutiveFailures: 8}), 30_000);
  assert.equal(boundHubRetryWait({scheduledMs: 250, consecutiveFailures: 2, minimumDelayMs: 5_000}), 5_000);
  assert.equal(boundHubRetryWait({scheduledMs: 80_000, consecutiveFailures: 9}), 30_000);
  assert.throws(() => parseHubEndpoints({
    NEXOWIRE_HUB_WS_URLS: Array.from({length: 9}, (_, i) =>
      'wss://relay' + i + '.example/agent').join(','),
  }), /eight distinct/);
});

test('V2-07 connection phases cannot convert socket or a missing journal into completion', () => {
  const phase = connectionContinuityState;
  assert.equal(phase({socketConnected: true, authenticated: false}), 'SOCKET_CONNECTED');
  assert.equal(phase({socketConnected: true, authenticated: true}), 'AUTHENTICATED_ONLINE');
  assert.equal(phase({socketConnected: false, authenticated: true}), 'DISCONNECTED');
  assert.equal(phase({socketConnected: true, authenticated: true, revoked: true}), 'REVOKED');
  assert.equal(phase({socketConnected: true, authenticated: true, mutationDispatched: true}), 'UNKNOWN');
  assert.equal(phase({socketConnected: false, authenticated: false, mutationDispatched: true}), 'UNKNOWN');
  assert.equal(phase({socketConnected: true, authenticated: true, mutationDispatched: true,
    assessment: {operationId: randomUUID(), hubStatus: 'unknown', state: 'agent_in_progress',
      evidenceVerified: false, externalSideEffectProven: false, automaticallyRetryable: false,
      reason: 'in_progress'},
  }), 'MUTATION_DISPATCHED');
  assert.equal(phase({socketConnected: true, authenticated: true, mutationDispatched: true,
    assessment: {operationId: randomUUID(), hubStatus: 'unknown', state: 'agent_confirmed',
      evidenceVerified: false, externalSideEffectProven: false, automaticallyRetryable: false,
      reason: 'agent_terminal'},
  }), 'MUTATION_COMPLETED');
  assert.equal(phase({socketConnected: true, authenticated: true, revoked: true,
    mutationDispatched: true}), 'REVOKED');
});

async function fixture(t: import('node:test').TestContext, options = {}) {
  const http = createServer();
  const broker = new AgentBroker({reconnectGraceMs: 750, ...options});
  const wss = attachAgentWebSocketServer(http, broker, TOKEN, {
    heartbeatMs: 250, helloTimeoutMs: 1000,
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach(s => s.terminate());
    for (const s of wss.clients) s.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  async function agent(deviceId: string, instanceId: string, epoch: number) {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/agent',
      {headers: {Authorization: 'Bearer ' + TOKEN}});
    sockets.push(socket);
    const inbound: string[] = [];
    socket.on('message', raw => inbound.push(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({type:'hello', protocolVersion:AGENT_PROTOCOL_VERSION,
      instanceId, device:{id:deviceId,name:deviceId,platform:'win32',arch:'x64',
        agentVersion:'fixture',capabilities:['machine.snapshot','files.write']}}));
    await eventually(() => broker.getConnectionHealth(deviceId)?.epoch === epoch);
    return {socket, inbound};
  }
  return {broker, wss, agent};
}

test('V2-07 heartbeat-failed OPEN socket immediately drops online and blocks new dispatch', async t => {
  const f = await fixture(t);
  await f.agent('half-open', randomUUID(), 1);
  assert.equal(f.broker.getConnectionHealth('half-open')?.state, 'AUTHENTICATED_ONLINE');
  const serverSocket = [...f.wss.clients][0]!;
  f.broker.noteHeartbeatTimeout(serverSocket);
  assert.equal(f.broker.has('half-open'), false);
  assert.equal(f.broker.getConnectionHealth('half-open')?.online, false);
  assert.equal(f.broker.getConnectionHealth('half-open')?.state, 'UNKNOWN');
  await assert.rejects(
    () => f.broker.request('half-open', 'files.write', {synthetic: true}),
    (error: unknown) => (error as {code?:string}).code === 'AGENT_OFFLINE',
  );
  serverSocket.terminate();
  await eventually(() => f.broker.getConnectionHealth('half-open')?.state === 'DISCONNECTED');
});

test('V2-07 reconnection applies per-epoch resend budget without replaying mutations', async t => {
  const f = await fixture(t, {maxResumesPerEpoch: 1, maxGlobalResumesPerSecond: 2});
  const device = 'budget-fixture';
  const first = await f.agent(device, randomUUID(), 1);
  const pending = Array.from({length: 4}, () => {
    const id = randomUUID();
    const promise = f.broker.request(device, 'machine.snapshot', {test: true}, 2_000, id)
      .then(() => 'completed', (e: {code?:string}) => e.code ?? 'unexpected');
    return {id, promise};
  });
  await eventually(() => first.inbound.length === 4);
  first.socket.terminate();
  await eventually(() => !f.broker.has(device));
  const second = await f.agent(device, randomUUID(), 2);
  await eventually(() => second.inbound.length === 1);
  const forwarded = JSON.parse(second.inbound[0]!) as {requestId:string};
  assert.equal(forwarded.requestId, pending[0]!.id);
  second.socket.send(JSON.stringify({
    type:'response', requestId: forwarded.requestId, ok:true, data: {received: true},
  }));
  const statuses = await Promise.all(pending.map(x => x.promise));
  assert.deepEqual(statuses, ['completed','AGENT_RECONNECT_BUDGET',
    'AGENT_RECONNECT_BUDGET','AGENT_RECONNECT_BUDGET']);
  assert.equal(second.inbound.length, 1);
});

test('V2-07 same-instance socket replacement marks lost mutation ACK UNKNOWN, with zero resend', async t => {
  const f = await fixture(t);
  const device = 'mutation-replace';
  const instance = randomUUID();
  const first = await f.agent(device, instance, 1);
  const id = randomUUID();
  const result = f.broker.request(device, 'files.write', {synthetic: true}, 2_000, id)
    .then(() => 'UNSAFE_SUCCESS', (e: {code?:string}) => e.code);
  await eventually(() => first.inbound.length === 1);
  const second = await f.agent(device, instance, 2);
  assert.equal(await result, 'MUTATION_STATE_UNKNOWN');
  assert.equal(second.inbound.length, 0);
  assert.equal(f.broker.getConnectionHealth(device)?.epoch, 2);
});


test('V2-07 lost ACK then Hub restart preserves one UUID, UNKNOWN and no second Agent dispatch', async t => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {IdempotencyStore, operationFingerprint} = await import('../src/operations/idempotency-store.js');
  const {AgentOperationJournal} = await import('../src/agent/operation-journal.js');
  const {fingerprintAgentRequest} = await import('../src/agent/request-cache.js');
  const root = await mkdtemp(path.join(tmpdir(), 'v2-07-unknown-'));
  const hub = new IdempotencyStore(path.join(root, 'hub'));
  const journal = new AgentOperationJournal(path.join(root, 'agent.sqlite'));
  t.after(async () => { journal.close(); await rm(root, {recursive: true, force: true}); });
  const payload = {path: 'synthetic.txt', content: 'one logical mutation'};
  const request = {
    key: 'v2-07-' + randomUUID(),
    targetId: 'fixture-device', capability: 'files.write',
    fingerprint: operationFingerprint({targetId: 'fixture-device',
      capability: 'files.write', payload}),
  };
  const first = await hub.begin(request);
  assert.equal(first.created, true);
  const id = first.record.operationId;
  const agentFingerprint = fingerprintAgentRequest('files.write', payload, 'safe');
  let syntheticDispatches = 0;
  const firstAgent = await journal.begin(id, agentFingerprint, 'files.write');
  if (firstAgent.created) {
    await journal.markDispatched(id, agentFingerprint);
    syntheticDispatches++;
    await journal.complete(id, 'succeeded', undefined,
      {kind: 'file_write_ack', verified: false}, agentFingerprint);
  }
  // Simulated ACK loss before Hub can confirm the terminal Agent journal.
  await hub.complete(request.key, 'unknown');

  const restarted = new IdempotencyStore(path.join(root, 'hub'));
  await restarted.initialize();
  const again = await restarted.begin(request);
  assert.equal(again.created, false);
  assert.equal(again.record.operationId, id);
  assert.equal(again.record.status, 'unknown');
  const secondAgent = await journal.begin(id, agentFingerprint, 'files.write');
  assert.equal(secondAgent.created, false, 'durable Agent journal must not re-execute');
  assert.equal(syntheticDispatches, 1);
  assert.equal((await journal.inspect(id))?.status, 'succeeded');

  await assert.rejects(
    () => restarted.begin({...request, fingerprint: operationFingerprint({
      targetId:'fixture-device', capability:'files.write',
      payload:{...payload, content:'different effect'},
    })}),
    (error: unknown) => (error as {code?:string}).code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('V2-07 global one-second reconnect budget stops a multi-request replay burst', async t => {
  const f = await fixture(t, {maxResumesPerEpoch: 8, maxGlobalResumesPerSecond: 1});
  const device = 'global-budget';
  const first = await f.agent(device, randomUUID(), 1);
  const attempts = Array.from({length: 3}, () => {
    const requestId = randomUUID();
    const outcome = f.broker.request(device, 'machine.snapshot', {synthetic: true},
      2_000, requestId).then(() => 'ok', (e: {code?:string}) => e.code);
    return {requestId, outcome};
  });
  await eventually(() => first.inbound.length === 3);
  first.socket.terminate();
  await eventually(() => !f.broker.has(device));
  const rejoined = await f.agent(device, randomUUID(), 2);
  await eventually(() => rejoined.inbound.length === 1);
  const requestId = (JSON.parse(rejoined.inbound[0]!) as {requestId:string}).requestId;
  assert.equal(requestId, attempts[0]!.requestId);
  rejoined.socket.send(JSON.stringify({
    type: 'response', requestId, ok: true, data: {receipt: 'synthetic'},
  }));
  assert.deepEqual(await Promise.all(attempts.map(x => x.outcome)), [
    'ok', 'AGENT_RECONNECT_BUDGET', 'AGENT_RECONNECT_BUDGET',
  ]);
});
