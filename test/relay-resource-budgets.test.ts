import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect as connectTcp } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { startRelayServer } from '../src/relay/server.js';
import { assertSafeRelayConfig, loadRelayConfig, type NexowireRelayConfig } from '../src/relay/config.js';

function relayConfig(upstreamPort: number, overrides: Partial<NexowireRelayConfig> = {}): NexowireRelayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    upstreamWsUrl: 'ws://127.0.0.1:' + upstreamPort + '/agent',
    inboundAgentTokens: ['test-only-relay-bearer'],
    heartbeatMs: 1_000,
    maxPayloadBytes: 64 * 1024,
    ...overrides,
  };
}

async function boundServer(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return addr.port;
}

function ws(url: string): WebSocket {
  const client = new WebSocket(url, {
    headers: { Authorization: 'Bearer test-only-relay-bearer' },
    perMessageDeflate: false,
  });
  // Underlying TCP rejection also raises error on some Windows runners.
  client.on('error', () => {});
  return client;
}

function open(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
}

function status(client: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upgrade rejection timeout')), 5_000);
    client.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once('open', () => {
      clearTimeout(timer);
      reject(new Error('Unexpected WebSocket upgrade success'));
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function closed(client: WebSocket, ms = 3_000): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), ms);
    client.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('resource budgets reject partial numbers, negative and oversized values', () => {
  assert.throws(() => loadRelayConfig({NEXOWIRE_RELAY_MAX_CONNECTIONS: '12suffix'}), /Invalid NEXOWIRE_RELAY_MAX_CONNECTIONS/);
  assert.throws(() => loadRelayConfig({NEXOWIRE_RELAY_MAX_CONNECTIONS: '513'}), /Invalid NEXOWIRE_RELAY_MAX_CONNECTIONS/);
  assert.throws(() => loadRelayConfig({NEXOWIRE_RELAY_UPSTREAM_HANDSHAKE_TIMEOUT_MS: '100'}), /Invalid NEXOWIRE_RELAY_UPSTREAM_HANDSHAKE_TIMEOUT_MS/);
  assert.throws(() => assertSafeRelayConfig(relayConfig(43110, {maxConnections: 0})), /maxConnections/);
  assert.throws(() => assertSafeRelayConfig(relayConfig(43110, {shutdownGraceMs: -1})), /shutdownGraceMs/);
  const loaded = loadRelayConfig({
    NEXOWIRE_RELAY_MAX_CONNECTIONS: '128',
    NEXOWIRE_RELAY_UPSTREAM_HANDSHAKE_TIMEOUT_MS: '4000',
    NEXOWIRE_RELAY_SHUTDOWN_GRACE_MS: '800',
  });
  assert.equal(loaded.maxConnections, 128);
  assert.equal(loaded.upstreamHandshakeTimeoutMs, 4000);
  assert.equal(loaded.shutdownGraceMs, 800);
  assert.throws(() => loadRelayConfig({ NEXOWIRE_RELAY_GLOBAL_MEMORY_BUDGET_BYTES: '33MiB' }), /GLOBAL_MEMORY_BUDGET_BYTES/);
  assert.throws(() => loadRelayConfig({ NEXOWIRE_RELAY_MAX_PENDING_HANDSHAKES: '0' }), /MAX_PENDING_HANDSHAKES/);
  assert.throws(() => assertSafeRelayConfig(relayConfig(43110, { globalMemoryBudgetBytes: 0 })), /globalMemoryBudgetBytes/);
  assert.equal(loadRelayConfig({ NEXOWIRE_RELAY_GLOBAL_MEMORY_BUDGET_BYTES: '33554432' }).globalMemoryBudgetBytes, 33554432);
});

test('unknown upgrade path and normal HTTP GET fail closed without spawning upstream', async t => {
  const relay = await startRelayServer(relayConfig(9));
  t.after(() => relay.close());
  assert.equal(await status(ws(relay.url.replace('/agent', '/admin'))), 404);
  assert.equal(await status(ws(relay.url + '?debug=1')), 404);
  const response = await fetch(relay.url.replace('ws:', 'http:').replace('/agent','/health'));
  assert.equal(response.status, 404);
  await response.body?.cancel();
});

test('one stalled upstream occupies only one slot and fails at handshake deadline', async t => {
  const upstream = createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  upstream.on('upgrade', (_req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Deliberately never send HTTP 101.
  });
  const port = await boundServer(upstream);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const relay = await startRelayServer(relayConfig(port, {
    maxConnections: 1,
    upstreamHandshakeTimeoutMs: 1_000,
    shutdownGraceMs: 100,
  }));
  t.after(() => relay.close());
  const first = ws(relay.url);
  await open(first);
  assert.equal(await status(ws(relay.url)), 503);
  await closed(first, 4_000);
  // ws removes its server-side client on a separate close callback tick.
  // Wait a bounded interval rather than assuming the two close events race in one order.
  const deadline = Date.now() + 1_500;
  while (relay.wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(relay.wss.clients.size, 0);
});

test('shutdown is idempotent and cannot hang on an unresponsive upstream', async t => {
  const upstream = createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  upstream.on('upgrade', (_req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await boundServer(upstream);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const relay = await startRelayServer(relayConfig(port, {
    maxConnections: 1,
    upstreamHandshakeTimeoutMs: 3_000,
    shutdownGraceMs: 100,
  }));
  const first = ws(relay.url);
  await open(first);
  const before = Date.now();
  await Promise.all([relay.close(), relay.close()]);
  assert.ok(Date.now() - before < 2_000, 'shutdown should terminate the stuck pair');
  await closed(first, 2_000);
  await until(() => relay.resourceSnapshot().totalReservedBytes === 0);
  assert.equal(relay.resourceSnapshot().reservedConnectionSlots, 0);
});



test('oversized incoming frame closes with protocol code 1009, not an upstream delivery', async t => {
  const http = createServer();
  const upstream = new WebSocketServer({ server: http });
  let received = 0;
  upstream.on('connection', socket => { socket.on('message', () => { received++; }); });
  const port = await boundServer(http);
  const relay = await startRelayServer(relayConfig(port));
  t.after(async () => {
    await relay.close();
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const client = ws(relay.url);
  await open(client);
  const code = new Promise<number>(resolve => client.once('close', c => resolve(c)));
  client.send(Buffer.alloc(65 * 1024));
  assert.equal(await code, 1009);
  assert.equal(received, 0);
});

test('stalled upstream exhausts only the 2 MiB pre-handshake queue and releases bytes', async t => {
  const upstream = createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  upstream.on('upgrade', (_req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await boundServer(upstream);
  const relay = await startRelayServer(relayConfig(port, {
    upstreamHandshakeTimeoutMs: 5_000,
    shutdownGraceMs: 200,
  }));
  t.after(async () => {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const client = ws(relay.url);
  await open(client);
  const closure = new Promise<number>(resolve => client.once('close', code => resolve(code)));
  for (let i = 0; i < 40; i++) {
    if (client.readyState !== WebSocket.OPEN) break;
    client.send(Buffer.alloc(64 * 1024));
  }
  assert.equal(await closure, 1013);
  await until(() => relay.resourceSnapshot().startupQueuedBytes === 0);
  assert.equal(relay.resourceSnapshot().startupQueuedFrames, 0);
  assert.ok(relay.resourceSnapshot().peakStartupQueuedBytes <= 2 * 1024 * 1024);
});

test('partial HTTP slowloris headers allocate no authenticated relay pair', async t => {
  const relay = await startRelayServer(relayConfig(9));
  const address = relay.server.address();
  assert.ok(address && typeof address === 'object');
  const sockets = Array.from({ length: 32 }, () => connectTcp(address.port, '127.0.0.1'));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await relay.close();
  });
  await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.write('GET /agent HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer ');
      resolve();
    });
    socket.once('error', reject);
  })));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(relay.wss.clients.size, 0);
  assert.equal(relay.resourceSnapshot().connectingUpstreams, 0);
  assert.equal(relay.server.headersTimeout, 10_000);
  assert.equal(relay.server.requestTimeout, 10_000);
});


test('global queue budget fails closed, releases every reservation and preserves fast-peer response', { timeout: 20_000 }, async t => {
  const upstream = createServer();
  const healthy = new WebSocketServer({ noServer: true });
  const held = new Set<import('node:stream').Duplex>();
  let upstreamNumber = 0;
  upstream.on('upgrade', (req, socket, head) => {
    if (upstreamNumber++ === 0) {
      held.add(socket);
      socket.once('close', () => held.delete(socket));
      return;
    }
    healthy.handleUpgrade(req, socket, head, peer => {
      healthy.emit('connection', peer, req);
    });
  });
  const broker = new AgentBroker();
  healthy.on('connection', peer => peer.once('message', raw => {
    broker.register(peer, JSON.parse(raw.toString()));
  }));
  const port = await boundServer(upstream);
  const relay = await startRelayServer(relayConfig(port, {
    maxConnections: 2,
    // 128 KiB frame ceiling keeps the per-pair queue above the shared cap.
    maxPayloadBytes: 128 * 1024,
    globalMemoryBudgetBytes: 256 * 1024,
    upstreamHandshakeTimeoutMs: 8_000,
    shutdownGraceMs: 150,
  }));
  t.after(async () => {
    await relay.close();
    for (const peer of healthy.clients) peer.terminate();
    for (const socket of held) socket.destroy();
    await new Promise<void>(resolve => healthy.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const slow = ws(relay.url);
  await open(slow);
  const fast = ws(relay.url);
  await open(fast);
  await until(() => relay.resourceSnapshot().pendingUpstreamHandshakes === 1);
  const initial = relay.resourceSnapshot();
  assert.equal(initial.reservedConnectionSlots, 2);
  assert.equal(initial.connectionReservedBytes, 2 * 64 * 1024);
  assert.equal(initial.globalMemoryBudgetBytes, 256 * 1024);
  const data = Buffer.alloc(64 * 1024, 7);
  slow.send(data);
  await until(() => relay.resourceSnapshot().startupQueuedBytes === 64 * 1024);
  const atCapacity = relay.resourceSnapshot();
  assert.equal(atCapacity.totalReservedBytes, 192 * 1024);
  assert.equal(atCapacity.queueControlHeadroomBytes, 64 * 1024);
  assert.ok(atCapacity.peakTotalReservedBytes <= 256 * 1024);
  // A real read-only Broker ACK must complete while the other peer is stalled.
  const fastId = 'v2-05-budget-fast-peer';
  fast.on('message', raw => {
    const request = JSON.parse(raw.toString()) as { type?: string; requestId?: string };
    if (request.type !== 'request' || !request.requestId) return;
    fast.send(JSON.stringify({
      type: 'response', requestId: request.requestId, ok: true,
      data: { data: { via: 'fast-peer-ack' } },
    }));
  });
  fast.send(JSON.stringify({
    type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId: randomUUID(),
    device: { id: fastId, name: 'Fast Peer', platform: 'linux', arch: 'x64',
      agentVersion: 'budget-qa', capabilities: ['machine.snapshot'] },
  }));
  await until(() => broker.has(fastId));
  const answer = await broker.request(fastId, 'machine.snapshot', {}, 3_000) as {
    data?: { via?: string };
  };
  assert.equal(answer.data?.via, 'fast-peer-ack');
  assert.equal(relay.resourceSnapshot().startupQueuedBytes, 64 * 1024);
  const slowClosed = closed(slow, 4_000);
  slow.send(data);
  await slowClosed;
  await until(() => relay.resourceSnapshot().startupQueuedBytes === 0);
  assert.ok(relay.resourceSnapshot().budgetRejectionCount >= 1);
  assert.equal(relay.resourceSnapshot().reservedConnectionSlots, 1);
  fast.close();
  await closed(fast);
  await until(() => relay.resourceSnapshot().totalReservedBytes === 0);
  const after = relay.resourceSnapshot();
  assert.equal(after.connectionReservedBytes, 0);
  assert.equal(after.inflightReservedBytes, 0);
  assert.equal(after.startupQueuedBytes, 0);
  assert.equal(after.startupQueuedFrames, 0);
  assert.equal(after.reservedConnectionSlots, 0);
  assert.equal(after.pendingUpstreamHandshakes, 0);
});


test('global connection reservation cap rejects fifth upgrade with HTTP 503 and drains on close', async t => {
  const upstream = createServer();
  const service = new WebSocketServer({ server: upstream });
  const port = await boundServer(upstream);
  const relay = await startRelayServer(relayConfig(port, {
    maxConnections: 8,
    maxPendingUpstreamHandshakes: 8,
    globalMemoryBudgetBytes: 256 * 1024,
  }));
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await relay.close();
    for (const peer of service.clients) peer.terminate();
    await new Promise<void>(resolve => service.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  for (let n = 0; n < 4; n++) {
    const client = ws(relay.url);
    clients.push(client);
    await open(client);
  }
  await until(() => relay.resourceSnapshot().pendingUpstreamHandshakes === 0);
  const full = relay.resourceSnapshot();
  assert.equal(full.reservedConnectionSlots, 4);
  assert.equal(full.totalReservedBytes, 256 * 1024);
  assert.equal(full.connectionReservedBytes, 256 * 1024);
  assert.equal(await status(ws(relay.url)), 503);
  assert.equal(relay.resourceSnapshot().reservedConnectionSlots, 4);
  assert.equal(relay.resourceSnapshot().overload503Count, 1);
  for (const client of clients) client.close();
  await Promise.all(clients.map(client => closed(client)));
  await until(() => relay.resourceSnapshot().totalReservedBytes === 0);
  const released = relay.resourceSnapshot();
  assert.equal(released.connectionReservedBytes, 0);
  assert.equal(released.inflightReservedBytes, 0);
  assert.equal(released.startupQueuedBytes, 0);
  assert.equal(released.pendingUpstreamHandshakes, 0);
  assert.equal(released.reservedConnectionSlots, 0);
});

test('pending handshake limit rejects a new authenticated upgrade with 503 before allocating upstream', async t => {
  const upstream = createServer();
  const held = new Set<import('node:stream').Duplex>();
  let attempts = 0;
  upstream.on('upgrade', (_req, socket) => {
    ++attempts;
    held.add(socket);
    socket.once('close', () => held.delete(socket));
  });
  const port = await boundServer(upstream);
  const relay = await startRelayServer(relayConfig(port, {
    maxConnections: 3,
    maxPendingUpstreamHandshakes: 1,
    globalMemoryBudgetBytes: 256 * 1024,
    upstreamHandshakeTimeoutMs: 1_000,
  }));
  t.after(async () => {
    await relay.close();
    for (const socket of held) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const first = ws(relay.url);
  await open(first);
  await until(() => relay.resourceSnapshot().pendingUpstreamHandshakes === 1);
  assert.equal(await status(ws(relay.url)), 503);
  assert.equal(attempts, 1);
  assert.equal(relay.resourceSnapshot().reservedConnectionSlots, 1);
  await closed(first, 4_000);
  await until(() => relay.resourceSnapshot().totalReservedBytes === 0);
  assert.equal(relay.resourceSnapshot().pendingUpstreamHandshakes, 0);
});

/** Isolated test runner: actual WSS + native AgentBroker request completions. */
function percentile(values: number[], percent: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(percent * sorted.length) - 1]!.toFixed(3));
}

function opensslPath(): string {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate !== 'openssl' && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 5_000 });
      return candidate;
    } catch { /* Try the next known Windows runner path. */ }
  }
  throw new Error('WSS benchmark requires OpenSSL on the isolated runner; no insecure WS substitution.');
}

function checkoutIdentity(): { checkoutSha: string; prHeadSha: string | null } {
  let checkoutSha = 'unknown';
  let prHeadSha: string | null = null;
  try { checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* non-repo execution */ }
  try {
    const eventFile = process.env['GITHUB_EVENT_PATH'];
    if (eventFile) {
      const event = JSON.parse(readFileSync(eventFile, 'utf8')) as {
        pull_request?: { head?: { sha?: string } };
      };
      prHeadSha = event.pull_request?.head?.sha ?? null;
    }
  } catch { /* local execution */ }
  return { checkoutSha, prHeadSha };
}

function newClient(url: string, ca: Buffer): WebSocket {
  const client = new WebSocket(url, {
    ca,
    headers: { Authorization: 'Bearer v2-05-isolated-benchmark' },
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  client.on('error', () => { /* Rejection is asserted by the pending handshake promise. */ });
  return client;
}

async function connect(client: WebSocket): Promise<number> {
  const start = performance.now();
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WSS handshake exceeded 10 seconds')), 10_000);
    client.once('open', () => { clearTimeout(timer); resolve(performance.now() - start); });
    client.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error('Unexpected HTTP ' + response.statusCode + ' for admitted client'));
    });
    client.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function expect503(client: WebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Overload response timeout')), 10_000);
    client.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once('open', () => {
      clearTimeout(timer);
      reject(new Error('Over-capacity WSS client unexpectedly admitted'));
    });
    client.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for authenticated agent or cleanup');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('isolated WSS relay: 1/32/64/101/128/129/256 attempts, real Broker ACKs and 503 overload', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nexowire-v2-05-'));
  const keyFile = join(directory, 'ephemeral.key');
  const certFile = join(directory, 'ephemeral.crt');
  const openssl = opensslPath();
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 15_000 });
  const ca = await readFile(certFile);
  const upstreamHttp = createServer();
  const broker = new AgentBroker({ maxEvents: 512, maxEventBytes: 1_048_576 });
  const upstreamWss = attachAgentWebSocketServer(upstreamHttp, broker, undefined, {
    heartbeatMs: 60_000, helloTimeoutMs: 10_000,
  });
  await new Promise<void>(resolve => upstreamHttp.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstreamHttp.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    tlsCertFile: certFile,
    tlsKeyFile: keyFile,
    upstreamWsUrl: 'ws://127.0.0.1:' + upstreamAddress.port + '/agent',
    inboundAgentTokens: ['v2-05-isolated-benchmark'],
    heartbeatMs: 60_000,
    maxPayloadBytes: 64 * 1024,
    maxConnections: 128,
    upstreamHandshakeTimeoutMs: 10_000,
    shutdownGraceMs: 1_500,
  });
  t.after(async () => {
    await relay.close();
    for (const socket of upstreamWss.clients) socket.terminate();
    await new Promise<void>(resolve => upstreamWss.close(() => resolve()));
    await new Promise<void>(resolve => upstreamHttp.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  assert.match(relay.url, /^wss:\/\/127\.0\.0\.1:/);
  const identity = checkoutIdentity();
  const scenarios = [1, 32, 64, 101, 128, 129, 256];
  for (const attempts of scenarios) {
    const admitted = Math.min(attempts, 128);
    const rejected = Math.max(0, attempts - admitted);
    const clients: WebSocket[] = [];
    const handshakeMs: number[] = [];
    const completionMs: number[] = [];
    const deviceIds: string[] = [];
    let applicationBytes = 0;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    let peakRss = process.memoryUsage().rss;
    const rssTimer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    rssTimer.unref();
    const before = relay.resourceSnapshot();
    try {
      // Batches avoid exhausting the runner's ephemeral TCP port backlog.
      for (let offset = 0; offset < admitted; offset += 16) {
        const current = Array.from({ length: Math.min(16, admitted - offset) }, (_, j) => {
          const index = offset + j;
          const client = newClient(relay.url, ca);
          clients.push(client);
          return connect(client).then(ms => {
            handshakeMs.push(ms);
            const deviceId = 'v2-05-' + attempts + '-' + index;
            deviceIds.push(deviceId);
            client.on('message', raw => {
              let request: { type?: string; requestId?: string };
              try { request = JSON.parse(raw.toString()) as typeof request; } catch { return; }
              if (request.type !== 'request' || !request.requestId) return;
              const reply = JSON.stringify({
                type: 'response', requestId: request.requestId, ok: true,
                data: { data: { via: 'v2-05-wss', deviceId } },
              });
              applicationBytes += Buffer.byteLength(raw.toString()) + Buffer.byteLength(reply);
              client.send(reply);
            });
            client.send(JSON.stringify({
              type: 'hello',
              protocolVersion: AGENT_PROTOCOL_VERSION,
              instanceId: randomUUID(),
              device: {
                id: deviceId, name: deviceId, platform: 'linux', arch: 'x64',
                agentVersion: 'v2-05-benchmark', capabilities: ['machine.snapshot'],
              },
            }));
          });
        });
        await Promise.all(current);
      }
      await until(() => deviceIds.every(id => broker.has(id)));
      assert.equal(relay.resourceSnapshot().activeConnections, admitted);
      if (rejected) {
        // Existing 128 authenticated sessions remain held open during overload.
        const overloadClients = Array.from({ length: rejected }, () => newClient(relay.url, ca));
        clients.push(...overloadClients);
        const statuses = await Promise.all(overloadClients.map(expect503));
        assert.deepEqual([...new Set(statuses)], [503]);
      }
      const completions = await Promise.all(deviceIds.map(async id => {
        const at = performance.now();
        const value = await broker.request(id, 'machine.snapshot', {}, 10_000) as {
          data?: { via?: string; deviceId?: string };
        };
        completionMs.push(performance.now() - at);
        assert.equal(value.data?.via, 'v2-05-wss');
        assert.equal(value.data?.deviceId, id);
        return value;
      }));
      assert.equal(completions.length, admitted);
      const snapshot = relay.resourceSnapshot();
      assert.equal(snapshot.overload503Count - before.overload503Count, rejected);
      assert.equal(snapshot.activeConnections, admitted);
      assert.ok(snapshot.startupQueuedBytes <= 2 * 1024 * 1024 * admitted);
      assert.equal(snapshot.reservedConnectionSlots, admitted);
      assert.equal(snapshot.connectionReservedBytes, admitted * 64 * 1024);
      assert.ok(snapshot.totalReservedBytes <= snapshot.globalMemoryBudgetBytes);
      assert.ok(snapshot.peakTotalReservedBytes <= snapshot.globalMemoryBudgetBytes);
      assert.equal(snapshot.totalReservedBytes,
        snapshot.connectionReservedBytes + snapshot.startupQueuedBytes + snapshot.inflightReservedBytes);
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuBefore);
      const row = {
        mode: 'isolated-loopback-TLS-TCP-WSS-authenticated-Broker-ACK',
        environment: { platform: process.platform, arch: process.arch, node: process.version, runner: process.env['RUNNER_NAME'] ?? 'local' },
        ...identity,
        attempts, admitted, rejected503: rejected,
        brokerAckCompleted: completions.length,
        transportOpenOnlyIsNotCompletion: true,
        handshakeP50Ms: percentile(handshakeMs, 0.50),
        handshakeP95Ms: percentile(handshakeMs, 0.95),
        handshakeP99Ms: percentile(handshakeMs, 0.99),
        completionP50Ms: percentile(completionMs, 0.50),
        completionP95Ms: percentile(completionMs, 0.95),
        completionP99Ms: percentile(completionMs, 0.99),
        elapsedMs: Number(elapsedMs.toFixed(3)),
        cpuOneCorePercent: Number(((cpu.user + cpu.system) / (elapsedMs * 1000) * 100).toFixed(2)),
        peakProcessRssBytes: peakRss,
        startupQueuedBytes: snapshot.startupQueuedBytes,
        peakStartupQueuedBytes: snapshot.peakStartupQueuedBytes,
        startupQueuedFrames: snapshot.startupQueuedFrames,
        peakStartupQueuedFrames: snapshot.peakStartupQueuedFrames,
        outboundBufferedBytes: snapshot.outboundBufferedBytes,
        globalMemoryBudgetBytes: snapshot.globalMemoryBudgetBytes,
        queueControlHeadroomBytes: snapshot.queueControlHeadroomBytes,
        reservedBytes: snapshot.totalReservedBytes,
        peakReservedBytes: snapshot.peakTotalReservedBytes,
        connectionReservedBytes: snapshot.connectionReservedBytes,
        inflightReservedBytes: snapshot.inflightReservedBytes,
        peakInflightReservedBytes: snapshot.peakInflightReservedBytes,
        reservedConnectionSlots: snapshot.reservedConnectionSlots,
        pendingAdmissions: snapshot.pendingAdmissions,
        pendingUpstreamHandshakes: snapshot.pendingUpstreamHandshakes,
        budgetRejectionCount: snapshot.budgetRejectionCount,
        peakPerConnectionQueuedBytes: snapshot.peakPerConnectionQueuedBytes,
        peakPerConnectionInflightBytes: snapshot.peakPerConnectionInflightBytes,
        applicationBytes,
        verifiedFileBytes: 0,
        fairnessCompletedRatio: Number((completions.length / admitted).toFixed(5)),
        disconnectCodes: snapshot.disconnectCodes,
        gigabyteFileTransfer: 'NOT_RUN',
      };
      console.log('RELAY_V2_05_BENCH_JSON=' + JSON.stringify(row));
    } finally {
      clearInterval(rssTimer);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.close(1000, 'Benchmark finished');
        else if (client.readyState === WebSocket.CONNECTING) client.terminate();
      }
      try {
        await until(() => {
          const s = relay.resourceSnapshot();
          return s.activeConnections === 0 && s.reservedConnectionSlots === 0 &&
            s.totalReservedBytes === 0 && s.pendingAdmissions === 0 &&
            s.pendingUpstreamHandshakes === 0 && s.startupQueuedFrames === 0;
        }, 7_000);
      } finally {
        for (const client of clients) if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }
    }
  }
});
