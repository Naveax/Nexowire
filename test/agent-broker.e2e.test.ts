import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { CredentialStore } from '../src/security/credential-store.js';

test('hub sends a capability request through a real WebSocket agent', async (t) => {
  const http = createServer();
  const broker = new AgentBroker({ maxEvents: 3, maxEventBytes: 1_048_576 });
  const wss = attachAgentWebSocketServer(http, broker, [
    'old-agent-token',
    'current-agent-token',
  ]);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
    headers: { Authorization: 'Bearer current-agent-token' },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId: '11111111-1111-4111-8111-111111111111',
    device: {
      id: 'device-e2e',
      name: 'E2E Device',
      platform: process.platform,
      arch: process.arch,
      agentVersion: 'test',
      capabilities: ['machine.snapshot'],
    },
  }));
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as { requestId: string };
    socket.send(JSON.stringify({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      data: { data: { hostname: 'e2e-host' } },
    }));
  });
  for (let i = 0; i < 50 && !broker.has('device-e2e'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has('device-e2e'), true);
  const result = await broker.request('device-e2e', 'machine.snapshot', {}, 2_000);
  assert.deepEqual(result, { data: { hostname: 'e2e-host' } });

  socket.send(JSON.stringify({
    type: 'event',
    eventId: '11111111-1111-4111-8111-111111111111',
    at: new Date().toISOString(),
    topic: 'test.signal',
    data: { value: 42 },
  }));
  const eventFeed = await broker.readEvents({
    deviceId: 'device-e2e',
    topics: ['test.signal'],
    afterSeq: 0,
    waitMs: 1_000,
  });
  assert.equal(eventFeed.events.length, 1);
  assert.equal(eventFeed.events[0]?.deviceId, 'device-e2e');
  assert.equal(eventFeed.events[0]?.topic, 'test.signal');
  assert.deepEqual(eventFeed.events[0]?.data, { value: 42 });

  const waiting = broker.readEvents({
    deviceId: 'device-e2e',
    topics: ['test.long-poll'],
    afterSeq: eventFeed.nextSeq,
    waitMs: 1_000,
  });
  setTimeout(() => {
    socket.send(JSON.stringify({
      type: 'event',
      eventId: '22222222-2222-4222-8222-222222222222',
      at: new Date().toISOString(),
      topic: 'test.long-poll',
      data: { awake: true },
    }));
  }, 30);
  const longPollFeed = await waiting;
  assert.equal(longPollFeed.events.length, 1);
  assert.equal(longPollFeed.events[0]?.topic, 'test.long-poll');

  socket.send(JSON.stringify({
    type: 'event',
    eventId: '44444444-4444-4444-8444-444444444444',
    at: new Date().toISOString(),
    topic: 'test.trim',
    data: { trimmed: true },
  }));
  const trimFeed = await broker.readEvents({
    topics: ['test.trim'],
    afterSeq: 0,
    waitMs: 1_000,
  });
  assert.equal(trimFeed.events.length, 1);
  assert.equal(trimFeed.cursorExpired, true);
  assert.ok(trimFeed.oldestSeq > 1);
  socket.close();
});

test('native agent WebSocket accepts and revokes a persisted agent credential', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-credential-'),
  );
  const credentials = new CredentialStore(root);
  await credentials.initialize();
  const issued = await credentials.issue('agent', {
    name: 'device-enrollment',
  });

  const http = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(
    http,
    broker,
    [],
    {
      credentialStore: credentials,
      heartbeatMs: 1_000,
      helloTimeoutMs: 1_000,
    },
  );
  await new Promise<void>((resolve) =>
    http.listen(0, '127.0.0.1', resolve),
  );

  t.after(async () => {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) =>
      wss.close(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      http.close(() => resolve()),
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const url =
    'ws://127.0.0.1:' + address.port + '/agent';

  const first = new WebSocket(url, {
    headers: {
      Authorization: 'Bearer ' + issued.token,
    },
  });
  await new Promise<void>((resolve, reject) => {
    first.once('open', resolve);
    first.once('error', reject);
  });
  first.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId: '55555555-5555-4555-8555-555555555555',
      device: {
        id: 'credential-device',
        name: 'Credential Device',
        platform: process.platform,
        arch: process.arch,
        agentVersion: 'test',
        capabilities: ['machine.snapshot'],
      },
    }),
  );

  for (
    let i = 0;
    i < 50 && !broker.has('credential-device');
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has('credential-device'), true);

  await credentials.revoke(issued.credential.id);

  const status = await new Promise<number>((resolve, reject) => {
    const second = new WebSocket(url, {
      headers: {
        Authorization: 'Bearer ' + issued.token,
      },
    });
    second.once(
      'unexpected-response',
      (_request, response) => {
        resolve(response.statusCode ?? 0);
        second.terminate();
      },
    );
    second.once('open', () => {
      reject(
        new Error(
          'Revoked native-agent credential was accepted.',
        ),
      );
      second.close();
    });
    second.once('error', () => {
      // unexpected-response carries the HTTP status.
    });
  });

  assert.equal(status, 401);
  first.close();
});
