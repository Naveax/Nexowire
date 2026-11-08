import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';

test('concurrent SQLite reservations do not resurrect failed insert after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-idempotency-concurrency-'));
  try {
    const store = new IdempotencyStore(root);
    await store.initialize();
    const db = new DatabaseSync(path.join(root, 'idempotency-records.sqlite'));
    try {
      db.exec(`CREATE TRIGGER deny_failed BEFORE INSERT ON idempotency_records
        WHEN NEW.key='failed-reservation'
        BEGIN SELECT RAISE(ABORT, 'INJECTED_FIRST_JOURNAL_FAILURE'); END;`);
    } finally { db.close(); }
    const failed = {key:'failed-reservation',fingerprint:'a'.repeat(64),
      capability:'files.write',targetId:'device-1'};
    const survivor = {key:'durable-reservation',fingerprint:'b'.repeat(64),
      capability:'files.write',targetId:'device-2'};
    const [first, second] = await Promise.allSettled([
      store.begin(failed),store.begin(survivor),
    ]);
    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'fulfilled');
    assert.equal(await store.get(failed.key), undefined);
    assert.equal((await store.get(survivor.key))?.status, 'in_progress');
    const reopened = new IdempotencyStore(root);
    assert.equal(await reopened.get(failed.key), undefined);
    assert.equal((await reopened.get(survivor.key))?.status, 'unknown');
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
