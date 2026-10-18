import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ArtifactBridgeStore, ArtifactBridgeError } from '../src/workspace/artifact-bridge.js';
import { ingestDeviceArtifact, type ArtifactSourceOps } from '../src/mcp/artifact-bridge-device-ingest.js';
const scope = { accountId: 'account:test', projectId: 'Nexowire', deviceId: 'device-A' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const input = {
  scope, sourcePath: 'C:\\allowed\\result.bin', artifactPath: 'results/run.bin',
  repository: 'Naveax/Nexowire', commitSha: '3927c61b6893a8d4397bfbc76ff6fcdf87393fc1',
  producerOperationId: 'operation-01', testStatus: 'unverified' as const,
  acceptanceStatus: 'pending' as const,
};
function source(bytes: Buffer, options: {
  mutateOnFinalHash?: boolean; invalidChunk?: boolean; disconnectAt?: number;
} = {}): ArtifactSourceOps & { counts: { reads: number; hashes: number } } {
  const counts = { reads: 0, hashes: 0 };
  return {
    counts,
    stat: async () => ({ type: 'file', size: bytes.length }),
    sha256: async () => {
      counts.hashes++;
      return options.mutateOnFinalHash && counts.hashes === 2
        ? 'f'.repeat(64) : sha(bytes);
    },
    read: async (_, offset, length) => {
      counts.reads++;
      if (options.disconnectAt && counts.reads === options.disconnectAt) throw Error('WSS disconnected');
      const chunk = bytes.subarray(offset, offset + length);
      return { sourceBytes: bytes.length, offsetBytes: offset, bytesRead: chunk.length,
        contentBase64: options.invalidChunk ? '!invalid!' : chunk.toString('base64') };
    },
  };
}
async function fixture(work: (store: ArtifactBridgeStore) => Promise<void>) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-ingest-'));
  try { await work(new ArtifactBridgeStore(folder)); }
  finally { await fs.rm(folder, { force: true, recursive: true }); }
}
test('direct 2MiB Agent-to-Hub ingest runs in bounded batches with no response payload', async () => fixture(async store => {
  const content = Buffer.alloc(2 * 1024 * 1024 + 93);
  for (let i = 0; i < content.length; i++) content[i] = i % 239;
  const remote = source(content);
  const observed: number[] = [];
  let result;
  do {
    result = await ingestDeviceArtifact(store, remote, { ...input, maxChunks: 4 });
    observed.push(result.offset);
    assert.doesNotMatch(JSON.stringify(result), /contentBase64|AAAB|encoded/i);
  } while (result.state === 'PARTIAL');
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.sha256, sha(content));
  assert.deepEqual(Buffer.from((await store.readChunk(scope, input.artifactPath, 65_530, 200)).contentBase64, 'base64'),
    content.subarray(65_530, 65_730));
  assert.ok(observed.every((x, i) => i === 0 || x > observed[i - 1]!));
  const duplicate = await ingestDeviceArtifact(store, remote, input);
  assert.equal(duplicate.state, 'ALREADY_PRESENT');
  assert.equal(duplicate.transferredBytes, 0);
}));
test('aborted Agent connection keeps exactly persisted prefix and resumes with same source SHA', async () =>
  fixture(async store => {
    const content = Buffer.alloc(140_000, 41);
    await assert.rejects(ingestDeviceArtifact(store, source(content, { disconnectAt: 2 }), input),
      /WSS disconnected/);
    const recovered = await ingestDeviceArtifact(store, source(content), input);
    assert.equal(recovered.state, 'COMPLETE');
    assert.equal(recovered.transferredBytes, content.length - 65536);
    assert.equal((await store.get(scope, input.artifactPath))?.sha256, sha(content));
  }));
test('source changed on final check is not committed to project', async () => fixture(async store => {
  const content = Buffer.alloc(70_000, 0x46);
  await assert.rejects(ingestDeviceArtifact(store, source(content, { mutateOnFinalHash: true }), input),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INGEST_SOURCE_CHANGED');
  assert.equal(await store.get(scope, input.artifactPath), null);
  const repaired = await ingestDeviceArtifact(store, source(content), input);
  assert.equal(repaired.state, 'COMPLETE');
}));
test('invalid chunks never publish and retry fails closed if stage is partially corrupt', async () => fixture(async store => {
  const content = Buffer.alloc(12_345, 22);
  await assert.rejects(ingestDeviceArtifact(store, source(content, { invalidChunk: true }), input),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INVALID_CHUNK');
  assert.equal(await store.get(scope, input.artifactPath), null);
  assert.equal((await ingestDeviceArtifact(store, source(content), input)).state, 'COMPLETE');
}));
test('ingest rejects oversized source without remote hash/read', async () => fixture(async store => {
  let reads = 0;
  const ops: ArtifactSourceOps = {
    stat: async () => ({ type: 'file', size: 268_435_457 }),
    sha256: async () => { reads++; return 'a'.repeat(64); },
    read: async () => { reads++; throw Error('not reached'); },
  };
  await assert.rejects(ingestDeviceArtifact(store, ops, input),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INGEST_SOURCE_INVALID');
  assert.equal(reads, 0);
}));
test('device source cannot return inconsistent size or offset to influence stage', async () => fixture(async store => {
  const bytes = Buffer.alloc(100, 3);
  const ops = source(bytes);
  ops.read = async () => ({ sourceBytes: bytes.length, offsetBytes: 10,
    bytesRead: 100, contentBase64: bytes.toString('base64') });
  await assert.rejects(ingestDeviceArtifact(store, ops, input),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INGEST_SOURCE_CHANGED');
  assert.equal(await store.get(scope, input.artifactPath), null);
}));
