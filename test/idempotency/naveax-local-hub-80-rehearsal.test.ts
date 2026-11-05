import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdempotencyStore } from '../../src/operations/idempotency-store.js';

test('NAVEAX synthetic 80-key legacy profile migrates without loss or replay', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-naveax80-rehearsal-'));
  t.after(async () => fs.rm(stateDir, { recursive: true, force: true }));
  const legacyPath = path.join(stateDir, 'idempotency-records.json');
  const now = '2026-10-02T07:10:53.502Z';
  const records = Array.from({ length: 80 }, (_, index) => ({
    key: 'naveax-legacy-' + index,
    fingerprint: 'a'.repeat(64),
    operationId: randomUUID(),
    capability: 'files.write',
    targetId: 'naveax-device',
    status: index === 79 ? 'failed' as const : 'succeeded' as const,
    createdAt: now,
    updatedAt: now,
  }));
  await fs.writeFile(legacyPath, JSON.stringify({ version: 1, records }) + '\n');
  const digest = async () => createHash('sha256')
    .update(await fs.readFile(legacyPath)).digest('hex');
  const oldHash = await digest();

  const hub = new IdempotencyStore(stateDir);
  await hub.initialize();
  for (const expected of records) {
    assert.deepEqual(await hub.get(expected.key), expected);
    assert.deepEqual(await hub.getByOperationId(expected.operationId), expected);
  }
  const db = new DatabaseSync(path.join(stateDir, 'idempotency-records.sqlite'),
    { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA quick_check').get() as { quick_check: string })
      .quick_check, 'ok');
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode, 'wal');
    assert.deepEqual(db.prepare(
      'SELECT status, COUNT(*) AS n FROM idempotency_records GROUP BY status ORDER BY status',
    ).all(), [{ status: 'failed', n: 1 }, { status: 'succeeded', n: 79 }]);
  } finally { db.close(); }
  assert.equal(await digest(), oldHash, 'the legacy ledger must remain byte-identical');

  const newInput = {
    key: 'naveax-new-synthetic',
    fingerprint: 'b'.repeat(64),
    capability: 'files.write',
    targetId: 'naveax-device',
  };
  const reserved = await hub.begin(newInput);
  assert.equal(reserved.created, true);

  // A simulated restart must fence the abandoned reservation as UNKNOWN.
  const restarted = new IdempotencyStore(stateDir);
  const unknown = await restarted.get(newInput.key);
  assert.equal(unknown?.status, 'unknown');
  assert.equal(unknown?.operationId, reserved.record.operationId);
  const same = await restarted.begin(newInput);
  assert.equal(same.created, false);
  assert.equal(same.record.operationId, reserved.record.operationId);
  await assert.rejects(() => hub.complete(newInput.key, 'succeeded'),
    { code: 'IDEMPOTENCY_TERMINAL_REWRITE_DENIED' });
  await assert.rejects(() => restarted.begin({ ...newInput, fingerprint: 'c'.repeat(64) }),
    { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal((await restarted.get(records[79]!.key))?.status, 'failed');
  assert.equal(await digest(), oldHash);
});
