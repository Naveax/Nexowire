/**
 * Connection v2 relay benchmark: synthetic authenticated agents over real
 * loopback TLS/TCP/WebSocket. This is NOT hosted capacity or bandwidth evidence.
 * TLS key material exists only in the runner's temporary directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { AgentBroker } from '../src/core/agent-broker.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { startRelayServer } from '../src/relay/server.js';

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
        await until(() => relay.resourceSnapshot().activeConnections === 0, 7_000);
      } finally {
        for (const client of clients) if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }
    }
  }
});
