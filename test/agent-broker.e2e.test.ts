import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

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
