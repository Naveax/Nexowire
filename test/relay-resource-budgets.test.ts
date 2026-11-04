import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
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
});
