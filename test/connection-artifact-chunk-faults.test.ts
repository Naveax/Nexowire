import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
import { ingestDeviceArtifact, type ArtifactSourceOps } from '../src/mcp/artifact-bridge-device-ingest.js';

// Synthetic 512 KiB payloads live only inside this test and a disposable temp
// ArtifactBridgeStore. Never opens real Agent file paths, tunnels or devices.
const bytes = Buffer.alloc(512 * 1024 + 37).map((_, i) => (i * 13 + 7) % 251);
const digest = createHash('sha256').update(bytes).digest('hex');
const device = 'synthetic-naveax';
const scope = { accountId: 'isolated-test-account', projectId: 'Nexowire', deviceId: device };
const params = {
  scope, sourcePath: 'C:\\synthetic-only\\chunks.bin',
  artifactPath: 'fault-injection/test-only-512KiB.bin',
  repository: 'Naveax/Nexowire',
  commitSha: 'c'.repeat(40), producerOperationId: 'synthetic-transfer-01',
  testStatus: 'unverified' as const,
  acceptanceStatus: 'pending' as const,
  maxChunks: 3,
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function wsSource(dropReadOrdinal: number | undefined) {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const token = 'only-for-localhost-test';
  let reads = 0;
  const requests: Array<{ requestId: string; offset: number; count: number }> = [];

  server.on('connection', (socket, request) => {
    // A deliberately isolated source, not production auth. It enforces a
    // test-only exact synthetic identity to catch accidental misrouting.
    if (request.headers.authorization !== 'Bearer ' + token ||
        request.headers['x-test-device-id'] !== device) {
      socket.close(1008, 'wrong synthetic source');
      return;
    }
    socket.on('message', raw => {
      let input: { requestId: string; offset: number; size: number; type: string };
      try {
        input = JSON.parse(raw.toString()) as typeof input;
      } catch { socket.close(1007); return; }
      if (input.type !== 'read' ||
          !/^[a-f0-9-]{36}$/.test(input.requestId) ||
          !Number.isSafeInteger(input.offset) ||
          !Number.isSafeInteger(input.size) ||
          input.size < 1 || input.size > 65_536 ||
          input.offset + input.size > bytes.length) {
        socket.close(1008, 'invalid bounded test read');
        return;
      }
      reads++;
      requests.push({ requestId: input.requestId, offset: input.offset, count: reads });
      if (dropReadOrdinal === reads) {
        socket.terminate(); // Lost on-wire response, never mutates source.
        return;
      }
      // Deliberately include a stale wrong requestId frame before the correct
      // frame, proving our test reader requires exact pending requestId.
      const chunk = Buffer.from(bytes.subarray(input.offset, input.offset + input.size));
      socket.send(JSON.stringify({
        type: 'read-result', requestId: randomUUID(), sourceBytes: bytes.length,
        offsetBytes: input.offset, bytesRead: input.size,
        contentBase64: chunk.toString('base64'),
      }));
      socket.send(JSON.stringify({
        type: 'read-result', requestId: input.requestId, sourceBytes: bytes.length,
        offsetBytes: input.offset, bytesRead: input.size,
        contentBase64: chunk.toString('base64'),
      }));
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()));
  const addr = http.address();
  assert.ok(addr && typeof addr === 'object');
  const socket = new WebSocket('ws://127.0.0.1:' + addr.port, {
    headers: { authorization: 'Bearer ' + token, 'x-test-device-id': device },
  });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pending = new Map<string, {
    resolve: (value: Awaited<ReturnType<ArtifactSourceOps['read']>>) => void;
    reject: (reason: Error) => void;
  }>();
  let staleFrames = 0;
  socket.on('message', raw => {
    let result: Awaited<ReturnType<ArtifactSourceOps['read']>> & {
      type?: string; requestId?: string;
    };
    try { result = JSON.parse(raw.toString()) as typeof result; } catch { return; }
    const waiting = result.requestId ? pending.get(result.requestId) : undefined;
    if (!waiting || result.type !== 'read-result') { staleFrames++; return; }
    pending.delete(result.requestId!);
    waiting.resolve(result);
  });
  socket.on('close', () => {
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(new Error('ISOLATED_WS_ROUTE_DROPPED'));
    }
  });
  const ops: ArtifactSourceOps = {
    stat: async () => ({ type: 'file', size: bytes.length }),
    sha256: async () => digest,
    read: (_path, offset, size) =>
      new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('ISOLATED_WS_ROUTE_DROPPED'));
          return;
        }
        const requestId = randomUUID();
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ type: 'read', requestId, offset, size }));
      }),
  };
  return {
    ops,
    requests,
    get staleFrames() { return staleFrames; },
    async close() {
      socket.terminate();
      for (const c of server.clients) c.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}

test('>220 KiB Artifact Bridge survives isolated WSS reader drop, store re-open and exact-offset resume', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-conn-artifact-fault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await wsSource(5); // Four persisted 64-KiB chunks (256 KiB)
  t.after(() => first.close());
  const initialStore = new ArtifactBridgeStore(dir);
  await assert.rejects(
    async () => {
      // 3 chunks/call, intentionally crossing a batch boundary before drop.
      for (;;) {
        const result = await ingestDeviceArtifact(initialStore, first.ops, params);
        if (result.state === 'COMPLETE') break;
      }
    },
    /ISOLATED_WS_ROUTE_DROPPED/,
  );
  assert.deepEqual(first.requests.map(x => x.offset), [
    0, 65_536, 131_072, 196_608, 262_144,
  ]);
  assert.equal(await initialStore.get(scope, params.artifactPath), null);
  assert.ok(first.staleFrames >= 4);

  // Simulate separate Hub/store object after connection loss. Original
  // metadata and committed prefix remain in the disposable temp store.
  const resumedStore = new ArtifactBridgeStore(dir);
  const second = await wsSource(undefined);
  t.after(() => second.close());
  let resentBytes = 0;
  let complete = false;
  for (let n = 0; n < 20; n++) {
    const result = await ingestDeviceArtifact(resumedStore, second.ops, params);
    resentBytes += result.transferredBytes;
    if (result.state === 'COMPLETE') {
      assert.equal(result.sha256, digest);
      assert.equal(result.offset, bytes.length);
      complete = true;
      break;
    }
    assert.equal(result.state, 'PARTIAL');
  }
  assert.equal(complete, true);
  assert.equal(second.requests[0]?.offset, 262_144);
  assert.equal(resentBytes, bytes.length - 262_144);
  assert.equal((await resumedStore.get(scope, params.artifactPath))?.sha256, digest);
  const sample = await resumedStore.readChunk(scope, params.artifactPath, 220 * 1024 - 17, 256);
  assert.deepEqual(Buffer.from(sample.contentBase64, 'base64'), bytes.subarray(220 * 1024 - 17, 220 * 1024 + 239));
  const replay = await ingestDeviceArtifact(resumedStore, second.ops, params);
  assert.equal(replay.state, 'ALREADY_PRESENT');
  assert.equal(replay.transferredBytes, 0);
});

test('>220 KiB restarted transfer rejects changed source SHA without publishing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-conn-artifact-sha-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ArtifactBridgeStore(dir);
  const first = await wsSource(5);
  t.after(() => first.close());
  await assert.rejects(async () => {
    for (;;) await ingestDeviceArtifact(store, first.ops, params);
  }, /ISOLATED_WS_ROUTE_DROPPED/);
  const changed = await wsSource(undefined);
  t.after(() => changed.close());
  const otherOps = { ...changed.ops, sha256: async () => 'f'.repeat(64) };
  const reopened = new ArtifactBridgeStore(dir);
  let error: unknown;
  for (let round = 0; round < 10; round++) {
    try {
      const state = await ingestDeviceArtifact(reopened, otherOps, params);
      assert.equal(state.state, 'PARTIAL');
    } catch (e) {
      error = e;
      break;
    }
  }
  assert.ok(error instanceof Error, 'wrong source digest must not publish');
  assert.equal(await store.get(scope, params.artifactPath), null);
  await pause(10);
});
