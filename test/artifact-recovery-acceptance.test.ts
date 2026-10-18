import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactBridgeStore, ArtifactBridgeError, type ArtifactScope } from '../src/workspace/artifact-bridge.js';

const scope: ArtifactScope = { accountId: 'lab-owner', projectId: 'Nexowire', deviceId: 'work-pc' };
const commitSha = '340494f49ad52277cddf09cbf71d7b6bb5d9b661';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function lab(work: (store: ArtifactBridgeStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'artifact-recovery-lab-'));
  try { await work(new ArtifactBridgeStore(root), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function input(b: Buffer, artifactPath = 'sample/proof.bin') {
  return { scope, artifactPath, repository: 'Naveax/Nexowire', commitSha,
    producerOperationId: 'synthetic:recovery', size: b.length, sha256: sha(b),
    testStatus: 'unverified' as const, acceptanceStatus: 'pending' as const };
}
async function locateScope(root: string) {
  let dir = path.join(root, 'artifact-bridge-v1');
  for (let depth = 0; depth < 3; depth++) {
    const names = await fs.readdir(dir);
    assert.equal(names.length, 1);
    dir = path.join(dir, names[0]!);
  }
  return dir;
}
async function prepare(store: ArtifactBridgeStore, bytes: Buffer, name = 'sample/proof.bin') {
  const begun = await store.begin(input(bytes, name));
  assert.equal(begun.state, 'OPEN');
  return begun.sessionId!;
}
async function writeAndCommit(store: ArtifactBridgeStore, bytes: Buffer, name = 'sample/proof.bin') {
  const id = await prepare(store, bytes, name);
  if (bytes.length) await store.putChunk(scope, id, 0, bytes.toString('base64'));
  return store.commit(scope, id);
}
test('isolated Hub restart: old lock blocks, explicit dead-PID recovery resumes exact bytes', () =>
  lab(async (store, root) => {
    const data = Buffer.alloc(100_000, 0x31);
    const sessionId = await prepare(store, data);
    await store.putChunk(scope, sessionId, 0, data.subarray(0, 65536).toString('base64'));
    const dir = await locateScope(root);
    const lock = path.join(dir, '.mutation.lock');
    const expectedId = randomUUID();
    // Child represents an isolated Hub writer that durably creates the lock
    // and exits abnormally, leaving no owner process to release it.
    const child = spawnSync(process.execPath, ['-e',
      "const fs=require('node:fs');const os=require('node:os');" +
      "fs.writeFileSync(process.argv[1],JSON.stringify({version:1,id:process.argv[2]," +
      "pid:process.pid,host:os.hostname(),createdAt:'2026-10-17T00:00:00.000Z'})," +
      "{flag:'wx'});process.exit(87);",
      lock, expectedId], { encoding: 'utf8' });
    assert.equal(child.status, 87, child.stderr);
    const old = new Date(Date.now() - 90_000);
    await fs.utimes(lock, old, old);
    const rebooted = new ArtifactBridgeStore(root);
    await assert.rejects(rebooted.begin(input(data)),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'BRIDGE_BUSY');
    await assert.rejects(rebooted.recoverAbandonedLock(scope, {
      expectedId: randomUUID(), confirmedHubOffline: true, minAgeMs: 60000,
    }), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'RECOVERY_LOCK_MISMATCH');
    const recovered = await rebooted.recoverAbandonedLock(scope, {
      expectedId, confirmedHubOffline: true, minAgeMs: 60000,
    });
    assert.equal(recovered.recovered, true);
    assert.equal((await fs.readFile(recovered.quarantinedLock, 'utf8')).includes(expectedId), true);
    const resumed = await rebooted.begin(input(data));
    assert.equal(resumed.sessionId, sessionId);
    assert.equal(resumed.offset, 65536);
    await rebooted.putChunk(scope, sessionId, 65536, data.subarray(65536).toString('base64'));
    assert.equal((await rebooted.commit(scope, sessionId)).sha256, sha(data));
  }));
test('active owner PID cannot be stolen even if lock timestamp is old', () =>
  lab(async (store, root) => {
    const b = Buffer.from('live owner');
    await prepare(store, b);
    const dir = await locateScope(root), lock = path.join(dir, '.mutation.lock');
    const id = randomUUID();
    await fs.writeFile(lock, JSON.stringify({ version: 1, id, pid: process.pid,
      host: hostname(), createdAt: '2026-10-17T00:00:00.000Z' }));
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    await assert.rejects(store.recoverAbandonedLock(scope, {
      expectedId: id, confirmedHubOffline: true, minAgeMs: 60000,
    }), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'RECOVERY_OWNER_ALIVE');
    assert.equal((await fs.readFile(lock, 'utf8')).includes(id), true);
  }));
test('retention is dry-run first and only deletes old incomplete sessions', () =>
  lab(async (store, root) => {
    const archive = Buffer.from('completed immutable content');
    await writeAndCommit(store, archive, 'verified/keep.bin');
    const oldBytes = Buffer.from('expired staged bytes');
    const sessionId = await prepare(store, oldBytes, 'sessions/expired.bin');
    await store.putChunk(scope, sessionId, 0, oldBytes.toString('base64'));
    const dir = await locateScope(root);
    const before = new Date(Date.now() - 2 * 3600_000);
    for (const ext of ['.json', '.part']) {
      await fs.utimes(path.join(dir, 'sessions', sessionId + ext), before, before);
    }
    const check = await store.pruneExpiredSessions(scope, { olderThanMs: 60000 });
    assert.deepEqual(check.candidateSessionIds, [sessionId]);
    assert.equal(check.deleted, 0);
    await assert.rejects(store.pruneExpiredSessions(scope, {
      olderThanMs: 60000, dryRun: false,
    }), (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'HUB_OFFLINE_REQUIRED');
    const actual = await store.pruneExpiredSessions(scope, {
      olderThanMs: 60000, dryRun: false, confirmedHubOffline: true,
    });
    assert.equal(actual.deleted, 1);
    assert.equal((await store.get(scope, 'verified/keep.bin'))?.sha256, sha(archive));
    assert.equal((await store.list(scope)).length, 1);
  }));
test('offline backup/restore of synthetic Hub directory preserves artifact manifest', () =>
  lab(async (store, root) => {
    const bytes = Buffer.from('durable artifact requiring recovery proof');
    await writeAndCommit(store, bytes);
    const backup = await fs.mkdtemp(path.join(tmpdir(), 'artifact-backup-target-'));
    try {
      await fs.cp(path.join(root, 'artifact-bridge-v1'),
        path.join(backup, 'artifact-bridge-v1'), { recursive: true, force: false, errorOnExist: true });
      const restored = new ArtifactBridgeStore(backup);
      assert.equal((await restored.get(scope, 'sample/proof.bin'))?.sha256, sha(bytes));
      const actual = await restored.readChunk(scope, 'sample/proof.bin', 0);
      assert.deepEqual(Buffer.from(actual.contentBase64, 'base64'), bytes);
      const dir = await locateScope(backup);
      const object = path.join(dir, 'objects', sha(bytes));
      const corrupted = Buffer.alloc(bytes.length, 99);
      await fs.writeFile(object, corrupted);
      await assert.rejects(restored.get(scope, 'sample/proof.bin'),
        (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'CORRUPT_ARTIFACT');
      assert.equal((await store.get(scope, 'sample/proof.bin'))?.sha256, sha(bytes));
    } finally { await fs.rm(backup, { recursive: true, force: true }); }
  }));
test('simulated ENOSPC prevents publishing and preserves a retryable session', () =>
  lab(async (store) => {
    const bytes = Buffer.from('simulate disk quota failure');
    const id = await prepare(store, bytes);
    await store.putChunk(scope, id, 0, bytes.toString('base64'));
    const original = fs.open.bind(fs);
    Object.defineProperty(fs, 'open', {
      configurable: true, writable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = String(args[0]);
        if (file.includes(path.sep + 'manifests' + path.sep) && file.includes('.tmp')) {
          const err = Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
          throw err;
        }
        return original(...args);
      },
    });
    try {
      await assert.rejects(store.commit(scope, id),
        (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOSPC');
    } finally {
      Object.defineProperty(fs, 'open', {
        configurable: true, writable: true, value: original,
      });
    }
    assert.equal(await store.get(scope, 'sample/proof.bin'), null);
    const reloaded = await store.begin(input(bytes));
    assert.equal(reloaded.offset, bytes.length);
    assert.equal((await store.commit(scope, id)).sha256, sha(bytes));
  }));
test('two simultaneous same-name uploads are isolated by device and project scope', () =>
  lab(async (store) => {
    const one = Buffer.from('work-pc deterministic source');
    const two = Buffer.from('Naveax deterministic source');
    const workScope = { ...scope, deviceId: 'work-pc' };
    const navScope = { ...scope, deviceId: 'Naveax' };
    const put = async (s: ArtifactScope, b: Buffer, id: string) => {
      const descriptor = { ...input(b, 'same/filename.bin'), scope: s,
        producerOperationId: 'simultaneous:' + id };
      const session = await store.begin(descriptor);
      if (session.state !== 'OPEN' || !session.sessionId) throw Error('missing transfer session');
      await store.putChunk(s, session.sessionId, 0, b.toString('base64'));
      return store.commit(s, session.sessionId);
    };
    const [a, b] = await Promise.all([put(workScope, one, 'work'), put(navScope, two, 'naveax')]);
    assert.equal(a.sha256, sha(one));
    assert.equal(b.sha256, sha(two));
    assert.equal((await store.get(workScope, 'same/filename.bin'))?.sha256, sha(one));
    assert.equal((await store.get(navScope, 'same/filename.bin'))?.sha256, sha(two));
    assert.equal(await store.get({ ...scope, projectId: 'foreign-project' }, 'same/filename.bin'), null);
  }));
test('two competing writers of one scope/path cannot silently publish both digests', () =>
  lab(async (store) => {
    const a = Buffer.from('competing writer alpha');
    const b = Buffer.from('competing writer beta');
    const put = async (bytes: Buffer, tag: string) => {
      const s = await store.begin({ ...input(bytes, 'race/same.bin'),
        producerOperationId: 'race:' + tag });
      if (s.state !== 'OPEN' || !s.sessionId) throw Error('session not open');
      await store.putChunk(scope, s.sessionId, 0, bytes.toString('base64'));
      return store.commit(scope, s.sessionId);
    };
    const concurrent = await Promise.allSettled([put(a, 'A'), put(b, 'B')]);
    const successful = concurrent.filter(x => x.status === 'fulfilled');
    assert.equal(successful.length, 1, 'competing CAS must publish at most one digest');
    const manifest = await store.get(scope, 'race/same.bin');
    assert.ok(manifest?.sha256 === sha(a) || manifest?.sha256 === sha(b));
    for (const item of concurrent) {
      if (item.status === 'rejected') {
        assert.ok(item.reason instanceof ArtifactBridgeError);
        assert.ok(['BRIDGE_BUSY', 'COMPARE_AND_SWAP_FAILED'].includes(item.reason.code));
      }
    }
  }));
test('retention rejects orphan partial stage instead of silently removing it', () =>
  lab(async (store, root) => {
    const bytes = Buffer.from('unfinished bytes');
    const id = await prepare(store, bytes);
    const dir = await locateScope(root);
    await fs.rm(path.join(dir, 'sessions', id + '.json'));
    await assert.rejects(store.pruneExpiredSessions(scope, { olderThanMs: 60000 }),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'RETENTION_ORPHAN_STAGE');
    assert.equal(await fs.stat(path.join(dir, 'sessions', id + '.part')).then(x => x.isFile()), true);
  }));
