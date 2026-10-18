import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ArtifactBridgeStore, ArtifactBridgeError, type ArtifactScope } from '../src/workspace/artifact-bridge.js';
import { ArtifactCheckpointAdapter } from '../src/workspace/artifact-checkpoint-adapter.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { artifactPrincipal } from '../src/mcp/artifact-bridge-tools.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha = '8bf7ce10972e78268e3cac945e833781b8d6846c';
const scope: ArtifactScope = { accountId: 'acct-1', projectId: 'Nexowire', deviceId: 'work-pc' };
const inputFor = (b: Buffer, overrides: Record<string, unknown> = {}) => ({
  scope, artifactPath: 'reports/final.bin', repository: 'Naveax/Nexowire',
  commitSha: sha, producerOperationId: 'job:verify-08', size: b.length,
  sha256: hash(b), testStatus: 'passed' as const, acceptanceStatus: 'pending' as const,
  ...overrides,
});
async function fixture(run: (store: ArtifactBridgeStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-artifact-bridge-'));
  try { await run(new ArtifactBridgeStore(root), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function upload(store: ArtifactBridgeStore, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const input = inputFor(bytes, overrides);
  const session = await store.begin(input);
  if (session.state !== 'OPEN') return { session, input };
  for (let i = session.offset; i < bytes.length; i += 65536) {
    const chunk = bytes.subarray(i, i + 65536);
    const receipt = await store.putChunk(input.scope, session.sessionId!, i, chunk.toString('base64'));
    assert.equal(receipt.offset, i + chunk.length);
  }
  return { session, input, manifest: await store.commit(input.scope, session.sessionId!) };
}
test('multi-chunk upload, dedupe and verified random-access retrieval', async () => fixture(async store => {
  const bytes = Buffer.from(Buffer.alloc(320_001).map((_, i) => i % 251));
  const { manifest } = await upload(store, bytes);
  assert.equal(manifest?.sha256, hash(bytes));
  const same = await store.begin(inputFor(bytes));
  assert.equal(same.state, 'ALREADY_PRESENT');
  const read = await store.readChunk(scope, 'reports/final.bin', 65530, 200);
  assert.equal(read.chunkSha256, hash(bytes.subarray(65530, 65730)));
  assert.deepEqual(Buffer.from(read.contentBase64, 'base64'), bytes.subarray(65530, 65730));
  assert.equal((await store.list(scope)).length, 1);
}));
test('restart-safe resume and repeated fixed-offset chunk receipt', async () => fixture(async (store, root) => {
  const bytes = Buffer.alloc(140000, 0x34), input = inputFor(bytes);
  const session = await store.begin(input);
  const first = bytes.subarray(0, 65536).toString('base64');
  await store.putChunk(scope, session.sessionId!, 0, first);
  const reboot = new ArtifactBridgeStore(root);
  assert.equal((await reboot.begin(input)).offset, 65536);
  assert.equal((await reboot.putChunk(scope, session.sessionId!, 0, first)).state, 'ALREADY_WRITTEN');
  await assert.rejects(reboot.putChunk(scope, session.sessionId!, 0, Buffer.alloc(65536, 1).toString('base64')),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CHUNK_REPLAY_CONFLICT');
  for (let offset = 65536; offset < bytes.length; offset += 65536) {
    await reboot.putChunk(scope, session.sessionId!, offset, bytes.subarray(offset, offset + 65536).toString('base64'));
  }
  assert.equal((await reboot.commit(scope, session.sessionId!)).sha256, hash(bytes));
}));
test('wrong account/device/project cannot read or append another session', async () => fixture(async store => {
  const bytes = Buffer.from('owned bytes'), session = await store.begin(inputFor(bytes));
  for (const bad of [
    { ...scope, accountId: 'acct-2' },
    { ...scope, projectId: 'Search-Tool' },
    { ...scope, deviceId: 'Naveax' },
  ]) {
    assert.equal(await store.get(bad, 'reports/final.bin'), null);
    await assert.rejects(store.putChunk(bad, session.sessionId!, 0, bytes.toString('base64')),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'SESSION_NOT_FOUND');
  }
}));
test('corrupt staged bytes fail closed rather than being resumed or published', async () => fixture(async (store, root) => {
  const bytes = Buffer.alloc(200, 0x4b), session = await store.begin(inputFor(bytes));
  await store.putChunk(scope, session.sessionId!, 0, bytes.toString('base64'));
  const part = path.join(root, 'artifact-bridge-v1');
  const matches: string[] = [];
  async function search(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await search(file);
      else if (file.endsWith('.part')) matches.push(file);
    }
  }
  await search(part);
  assert.equal(matches.length, 1);
  await fs.writeFile(matches[0]!, Buffer.alloc(200, 0x55));
  await assert.rejects(store.begin(inputFor(bytes)),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_SESSION');
  await assert.rejects(store.commit(scope, session.sessionId!),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_SESSION');
}));
test('CAS prevents silent overwrite; explicit compare succeeds and pins new hash', async () => fixture(async store => {
  const a = Buffer.from('first version'), b = Buffer.from('second version');
  await upload(store, a);
  await assert.rejects(store.begin(inputFor(b, { producerOperationId: 'job:second' })),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'COMPARE_AND_SWAP_FAILED');
  await upload(store, b, { producerOperationId: 'job:second', expectedPreviousSha256: hash(a) });
  assert.equal((await store.get(scope, 'reports/final.bin'))?.sha256, hash(b));
}));
test('missing and corrupt final content never yields a valid manifest', async () => fixture(async (store, root) => {
  const bytes = Buffer.from('verified final'), { manifest } = await upload(store, bytes);
  const matches: string[] = [];
  async function search(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await search(file);
      else if (entry.isFile() && entry.name === manifest!.sha256) matches.push(file);
    }
  }
  await search(path.join(root, 'artifact-bridge-v1'));
  assert.equal(matches.length, 1);
  await fs.writeFile(matches[0]!, Buffer.alloc(bytes.length, 7));
  await assert.rejects(store.get(scope, 'reports/final.bin'),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_ARTIFACT');
}));
test('checkpoint adoption binds workspace to repo, SHA and artifact identity across restarts', async () => fixture(async (store, root) => {
  const bytes = Buffer.from('acceptance report');
  await upload(store, bytes);
  const old = new WorkspaceStore(root);
  await old.save({ deviceId: scope.deviceId, workspaceId: 'NX-08', summary: 'Artifact bridge implementation',
    completed: ['write code'], remaining: ['CI review'], lastCommands: ['npm run typecheck'] });
  const adapter = new ArtifactCheckpointAdapter(old, store);
  await adapter.importLegacy({ scope, workspaceId: 'NX-08',
    repository: 'Naveax/Nexowire', commitSha: sha, artifactPaths: ['reports/final.bin'] });
  const other = new ArtifactCheckpointAdapter(new WorkspaceStore(root), new ArtifactBridgeStore(root));
  assert.equal((await other.get(scope, 'NX-08'))?.artifacts[0]?.sha256, hash(bytes));
  assert.equal((await other.list(scope)).length, 1);
  assert.equal((await other.list({ ...scope, accountId: 'outsider' })).length, 0);
  await assert.rejects(adapter.importLegacy({ scope, workspaceId: 'NX-08',
    repository: 'Naveax/Different', commitSha: sha, artifactPaths: ['reports/final.bin'] }),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'PROJECT_REPOSITORY_MISMATCH');
}));
test('checkpoint import of missing file fails closed', async () => fixture(async (store, root) => {
  const old = new WorkspaceStore(root);
  await old.save({ deviceId: scope.deviceId, workspaceId: 'NX-08', summary: 'unfinished', completed: [], remaining: [], lastCommands: [] });
  const adapter = new ArtifactCheckpointAdapter(old, store);
  await assert.rejects(adapter.importLegacy({ scope, workspaceId: 'NX-08',
    repository: 'Naveax/Nexowire', commitSha: sha, artifactPaths: ['reports/missing.bin'] }),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'ARTIFACT_MISSING');
  assert.equal(await adapter.get(scope, 'NX-08'), null);
}));
test('concurrent uploads to same file cannot bypass compare-and-swap', async () => fixture(async store => {
  const a = Buffer.from('writer-A'), b = Buffer.from('writer-B');
  const [one, two] = await Promise.allSettled([
    upload(store, a, { producerOperationId: 'job:A' }),
    upload(store, b, { producerOperationId: 'job:B' }),
  ]);
  // An intentional fail-closed BUSY or CAS mismatch is not lost data.
  assert.ok(one.status === 'fulfilled' || two.status === 'fulfilled');
  if (one.status === 'rejected') assert.ok(one.reason instanceof ArtifactBridgeError);
  if (two.status === 'rejected') assert.ok(two.reason instanceof ArtifactBridgeError);
  const actual = await store.get(scope, 'reports/final.bin');
  assert.ok(actual?.sha256 === hash(a) || actual?.sha256 === hash(b));
}));
test('large transfer is bounded and recoverable in chunked stages', async () => fixture(async store => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0x35);
  await upload(store, bytes);
  assert.equal((await store.get(scope, 'reports/final.bin'))?.size, bytes.length);
}));
test('identity gate rejects static tokens and devices not in signed owner grants', () => {
  assert.throws(() => artifactPrincipal(undefined, 'work-pc'), /Account-bound/);
  assert.throws(() => artifactPrincipal({ kind: 'static', scope: 'mcp' }, 'work-pc'), /Account-bound/);
  const auth = { kind: 'control-plane' as const, scope: 'mcp' as const,
    accountId: 'owner-42', role: 'admin' as const, allowedDeviceIds: ['work-pc'] };
  assert.equal(artifactPrincipal(auth, 'work-pc'), 'account:owner-42');
  assert.throws(() => artifactPrincipal(auth, 'Naveax'), /Device is outside/);
});


test('project binding blocks a different repository under the same project key', async () => fixture(async store => {
  await upload(store, Buffer.from('original bytes'));
  const other = Buffer.from('foreign repo bytes');
  await assert.rejects(store.begin(inputFor(other, {
    artifactPath: 'reports/foreign.bin', repository: 'Naveax/Search-Tool',
  })), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'PROJECT_REPOSITORY_MISMATCH');
  assert.equal(await store.get(scope, 'reports/foreign.bin'), null);
}));
test('same logical filename is isolated across projects', async () => fixture(async store => {
  const a = Buffer.from('Nexowire data'), b = Buffer.from('Search Tool data');
  await upload(store, a);
  const different = { ...scope, projectId: 'Search-Tool' };
  await upload(store, b, { scope: different, repository: 'Naveax/Search-Tool' });
  assert.equal((await store.get(scope, 'reports/final.bin'))?.sha256, hash(a));
  assert.equal((await store.get(different, 'reports/final.bin'))?.sha256, hash(b));
}));
test('published checkpoint rejects changed artifact after CAS replacement', async () => fixture(async (store, root) => {
  const old = Buffer.from('before'), updated = Buffer.from('after');
  await upload(store, old);
  const ws = new WorkspaceStore(root);
  await ws.save({ deviceId: scope.deviceId, workspaceId: 'NX-09', summary: 'before',
    completed: [], remaining: [], lastCommands: [] });
  const adapter = new ArtifactCheckpointAdapter(ws, store);
  await adapter.importLegacy({ scope, workspaceId: 'NX-09',
    repository: 'Naveax/Nexowire', commitSha: sha, artifactPaths: ['reports/final.bin'] });
  await upload(store, updated, { producerOperationId: 'job:updated',
    expectedPreviousSha256: hash(old) });
  await assert.rejects(adapter.get(scope, 'NX-09'),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CHECKPOINT_ARTIFACT_CHANGED');
}));
test('path traversal, invalid Base64 and incorrect offsets do not publish', async () => fixture(async store => {
  const b = Buffer.from('test');
  await assert.rejects(store.begin(inputFor(b, { artifactPath: '../outside.txt' })));
  await assert.rejects(store.begin(inputFor(b, { artifactPath: 'C:\\secret' })));
  const s = await store.begin(inputFor(b));
  await assert.rejects(store.putChunk(scope, s.sessionId!, 1, b.toString('base64')),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'OFFSET_MISMATCH');
  await assert.rejects(store.putChunk(scope, s.sessionId!, 0, '@@INVALID@@'),
    (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'INVALID_CHUNK');
  assert.equal(await store.get(scope, 'reports/final.bin'), null);
}));
