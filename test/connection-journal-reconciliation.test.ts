import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { AgentOperationJournal } from '../src/agent/operation-journal.js';
import { fingerprintAgentRequest } from '../src/agent/request-cache.js';
import { IdempotencyStore, operationFingerprint } from '../src/operations/idempotency-store.js';
import {
  reconcileConnectionBoundAgentOperation,
} from '../src/operations/agent-connection-journal-reconciliation.js';

const deviceA = 'synthetic-naveax';
const deviceB = 'synthetic-workpc';
const capability = 'files.write';
const payload = { path: 'synthetic-only.txt', content: 'no-real-write' };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function fixtures(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-connection-journal-'));
  const hub = new IdempotencyStore(path.join(root, 'hub'));
  const agents = new Map<string, AgentOperationJournal>();
  const agent = (device: string) => {
    let journal = agents.get(device);
    if (!journal) {
      journal = new AgentOperationJournal(path.join(root, device, 'agent.sqlite'));
      agents.set(device, journal);
    }
    return journal;
  };
  t.after(async () => {
    for (const j of agents.values()) j.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const hubRow = await hub.begin({
    key: 'synthetic-' + randomUUID(),
    fingerprint: operationFingerprint({ targetId: deviceA, capability, payload }),
    capability,
    targetId: deviceA,
  });
  return { hub, hubRow: hubRow.record, agent };
}

test('Hub UUID, Hub target hash and Agent request hash are independent; real SQLite metadata is safely reconciled', async t => {
  const f = await fixtures(t);
  const opId = f.hubRow.operationId;
  const localFingerprint = fingerprintAgentRequest(capability, payload, 'safe');
  assert.notEqual(localFingerprint, f.hubRow.fingerprint);
  const agent = f.agent(deviceA);
  await agent.begin(opId, localFingerprint, capability);
  await agent.markDispatched(opId, localFingerprint);
  const recorded = await agent.complete(
    opId, 'succeeded', undefined, { kind: 'file_write_ack', verified: false }, localFingerprint,
  );
  await f.hub.complete(f.hubRow.key, 'unknown');
  const hubRecord = await f.hub.getByOperationId(opId);
  const assessment = reconcileConnectionBoundAgentOperation({
    operationId: opId,
    expectedDeviceId: deviceA,
    authenticatedDeviceId: deviceA,
    capability, payload, hubRecord,
    agentRecord: recorded,
    agentOnline: true,
  });
  assert.equal(assessment.hubStatus, 'unknown');
  assert.equal(assessment.state, 'agent_confirmed');
  assert.equal(assessment.agentStatus, 'succeeded');
  assert.equal(assessment.evidenceKind, 'file_write_ack');
  assert.equal(assessment.evidenceVerified, false);
  assert.equal(assessment.externalSideEffectProven, false);
  assert.equal(assessment.automaticallyRetryable, false);
  assert.equal((await agent.begin(opId, localFingerprint, capability)).created, false);
});

test('wrong authenticated device, missing provenance or wrong Hub target never accepts a terminal journal', async t => {
  const f = await fixtures(t);
  const opId = f.hubRow.operationId;
  const fp = fingerprintAgentRequest(capability, payload);
  const otherAgent = f.agent(deviceB);
  await otherAgent.begin(opId, fp, capability);
  await otherAgent.markDispatched(opId, fp);
  const otherRecord = await otherAgent.complete(opId, 'succeeded', undefined,
    { kind: 'file_write_ack', verified: false }, fp);
  for (const authenticatedDeviceId of [deviceB, undefined, 'unknown-device']) {
    const verdict = reconcileConnectionBoundAgentOperation({
      operationId: opId, expectedDeviceId: deviceA,
      ...(authenticatedDeviceId ? { authenticatedDeviceId } : {}),
      capability, payload, hubRecord: f.hubRow,
      agentRecord: otherRecord, agentOnline: true,
    });
    assert.equal(verdict.state, 'unknown');
    assert.equal(verdict.reason, 'journal_mismatch');
    assert.equal(verdict.automaticallyRetryable, false);
    assert.equal(verdict.externalSideEffectProven, false);
  }
  const misroutedHub = reconcileConnectionBoundAgentOperation({
    operationId: opId, expectedDeviceId: deviceB,
    authenticatedDeviceId: deviceB, capability, payload,
    hubRecord: f.hubRow, agentRecord: otherRecord, agentOnline: true,
  });
  assert.equal(misroutedHub.state, 'unknown');
  assert.equal(misroutedHub.hubStatus, 'not_recorded');
  assert.equal(misroutedHub.automaticallyRetryable, false);
});

test('stale UUID, changed payload/access mode, missing Agent row and offline Agent remain unknown', async t => {
  const f = await fixtures(t);
  const opId = f.hubRow.operationId;
  const fp = fingerprintAgentRequest(capability, payload);
  const journal = f.agent(deviceA);
  await journal.begin(opId, fp, capability);
  await journal.markDispatched(opId, fp);
  const row = await journal.complete(opId, 'succeeded', undefined,
    { kind: 'file_write_ack', verified: false }, fp);

  for (const mismatch of [
    { operationId: randomUUID() },
    { payload: { ...payload, content: 'changed' } },
    { accessMode: 'full' as const },
  ]) {
    const verdict = reconcileConnectionBoundAgentOperation({
      operationId: opId, expectedDeviceId: deviceA,
      authenticatedDeviceId: deviceA, capability, payload,
      hubRecord: f.hubRow, agentRecord: row, agentOnline: true, ...mismatch,
    });
    assert.equal(verdict.state, 'unknown');
    assert.equal(verdict.automaticallyRetryable, false);
  }
  const offline = reconcileConnectionBoundAgentOperation({
    operationId: opId, expectedDeviceId: deviceA,
    authenticatedDeviceId: deviceA, capability, payload,
    hubRecord: f.hubRow, agentRecord: row, agentOnline: false,
  });
  assert.equal(offline.state, 'unknown');
  assert.equal(offline.reason, 'agent_offline');
  const missing = reconcileConnectionBoundAgentOperation({
    operationId: opId, expectedDeviceId: deviceA,
    authenticatedDeviceId: deviceA, capability, payload,
    hubRecord: f.hubRow, agentOnline: true,
  });
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.reason, 'record_missing');
});

test('real localhost WSS drops mutation ACK: Hub UNKNOWN, Agent journal terminal metadata, zero automatic replay', async t => {
  const f = await fixtures(t);
  const http = createServer();
  const broker = new AgentBroker({ reconnectGraceMs: 350 });
  const wss = attachAgentWebSocketServer(http, broker, 'journal-fixture-token');
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const socket = new WebSocket('ws://127.0.0.1:' + address.port + '/agent', {
    headers: { Authorization: 'Bearer journal-fixture-token' },
  });
  socket.on('error', () => undefined);
  t.after(async () => {
    socket.terminate();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let executions = 0;
  let completed = false;
  const fp = fingerprintAgentRequest(capability, payload);
  const agentJournal = f.agent(deviceA);
  socket.on('message', raw => {
    const msg = JSON.parse(raw.toString()) as {type: string;requestId: string;capability: string};
    if (msg.type !== 'request') return;
    executions++;
    void (async () => {
      await agentJournal.begin(msg.requestId, fp, msg.capability);
      await agentJournal.markDispatched(msg.requestId, fp);
      await agentJournal.complete(msg.requestId, 'succeeded', undefined,
        {kind:'file_write_ack',verified:false}, fp);
      completed = true;
      // Connection failure after metadata is recorded, before response ACK.
      socket.terminate();
    })();
  });
  socket.send(JSON.stringify({
    type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId: '12341234-1234-4123-8123-123412341234',
    device: {id:deviceA,name:'synthetic-naveax',platform:'win32',arch:'x64',
      agentVersion:'staging',capabilities:[capability]},
  }));
  const deadline = Date.now() + 1500;
  while (!broker.has(deviceA) && Date.now() < deadline) await pause(10);
  assert.equal(broker.has(deviceA), true);
  const result = broker.request(deviceA, capability, payload, 1800, f.hubRow.operationId)
    .then(() => 'unexpected_success', (error: unknown) => (error as {code?: string}).code);
  const reportedCode = await result;
  assert.equal(reportedCode, 'MUTATION_STATE_UNKNOWN');
  assert.equal(completed, true);
  assert.equal(executions, 1);
  await f.hub.complete(f.hubRow.key, 'unknown');
  const verdict = reconcileConnectionBoundAgentOperation({
    operationId:f.hubRow.operationId, expectedDeviceId:deviceA,
    authenticatedDeviceId:deviceA, capability,payload,
    hubRecord:await f.hub.getByOperationId(f.hubRow.operationId),
    agentRecord:await agentJournal.inspect(f.hubRow.operationId),
    agentOnline:true, // later authenticated read-only retrieval, simulated here
  });
  assert.equal(verdict.state, 'agent_confirmed');
  assert.equal(verdict.evidenceVerified, false);
  assert.equal(verdict.externalSideEffectProven, false);
  assert.equal(verdict.automaticallyRetryable, false);
  assert.equal((await agentJournal.begin(f.hubRow.operationId, fp, capability)).created, false);
});
