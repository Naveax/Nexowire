import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { NexowireError } from '../src/core/errors.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { CredentialStore } from '../src/security/credential-store.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

// Never uses a configured/live endpoint: both sides are anonymous ephemeral
// loopback HTTP listeners created inside this test process.
const TOKEN = 'proxy-test-only-no-production-credentials';
const delay = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, n));

async function until(ready: () => boolean, timeoutMs = 1800): Promise<void> {
  const untilAt = Date.now() + timeoutMs;
  while (!ready() && Date.now() < untilAt) await delay(10);
  assert.ok(ready(), 'expected isolated fault state before timeout');
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

interface Link {
  inbound: WebSocket;
  upstream: WebSocket;
  framesToHub: Array<{ type: string; requestId?: string }>;
}
interface LocalProxy {
  url: string;
  links: Link[];
  held: Array<{ link: Link; raw: RawData }>;
  drop(link: Link): void;
  close(): Promise<void>;
}

async function startProxy(targetUrl: string): Promise<LocalProxy> {
  // Deliberate hard gate against accidental forwarding to live services.
  const target = new URL(targetUrl);
  assert.equal(target.protocol, 'ws:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.pathname, '/agent');
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const links: Link[] = [];
  const held: Array<{ link: Link; raw: RawData }> = [];
  const blocked = new Set<string>();

  wss.on('connection', (inbound, request) => {
    const headers = request.headers.authorization
      ? { Authorization: request.headers.authorization }
      : undefined;
    const upstream = new WebSocket(targetUrl, headers ? { headers } : undefined);
    const link: Link = { inbound, upstream, framesToHub: [] };
    links.push(link);
    const buffered: RawData[] = [];
    const sendToHub = (raw: RawData) => {
      let frame: { type?: string; requestId?: string; capability?: string } = {};
      try { frame = JSON.parse(raw.toString()); } catch { /* invalid frames pass to hub */ }
      link.framesToHub.push({type: frame.type ?? 'invalid', ...(frame.requestId ? {requestId: frame.requestId} : {})});
      if (frame.type === 'response' && frame.requestId && blocked.has(frame.requestId)) {
        held.push({link, raw});
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
      else buffered.push(raw);
    };
    inbound.on('message', sendToHub);
    upstream.on('open', () => {
      for (const raw of buffered.splice(0)) sendToHub(raw);
    });
    upstream.on('message', (raw) => {
      if (inbound.readyState === WebSocket.OPEN) inbound.send(raw);
    });
    upstream.on('unexpected-response', (_request, response) => {
      // A revoked credential is rejected by the real Hub auth boundary.
      if (response.statusCode === 401) inbound.close(1008, 'rejected by hub');
      else inbound.close(1011, 'unexpected upstream response');
      upstream.terminate();
    });
    upstream.on('error', () => {
      if (inbound.readyState === WebSocket.OPEN) inbound.close(1011);
    });
    inbound.on('error', () => undefined);
    upstream.on('close', () => {
      if (inbound.readyState === WebSocket.OPEN) inbound.close();
    });
    inbound.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
  });
  const port = await listen(http);
  return {
    url: 'ws://127.0.0.1:' + port,
    links,
    held,
    drop(link) {
      link.inbound.terminate();
      link.upstream.terminate();
    },
    close: async () => {
      for (const link of links) {
        link.inbound.terminate();
        link.upstream.terminate();
      }
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
    block: (id: string) => blocked.add(id),
  } as LocalProxy & { block: (id: string) => void };
}

interface Fixture {
  broker: AgentBroker;
  proxy: LocalProxy & {block(id: string): void};
  credentialStore?: CredentialStore;
  cleanup(): Promise<void>;
}
async function fixture(useCredentialStore = false): Promise<Fixture> {
  let root: string | undefined;
  let store: CredentialStore | undefined;
  if (useCredentialStore) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-conn-proxy-'));
    store = new CredentialStore(root);
    await store.initialize();
  }
  const http = createServer();
  const broker = new AgentBroker({reconnectGraceMs: 450});
  const wss = attachAgentWebSocketServer(
    http, broker, useCredentialStore ? [] : TOKEN,
    { ...(store ? {credentialStore: store} : {}), heartbeatMs: 250, helloTimeoutMs: 1000 },
  );
  const port = await listen(http);
  const proxy = await startProxy('ws://127.0.0.1:' + port + '/agent') as Fixture['proxy'];
  return {
    broker, proxy, ...(store ? {credentialStore: store} : {}),
    async cleanup() {
      await proxy.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (root) await fs.rm(root, {recursive: true, force: true});
    },
  };
}

interface SimulatedAgent {
  socket: WebSocket;
  requests: Array<{requestId: string; capability: string}>;
}
async function connect(
  f: Fixture,
  deviceId: string,
  instanceId: string,
  token = TOKEN,
  onRequest?: (request: {requestId: string; capability: string}, socket: WebSocket) => void,
  expectedEpoch = 1,
): Promise<SimulatedAgent> {
  const socket = new WebSocket(f.proxy.url, {headers: {Authorization: 'Bearer ' + token}});
  const requests: SimulatedAgent['requests'] = [];
  socket.on('error', () => undefined);
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString()) as {type: string; requestId: string; capability: string};
    if (value.type !== 'request') return;
    requests.push({requestId: value.requestId, capability: value.capability});
    onRequest?.(value, socket);
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
      id: deviceId, name: 'Simulated ' + deviceId,
      platform: 'win32', arch: 'x64', agentVersion: '1.0.5',
      capabilities: ['machine.snapshot', 'files.write'],
    },
  }));
  await until(() => f.broker.getConnectionHealth(deviceId)?.epoch === expectedEpoch);
  return {socket, requests};
}

const outcome = (p: Promise<unknown>) => p.then(
  (result) => ({ok: true as const, result}),
  (error: unknown) => ({ok: false as const, error}),
);
function ack(socket: WebSocket, requestId: string): void {
  socket.send(JSON.stringify({
    type: 'response', requestId, ok: true, data: {data: {acknowledged: true}},
  }));
}
function assertUnknown(x: Awaited<ReturnType<typeof outcome>>): void {
  assert.equal(x.ok, false);
  if (x.ok) return;
  assert.ok(x.error instanceof NexowireError);
  assert.equal(x.error.code, 'MUTATION_STATE_UNKNOWN');
}

test('isolated WSS proxy holds mutation ACK then drops route; same instance reconnect never replays', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const deviceId = 'proxy-naveax';
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const requestId = randomUUID();
  f.proxy.block(requestId);
  let executions = 0;
  const first = await connect(f, deviceId, instanceId, TOKEN, (request, socket) => {
    if (request.capability === 'files.write') {
      executions++;
      ack(socket, request.requestId); // Proxy holds the actual on-wire Agent ACK.
    }
  });
  const result = outcome(f.broker.request(deviceId, 'files.write', {path: 'sim.txt'}, 2500, requestId));
  await until(() => f.proxy.held.length === 1);
  assert.equal(executions, 1);
  f.proxy.drop(f.proxy.links[0]!);
  await until(() => !f.broker.has(deviceId));
  const second = await connect(f, deviceId, instanceId, TOKEN, undefined, 2);
  assertUnknown(await result);
  await delay(45);
  assert.equal(second.requests.length, 0);
  assert.equal(executions, 1);
  assert.equal(f.proxy.held[0]?.link.framesToHub.some(x => x.requestId === requestId), true);
  assert.equal(f.broker.getConnectionHealth(deviceId)?.reconnectCount, 1);
  first.socket.terminate();
});

test('isolated proxy outage of Naveax leaves Work PC unaffected and read-only request resumes by original ID', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const idA = randomUUID();
  const idB = randomUUID();
  const first = await connect(f, 'proxy-naveax', '22222222-2222-4222-8222-222222222222');
  const workpc = await connect(f, 'proxy-workpc', '33333333-3333-4333-8333-333333333333', TOKEN, (r, s) => ack(s, r.requestId));
  const promiseA = f.broker.request('proxy-naveax', 'machine.snapshot', {}, 2500, idA);
  const promiseB = f.broker.request('proxy-workpc', 'machine.snapshot', {}, 2500, idB);
  await until(() => first.requests.length === 1);
  assert.equal(first.requests[0]?.requestId, idA);
  assert.deepEqual(await promiseB, {data: {acknowledged: true}});
  f.proxy.drop(f.proxy.links[0]!);
  await until(() => !f.broker.has('proxy-naveax'));
  const resumed = await connect(f, 'proxy-naveax', '44444444-4444-4444-8444-444444444444', TOKEN,
    (r, s) => ack(s, r.requestId), 2);
  assert.deepEqual(await promiseA, {data: {acknowledged: true}});
  assert.equal(resumed.requests[0]?.requestId, idA);
  assert.equal(f.broker.getConnectionHealth('proxy-workpc')?.epoch, 1);
  assert.equal(f.broker.getConnectionHealth('proxy-naveax')?.epoch, 2);
  assert.equal(workpc.requests[0]?.requestId, idB);
});

test('revoked credential blocks fresh proxy handshake after severed mutation; no replay', async (t) => {
  const f = await fixture(true);
  t.after(() => f.cleanup());
  const issued = await f.credentialStore!.issue('agent', {name: 'test revoked device'});
  const deviceId = 'proxy-revoked';
  const instance = '55555555-5555-4555-8555-555555555555';
  let executions = 0;
  const first = await connect(f, deviceId, instance, issued.token, () => { executions++; });
  const pending = outcome(f.broker.request(deviceId, 'files.write', {test: true}, 2000));
  await until(() => executions === 1);
  await f.credentialStore!.revoke(issued.credential.id);
  // Deliberately simulate transport loss: existing WSS revocation is NOT
  // provided by this scope and must not be falsely called production-accepted.
  f.proxy.drop(f.proxy.links[0]!);
  assertUnknown(await pending);
  let rejected = false;
  const second = new WebSocket(f.proxy.url, {
    headers: {Authorization: 'Bearer ' + issued.token},
  });
  second.on('error', () => undefined);
  second.on('close', () => { rejected = true; });
  await until(() => rejected);
  assert.equal(f.broker.has(deviceId), false);
  assert.equal(executions, 1);
  first.socket.terminate();
});


test('duplicate authenticated socket through proxy fences prior mutation and increments epoch', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const instanceId = '66666666-6666-4666-8666-666666666666';
  const first = await connect(f, 'proxy-duplicate', instanceId);
  const id = randomUUID();
  const pending = outcome(f.broker.request('proxy-duplicate', 'files.write', {x: true}, 1800, id));
  await until(() => first.requests.length === 1);
  const second = await connect(f, 'proxy-duplicate', instanceId, TOKEN, undefined, 2);
  assertUnknown(await pending);
  await delay(40);
  assert.equal(second.requests.length, 0);
  assert.equal(first.requests[0]?.requestId, id);
  assert.equal(f.broker.getConnectionHealth('proxy-duplicate')?.epoch, 2);
  assert.equal(f.broker.getConnectionHealth('proxy-duplicate')?.lastDisconnectReason, 'replaced');
});

test('cross-device forged ACK through proxy cannot satisfy another device request', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const a = await connect(f, 'proxy-device-A', '77777777-7777-4777-8777-777777777777');
  const b = await connect(f, 'proxy-device-B', '88888888-8888-4888-8888-888888888888');
  const id = randomUUID();
  let confirmed = false;
  const pending = f.broker.request('proxy-device-A', 'machine.snapshot', {}, 1700, id)
    .then((v) => { confirmed = true; return v; });
  await until(() => a.requests.length === 1);
  // Device B has an authenticated WSS but has no authority over A's UUID.
  ack(b.socket, id);
  await delay(55);
  assert.equal(confirmed, false);
  assert.equal(f.broker.getConnectionHealth('proxy-device-A')?.lastAgentAckAt, undefined);
  ack(a.socket, id);
  assert.deepEqual(await pending, {data: {acknowledged: true}});
  assert.equal(f.broker.getConnectionHealth('proxy-device-A')?.lastAgentAckOk, true);
});
