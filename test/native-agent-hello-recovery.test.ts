import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { sendAgentHelloWhenReady } from '../src/agent/native-agent.js';

function fakeSocket() {
  const frames: string[] = [];
  let terminated = 0;
  const socket = {
    readyState: WebSocket.OPEN as number,
    send(data: string) { frames.push(data); },
    terminate() { terminated++; },
  };
  return { socket, frames, get terminated() { return terminated; } };
}

test('Admin Bridge probe succeeds: Agent hello advertises only verified elevation', async () => {
  const f = fakeSocket();
  assert.equal(await sendAgentHelloWhenReady(
    f.socket as unknown as WebSocket,
    async () => ({ reachable: true, elevated: true }),
    (result) => ({ type: 'hello', adminBridgeReady: result.reachable && result.elevated }),
  ), true);
  assert.deepEqual(JSON.parse(f.frames[0]!), { type: 'hello', adminBridgeReady: true });
  assert.equal(f.terminated, 0);
});

test('Admin Bridge unavailable or failing does not prevent a safe Agent hello', async () => {
  for (const probe of [
    async () => { throw new Error('simulated broker unreachable'); },
    async () => ({ reachable: true, elevated: false }),
    async () => ({ reachable: false, elevated: true }),
  ]) {
    const f = fakeSocket();
    assert.equal(await sendAgentHelloWhenReady(
      f.socket as unknown as WebSocket,
      probe,
      (result) => ({ adminBridgeReady: result.reachable && result.elevated }),
    ), true);
    assert.deepEqual(JSON.parse(f.frames[0]!), { adminBridgeReady: false });
  }
});

test('socket closed while probe is pending never sends a stale Agent hello', async () => {
  const f = fakeSocket();
  let release!: (value: {reachable: boolean; elevated: boolean}) => void;
  const probe = new Promise<{reachable: boolean; elevated: boolean}>(
    (resolve) => { release = resolve; },
  );
  const pending = sendAgentHelloWhenReady(
    f.socket as unknown as WebSocket,
    () => probe,
    (result) => ({ type: 'hello', result }),
  );
  f.socket.readyState = WebSocket.CLOSED;
  release({ reachable: true, elevated: true });
  assert.equal(await pending, false);
  assert.deepEqual(f.frames, []);
  assert.equal(f.terminated, 0);
});

test('send failure terminates stale WSS rather than throwing out of open handler', async () => {
  const f = fakeSocket();
  f.socket.send = () => { throw new Error('simulated close race'); };
  const success = await sendAgentHelloWhenReady(
    f.socket as unknown as WebSocket,
    async () => ({ reachable: false, elevated: false }),
    () => ({ type: 'hello' }),
  );
  assert.equal(success, false);
  assert.equal(f.terminated, 1);
});


test('hung Admin Bridge probe has a strict pre-hello budget', async () => {
  const f = fakeSocket();
  const started = Date.now();
  const ok = await sendAgentHelloWhenReady(
    f.socket as unknown as WebSocket,
    async () => new Promise<{reachable: boolean; elevated: boolean}>(() => {}),
    (result) => ({ type: 'hello', adminBridgeReady: result.reachable && result.elevated }),
    40,
  );
  assert.equal(ok, true);
  assert.ok(Date.now() - started < 800, 'probe budget should finish far before default hub hello timeout');
  assert.deepEqual(JSON.parse(f.frames[0]!), { type: 'hello', adminBridgeReady: false });
  assert.equal(f.terminated, 0);
});
