import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { reconnectWaitMs } from '../src/agent/native-agent.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

test('reconnect backoff applies bounded jitter', () => {
  assert.equal(reconnectWaitMs(1_000, () => 0), 800);
  assert.equal(reconnectWaitMs(1_000, () => 0.5), 1_000);
  assert.equal(reconnectWaitMs(1_000, () => 1), 1_200);
  assert.equal(reconnectWaitMs(100, () => 0), 250);
  assert.equal(reconnectWaitMs(60_000, () => 1), 30_000);
});

test('hub heartbeat keeps responsive native agents registered', async (t) => {
  const http = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(
    http,
    broker,
    'heartbeat-token',
    { heartbeatMs: 250, helloTimeoutMs: 1_000 },
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    for (const client of wss.clients) client.close();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  const address = http.address();
  assert.ok(address && typeof address === 'object');

  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/agent`,
    { headers: { Authorization: 'Bearer heartbeat-token' } },
  );
  let pings = 0;
  socket.on('ping', () => {
    pings++;
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  socket.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      instanceId: '22222222-2222-4222-8222-222222222222',
      device: {
        id: 'heartbeat-device',
        name: 'Heartbeat Device',
        platform: process.platform,
        arch: process.arch,
        agentVersion: 'test',
        capabilities: ['machine.snapshot'],
      },
    }),
  );

  for (let i = 0; i < 50 && !broker.has('heartbeat-device'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has('heartbeat-device'), true);

  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.ok(pings >= 2);
  assert.equal(broker.has('heartbeat-device'), true);

  socket.close();
});
