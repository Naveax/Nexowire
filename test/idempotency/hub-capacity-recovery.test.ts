import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {
  IdempotencyStore,
  IdempotencyStoreError,
} from '../../src/operations/idempotency-store.js';

type Status = 'succeeded' | 'failed' | 'unknown';

function legacySnapshot(count: number) {
  const timestamp = '2026-10-27T10:22:02.571Z';
  return {
    version: 1,
    records: Array.from({ length: count }, (_, i) => {
      const status: Status =
        i < 4 ? 'unknown' : i < 42 ? 'failed' : 'succeeded';
      return {
        key: 'legacy-' + String(i),
        fingerprint: 'a'.repeat(64),
        operationId: randomUUID(),
        targetId: i % 2 === 0 ? 'device-a' : 'device-b',
        capability: 'files.write',
        status,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }),
  };
}

function countRows(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare('SELECT COUNT(*) AS count FROM idempotency_records')
      .get() as { count: number }).count;
  } finally { db.close(); }
}

test('SQLite: saturated 2000-key JSON migrates without deleting UNKNOWN or replay keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-sqlite-migrate-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const legacyFile = path.join(root, 'idempotency-records.json');
  const sqliteFile = path.join(root, 'idempotency-records.sqlite');
  await fs.writeFile(legacyFile, JSON.stringify(legacySnapshot(2000)) + '\n');
  const before = createHash('sha256').update(await fs.readFile(legacyFile)).digest('hex');

  const store = new IdempotencyStore(root);
  await store.initialize();
  assert.equal((await store.get('legacy-0'))?.status, 'unknown');
  assert.equal((await store.get('legacy-41'))?.status, 'failed');
  assert.equal((await store.get('legacy-42'))?.status, 'succeeded');
  assert.equal(countRows(sqliteFile), 2000);

  const input = { key: 'reply-guard-new-intent-synthetic',
    targetId: 'device-a', capability: 'files.write',
    fingerprint: 'b'.repeat(64) };
  const reservation = await store.begin(input);
  assert.equal(reservation.created, true);
  await store.complete(input.key, 'succeeded');
  const repeat = await store.begin(input);
  assert.equal(repeat.created, false);
  assert.equal(repeat.record.operationId, reservation.record.operationId);
  await assert.rejects(() => store.begin({
    ...input, fingerprint: 'c'.repeat(64),
  }), { code: 'IDEMPOTENCY_KEY_REUSED' });

  assert.equal(countRows(sqliteFile), 2001);
  assert.equal(createHash('sha256').update(await fs.readFile(legacyFile)).digest('hex'),
    before, 'old anti-replay ledger must stay byte-identical as a backup');
  const restarted = new IdempotencyStore(root);
  assert.equal((await restarted.get('legacy-0'))?.status, 'unknown');
  assert.equal((await restarted.get(input.key))?.status, 'succeeded');
  assert.equal((await restarted.begin(input)).created, false);

  // Legacy compatibility is intentionally blocked once expanded reservations exist.
  const explicitLegacyLimit = new IdempotencyStore(root, 2000);
  await assert.rejects(() => explicitLegacyLimit.initialize(),
    { code: 'IDEMPOTENCY_STORE_FULL' });
});

test('SQLite: 5001 legacy JSON keys migrate beyond the former schema limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-sqlite-large-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const legacyFile = path.join(root, 'idempotency-records.json');
  const sqliteFile = path.join(root, 'idempotency-records.sqlite');
  await fs.writeFile(legacyFile, JSON.stringify(legacySnapshot(5001)) + '\n');
  const store = new IdempotencyStore(root);
  await store.initialize();
  for (let i = 0; i < 2; i++) {
    const key = 'post-limit-' + i;
    const input = { key, fingerprint: 'f'.repeat(64),
      targetId: 'device-a', capability: 'files.write' };
    const first = await store.begin(input);
    assert.equal(first.created, true);
    await store.complete(key, i === 0 ? 'succeeded' : 'unknown');
    const same = await store.begin(input);
    assert.equal(same.created, false);
    assert.equal(same.record.operationId, first.record.operationId);
  }
  assert.equal(countRows(sqliteFile), 5003);
  assert.equal((await new IdempotencyStore(root).get('post-limit-1'))?.status, 'unknown');
});

test('SQLite: changed legacy JSON after migration refuses an unsafe dual-writer fork', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-sqlite-drift-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'idempotency-records.json');
  const original = legacySnapshot(1);
  await fs.writeFile(file, JSON.stringify(original) + '\n');
  await new IdempotencyStore(root).initialize();
  original.records[0]!.status = 'failed';
  await fs.writeFile(file, JSON.stringify(original) + '\n');
  await assert.rejects(() => new IdempotencyStore(root).initialize(),
    { code: 'IDEMPOTENCY_LEGACY_JOURNAL_DRIFT' });
});

test('SQLite: invalid explicit test quotas reject without touching disk', () => {
  for (const max of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new IdempotencyStore('never-created', max),
      (error: unknown) => error instanceof IdempotencyStoreError &&
        error.code === 'IDEMPOTENCY_CAPACITY_INVALID');
  }
});


test('SQLite: terminal outcomes and UNKNOWN tombstones reject stale completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-sqlite-terminal-fence-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new IdempotencyStore(root);
  const successful = { key: 'final-success', fingerprint: 'a'.repeat(64),
    targetId: 'device-a', capability: 'files.write' };
  const first = await store.begin(successful);
  assert.equal(first.created, true);
  await store.complete(successful.key, 'succeeded');
  const reopened = new IdempotencyStore(root);
  await assert.rejects(() => reopened.complete(successful.key, 'failed'),
    { code: 'IDEMPOTENCY_TERMINAL_REWRITE_DENIED' });
  assert.equal((await reopened.get(successful.key))?.status, 'succeeded');
  assert.equal((await reopened.begin(successful)).record.operationId,
    first.record.operationId);

  const uncertain = { key: 'final-unknown', fingerprint: 'b'.repeat(64),
    targetId: 'device-b', capability: 'files.write' };
  const second = await store.begin(uncertain);
  await store.complete(uncertain.key, 'unknown');
  for (const invalidStatus of ['failed', 'succeeded'] as const) {
    await assert.rejects(() => reopened.complete(uncertain.key, invalidStatus),
      { code: 'IDEMPOTENCY_TERMINAL_REWRITE_DENIED' });
  }
  assert.equal((await new IdempotencyStore(root).get(uncertain.key))?.status,
    'unknown');
  assert.equal((await reopened.begin(uncertain)).record.operationId,
    second.record.operationId);
});


test('SQLite: active writer and foreign-host journal ownership fail closed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-sqlite-writer-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const store = new IdempotencyStore(root);
  const input = { key: 'writer-authority', fingerprint: 'd'.repeat(64),
    targetId: 'device-a', capability: 'files.write' };
  const reserved = await store.begin(input);
  const journal = path.join(root, 'idempotency-records.sqlite');
  function owner(next?: Record<string, unknown>): Record<string, unknown> {
    const db = new DatabaseSync(journal);
    try {
      if (next) db.prepare(
        "UPDATE idempotency_meta SET value=? WHERE key='hub_writer'",
      ).run(JSON.stringify(next));
      const row = db.prepare(
        "SELECT value FROM idempotency_meta WHERE key='hub_writer'",
      ).get() as {value:string};
      return JSON.parse(row.value) as Record<string, unknown>;
    } finally { db.close(); }
  }
  const original = owner();
  assert.equal(original.pid, process.pid);
  assert.equal(typeof original.host, 'string');
  assert.equal(typeof original.incarnation, 'string');
  owner({...original, incarnation:'other-live-process-incarnation'});
  await assert.rejects(() => new IdempotencyStore(root).initialize(),
    {code:'IDEMPOTENCY_HUB_WRITER_ACTIVE'});
  owner({...original, host:'foreign-shared-journal-host'});
  await assert.rejects(() => new IdempotencyStore(root).initialize(),
    {code:'IDEMPOTENCY_CROSS_HOST_JOURNAL_DENIED'});
  owner(original);
  const sameProcess = new IdempotencyStore(root);
  await sameProcess.initialize();
  assert.equal((await sameProcess.begin(input)).record.operationId,
    reserved.record.operationId, 'previous operation identity must be preserved');
});
