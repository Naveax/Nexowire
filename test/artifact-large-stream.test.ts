import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ArtifactBridgeStore, ArtifactBridgeError } from '../src/workspace/artifact-bridge.js';
import { ingestDeviceArtifact, type ArtifactSourceOps } from '../src/mcp/artifact-bridge-device-ingest.js';

const scope = { accountId: 'large-synthetic-owner', projectId: 'Nexowire', deviceId: 'work-pc' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sourceId = 'large-file-588';
async function lab(run: (store: ArtifactBridgeStore, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-588-'));
  try { await run(new ArtifactBridgeStore(dir), dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function manifest(size: number, checksum: string, name = 'large/fixture.bin') {
  return { scope, artifactPath: name, repository: 'Naveax/Nexowire',
    commitSha: '4d8bb072a01981be525fd7d0f800c0e2a62332f7',
    producerOperationId: sourceId, size, sha256: checksum,
    testStatus: 'unverified' as const, acceptanceStatus: 'pending' as const };
}
async function stageWhole(store: ArtifactBridgeStore, bytes: Buffer, name = 'large/file.bin') {
  const x = await store.begin(manifest(bytes.length, sha(bytes), name));
  assert.equal(x.state, 'OPEN');
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    const result = await store.putChunk(scope, x.sessionId!, offset, chunk.toString('base64'));
    assert.equal(result.offset, offset + chunk.length);
  }
  return store.commit(scope, x.sessionId!);
}
test('221 KiB and 1 MiB artifacts use bounded chunks with verified full hash', async () =>
  lab(async store => {
    for (const n of [221 * 1024, 1024 * 1024]) {
      const bytes = Buffer.alloc(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 41 + 29) & 255;
      const artifact = await stageWhole(store, bytes, 'fixture/' + n + '.bin');
      assert.equal(artifact.sha256, sha(bytes));
      assert.equal((await store.get(scope, artifact.artifactPath))?.size, n);
    }
  }));
test('large >256MiB resumable ledger is compact, checks offset and rejects foreign scopes', async () =>
  lab(async (store, dir) => {
    const size = 268_435_457, meta = manifest(size, 'a'.repeat(64));
    const begin = await store.begin(meta);
    assert.equal(begin.state, 'OPEN');
    assert.equal(begin.offset, 0);
    const chunk = Buffer.alloc(65536, 42);
    const good = await store.putChunk(scope, begin.sessionId!, 0, chunk.toString('base64'));
    assert.equal(good.offset, 65536);
    await assert.rejects(store.putChunk(scope, begin.sessionId!, 65537, chunk.toString('base64')),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'OFFSET_MISMATCH');
    assert.equal((await store.putChunk(scope, begin.sessionId!, 0, chunk.toString('base64'))).state,
      'ALREADY_WRITTEN');
    await assert.rejects(store.putChunk({ ...scope, deviceId: 'wrong-device' },
      begin.sessionId!, 65536, chunk.toString('base64')),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'SESSION_NOT_FOUND');
    const reboot = new ArtifactBridgeStore(dir);
    const resumed = await reboot.begin(meta);
    assert.equal(resumed.offset, 65536);
    // Compact metadata contains no growing legacy chunks array.
    async function find(dir: string, name: string): Promise<string[]> {
      const values: string[] = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) values.push(...await find(p, name));
        else if (e.name === name) values.push(p);
      }
      return values;
    }
    const headers = await find(dir, begin.sessionId! + '.json');
    const ledgers = await find(dir, begin.sessionId! + '.receipts');
    assert.equal(headers.length, 1);
    assert.equal(ledgers.length, 1);
    assert.ok((await fs.stat(headers[0]!)).size < 2000);
    assert.equal((await fs.stat(ledgers[0]!)).size, 44);
    assert.deepEqual(await reboot.cancel(scope, begin.sessionId!), { cancelled: true });
    assert.equal((await fs.stat(ledgers[0]!).catch(() => null)), null);
  }));
test('large device ingest rejects missing precomputed digest before any Agent reads', async () =>
  lab(async store => {
    let reads = 0;
    const source: ArtifactSourceOps = {
      stat: async () => ({ type: 'file', size: 268_435_457, modifiedAt: 'fixed' }),
      sha256: async () => { reads++; return 'a'.repeat(64); },
      read: async () => { reads++; throw Error('should not read'); },
    };
    await assert.rejects(ingestDeviceArtifact(store, source, {
      scope, sourcePath: 'synthetic-large.bin', artifactPath: 'large/source.bin',
      repository: 'Naveax/Nexowire', commitSha: '4d8bb072a01981be525fd7d0f800c0e2a62332f7',
      producerOperationId: 'large-source', testStatus: 'unverified', acceptanceStatus: 'pending',
    }), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'LARGE_SOURCE_SHA_REQUIRED');
    assert.equal(reads, 0);
  }));
test('source metadata change between read and receipt blocks publication', async () =>
  lab(async store => {
    const bytes = Buffer.alloc(221 * 1024, 17);
    let version = 0;
    const source: ArtifactSourceOps = {
      stat: async () => ({ type: 'file', size: bytes.length, modifiedAt: 'v' + version }),
      sha256: async () => sha(bytes),
      read: async (_, offset, max) => {
        version++;
        const c = bytes.subarray(offset, offset + max);
        return { sourceBytes: bytes.length, offsetBytes: offset,
          bytesRead: c.length, contentBase64: c.toString('base64') };
      },
    };
    await assert.rejects(ingestDeviceArtifact(store, source, {
      scope, sourcePath: 'synthetic-mutating.bin', artifactPath: 'large/mutating.bin',
      repository: 'Naveax/Nexowire', commitSha: '4d8bb072a01981be525fd7d0f800c0e2a62332f7',
      producerOperationId: 'source-changed', testStatus: 'unverified', acceptanceStatus: 'pending',
    }), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INGEST_SOURCE_CHANGED');
    assert.equal(await store.get(scope, 'large/mutating.bin'), null);
  }));


test('large batch resumes after restart; retention cleans only verified incomplete scope', async () =>
  lab(async (store, dir) => {
    const meta = manifest(268_435_457, 'b'.repeat(64), 'large/resumable.bin');
    const opened = await store.begin(meta);
    assert.equal(opened.state, 'OPEN');
    const result = await store.appendSourceChunks(scope, opened.sessionId!, 3,
      async (at, n) => Buffer.alloc(n, (at / 65536) & 255).toString('base64'));
    assert.equal(result.offset, 3 * 65536);
    assert.equal(result.chunks, 3);
    const reload = new ArtifactBridgeStore(dir);
    assert.equal((await reload.begin(meta)).offset, 3 * 65536);
    async function walk(folder: string): Promise<string[]> {
      const found: string[] = [];
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        const next = path.join(folder, item.name);
        if (item.isDirectory()) found.push(...await walk(next));
        else if (item.name.startsWith(opened.sessionId!)) found.push(next);
      }
      return found;
    }
    const paths = await walk(dir);
    assert.equal(paths.length, 3);
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const file of paths) await fs.utimes(file, old, old);
    const dry = await reload.pruneExpiredSessions(scope, { olderThanMs: 60000 });
    assert.deepEqual(dry.candidateSessionIds, [opened.sessionId!]);
    assert.equal(dry.deleted, 0);
    const removed = await reload.pruneExpiredSessions(scope, {
      olderThanMs: 60000, dryRun: false, confirmedHubOffline: true,
    });
    assert.equal(removed.deleted, 1);
    for (const file of paths) assert.equal(await fs.stat(file).catch(() => null), null);
  }));
test('indexed reads detect both forged receipt index and same-size object corruption', async () =>
  lab(async (store, dir) => {
    const bytes = Buffer.alloc(525);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 17) & 255;
    const name = 'örnek/çalışma-🙂.bin';
    const published = await stageWhole(store, bytes, name);
    let indexPath = '', objectPath = '', manifestPath = '';
    async function visit(folder: string): Promise<void> {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const f = path.join(folder, entry.name);
        if (entry.isDirectory()) await visit(f);
        else {
          if (entry.name === published.sha256) objectPath = f;
          if (entry.name.endsWith('.json')) {
            const contents = await fs.readFile(f, 'utf8');
            if (contents.includes(name)) manifestPath = f;
          }
        }
      }
    }
    await visit(dir);
    assert.ok(objectPath && manifestPath);
    indexPath = objectPath + '.receipts';
    const receipt = Buffer.alloc(44);
    receipt.writeBigUInt64LE(0n, 0);
    receipt.writeUInt32LE(bytes.length, 8);
    Buffer.from(sha(bytes), 'hex').copy(receipt, 12);
    await fs.writeFile(indexPath, receipt, { flag: 'wx' });
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    raw.receiptSha256 = sha(receipt);
    await fs.writeFile(manifestPath, JSON.stringify(raw), 'utf8');
    assert.deepEqual(Buffer.from((await store.readChunk(scope, name, 500, 25)).contentBase64, 'base64'),
      bytes.subarray(500, 525));
    const tamperedIndex = Buffer.from(receipt);
    tamperedIndex[13] = tamperedIndex[13]! ^ 0xff;
    await fs.writeFile(indexPath, tamperedIndex);
    await assert.rejects(store.readChunk(scope, name, 0, 200),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_RECEIPT');
    await fs.writeFile(indexPath, receipt);
    await fs.writeFile(objectPath, Buffer.alloc(bytes.length, 99));
    await assert.rejects(store.readChunk(scope, name, 0, 200),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_ARTIFACT');
  }));
test('configured operator quota prevents creating oversized small or large artifact sessions', async () =>
  lab(async store => {
    const before = process.env.NEXOWIRE_ARTIFACT_MAX_BYTES;
    process.env.NEXOWIRE_ARTIFACT_MAX_BYTES = '262144';
    try {
      const okay = await store.begin(manifest(221 * 1024, 'd'.repeat(64), 'quota/okay.bin'));
      assert.equal(okay.state, 'OPEN');
      await assert.rejects(store.begin(manifest(1024 * 1024, 'e'.repeat(64), 'quota/too-big.bin')),
        (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'ARTIFACT_QUOTA_EXCEEDED');
      await assert.rejects(store.begin(manifest(268_435_457, 'f'.repeat(64), 'quota/huge.bin')),
        (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'ARTIFACT_QUOTA_EXCEEDED');
      await store.cancel(scope, okay.sessionId!);
    } finally {
      if (before === undefined) delete process.env.NEXOWIRE_ARTIFACT_MAX_BYTES;
      else process.env.NEXOWIRE_ARTIFACT_MAX_BYTES = before;
    }
  }));


test('large source with explicit digest streams bounded chunks without calling limited Agent file_hash', async () =>
  lab(async (store, dir) => {
    const size = 268_435_457, bytes = Buffer.alloc(65536, 23);
    let calls = 0, hashCalls = 0;
    const source: ArtifactSourceOps = {
      stat: async () => ({ type: 'file', size, modifiedAt: '2026-10-20T00:00:00.000Z' }),
      sha256: async () => { hashCalls++; throw Error('Legacy 256MiB hash must not be called'); },
      read: async (_p, offset, len) => {
        calls++;
        return { sourceBytes: size, offsetBytes: offset, bytesRead: len,
          contentBase64: bytes.subarray(0, len).toString('base64') };
      },
    };
    const details = {
      scope, sourcePath: 'C:\\synthetic\\large.bin', artifactPath: 'large/hub-pull.bin',
      repository: 'Naveax/Nexowire',
      commitSha: '4d8bb072a01981be525fd7d0f800c0e2a62332f7',
      producerOperationId: 'large-pull', testStatus: 'unverified' as const,
      acceptanceStatus: 'pending' as const,
      expectedSourceSha256: '0'.repeat(64), maxChunks: 32,
    };
    const partial = await ingestDeviceArtifact(store, source, details);
    assert.equal(partial.state, 'PARTIAL');
    assert.equal(partial.transferredBytes, 32 * 65536);
    assert.equal(partial.offset, partial.transferredBytes);
    assert.equal(calls, 32);
    assert.equal(hashCalls, 0);
    const reboot = new ArtifactBridgeStore(dir);
    const second = await ingestDeviceArtifact(reboot, source, details);
    assert.equal(second.state, 'PARTIAL');
    assert.equal(second.offset, 64 * 65536);
    assert.equal(second.transferredBytes, 32 * 65536);
    const session = await reboot.begin({
      ...manifest(size, '0'.repeat(64), details.artifactPath),
      producerOperationId: details.producerOperationId,
    });
    assert.equal(session.state, 'OPEN');
    assert.equal(session.offset, 64 * 65536);
    await assert.rejects(reboot.commit(scope, session.sessionId!),
      (e: unknown) => e instanceof ArtifactBridgeError);
  }));
