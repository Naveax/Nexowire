import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

test('hub sends a capability request through a real WebSocket agent', async (t) => {
  const http = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(http, broker, 'test-agent-token');
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
    headers: { Authorization: 'Bearer test-agent-token' },
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
  socket.close();
});
