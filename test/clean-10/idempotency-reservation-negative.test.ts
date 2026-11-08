import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {modelExitedHubWriter} from '../idempotency/fixtures/model-exited-hub-writer.js';
import {
  IdempotencyStore, IdempotencyStoreError, operationFingerprint,
} from '../../src/operations/idempotency-store.js';

test('CLEAN-10: concurrent duplicate key retains one UUID and restart UNKNOWN tombstone', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nw-clean10-idem-'));
  t.after(async () => rm(root, {recursive:true, force:true}));
  const store = new IdempotencyStore(root);
  const request = {
    key: 'clean10-duplicate-uuid',
    fingerprint: operationFingerprint({
      targetId:'clean10-device', capability:'files.write',
      payload:{path:'synthetic',content:'test-only'},
    }),
    capability:'files.write',
    targetId:'clean10-device',
  };

  // Only one of these 16 admissions may reserve a new operation UUID.
  const admissions = await Promise.all(
    Array.from({length:16}, () => store.begin(request)),
  );
  assert.equal(admissions.filter(item => item.created).length, 1);
  const operationId = admissions[0]!.record.operationId;
  assert.match(operationId, /^[a-f0-9-]{36}$/i);
  assert.ok(admissions.every(item => item.record.operationId === operationId));

  // A second object in the SAME process is not a restart. Model an exited
  // predecessor before claiming and fencing its uncertain reservation.
  modelExitedHubWriter(root);
  const restarted = new IdempotencyStore(root);
  await restarted.initialize();
  const unknown = await restarted.begin(request);
  assert.equal(unknown.created, false);
  assert.equal(unknown.record.status, 'unknown');
  assert.equal(unknown.record.operationId, operationId);

  // An attacker must not reuse an old key with a changed fingerprint.
  await assert.rejects(
    () => restarted.begin({...request, fingerprint:'f'.repeat(64)}),
    (error: unknown) => error instanceof IdempotencyStoreError &&
      error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal((await restarted.get(request.key))?.operationId, operationId);
  assert.equal((await restarted.get(request.key))?.status, 'unknown');
});
