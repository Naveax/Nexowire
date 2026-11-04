import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';

const FP = 'a'.repeat(64);

test('full Hub preserves UNKNOWN and reports bounded unrestricted capacity', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexowire-hub-capacity-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const store = new IdempotencyStore(dir, 2);
  await store.begin({ key: 'first', fingerprint: FP, capability: 'files.write', targetId: 'device-a' });
  await store.complete('first', 'unknown');
  await store.begin({ key: 'second', fingerprint: FP, capability: 'files.write', targetId: 'device-b' });
  await store.complete('second', 'succeeded');

  assert.deepEqual(await store.capacitySnapshot(), {
    scope: 'all',
    visibleRecords: 2,
    byStatus: { in_progress: 0, succeeded: 1, failed: 0, unknown: 1 },
    capacity: { limit: 2, used: 2, remaining: 0, full: true },
  });

  await assert.rejects(
    store.begin({ key: 'third', fingerprint: FP, capability: 'files.write', targetId: 'device-a' }),
    { code: 'IDEMPOTENCY_STORE_FULL' },
  );
  const replay = await store.begin({
    key: 'first', fingerprint: FP, capability: 'files.write', targetId: 'device-a',
  });
  assert.equal(replay.created, false);
  assert.equal(replay.record.status, 'unknown');
  assert.equal(await store.get('third'), undefined);

  const restarted = new IdempotencyStore(dir, 2);
  assert.deepEqual(await restarted.capacitySnapshot(), await store.capacitySnapshot());
  assert.equal((await restarted.get('first'))?.status, 'unknown');
});

test('device-scoped capacity snapshot cannot reveal foreign device usage or saturation', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexowire-hub-capacity-scope-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const store = new IdempotencyStore(dir, 2);
  await store.begin({ key: 'a', fingerprint: FP, capability: 'files.write', targetId: 'device-a' });
  await store.begin({ key: 'b', fingerprint: FP, capability: 'files.write', targetId: 'device-b' });
  await store.complete('b', 'unknown');

  assert.deepEqual(await store.capacitySnapshot(new Set(['device-a'])), {
    scope: 'authorized_devices',
    visibleRecords: 1,
    byStatus: { in_progress: 1, succeeded: 0, failed: 0, unknown: 0 },
  });
  assert.deepEqual(await store.capacitySnapshot(new Set(['device-c'])), {
    scope: 'authorized_devices',
    visibleRecords: 0,
    byStatus: { in_progress: 0, succeeded: 0, failed: 0, unknown: 0 },
  });
  // No restricted snapshot may include global occupancy, remaining slots, or cap.
  const scoped = await store.capacitySnapshot(new Set(['device-a']));
  assert.equal('capacity' in scoped, false);
});

test('snapshot never changes a reserved in-progress operation into terminal success', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexowire-hub-capacity-race-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const store = new IdempotencyStore(dir, 1);
  await store.begin({ key: 'live', fingerprint: FP, capability: 'shell.exec', targetId: 'device-a' });
  const [snapshot, record] = await Promise.all([
    store.capacitySnapshot(),
    store.get('live'),
  ]);
  assert.equal(snapshot.byStatus.in_progress, 1);
  assert.equal(record?.status, 'in_progress');
  assert.equal(snapshot.capacity?.full, true);
});
