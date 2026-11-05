import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

test('hotfix: legacy saturated 2,000-record journal opens without evicting tombstones', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-idempotency-headroom-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'idempotency-records.json');
  const seed = legacySnapshot(2000);
  await fs.writeFile(file, JSON.stringify(seed) + '\n', 'utf8');

  const store = new IdempotencyStore(root);
  await store.initialize();
  assert.equal((await store.get('legacy-0'))?.status, 'unknown');
  assert.equal((await store.get('legacy-41'))?.status, 'failed');
  assert.equal((await store.get('legacy-42'))?.status, 'succeeded');

  const input = {
    key: 'reply-guard-synthetic-new-intent',
    targetId: 'device-a',
    capability: 'files.write',
    fingerprint: 'b'.repeat(64),
  };
  const reservation = await store.begin(input);
  assert.equal(reservation.created, true);
  assert.equal(reservation.record.status, 'in_progress');
  await store.complete(input.key, 'succeeded');

  const repeated = await store.begin(input);
  assert.equal(repeated.created, false, 'same key may not redispatch');
  assert.equal(repeated.record.operationId, reservation.record.operationId);
  await assert.rejects(() => store.begin({
    ...input, fingerprint: 'c'.repeat(64),
  }), { code: 'IDEMPOTENCY_KEY_REUSED' });

  const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
    records: Array<{ key: string; status: string; operationId: string }>;
  };
  assert.equal(persisted.records.length, 2001);
  assert.equal(persisted.records.filter((r) => r.status === 'unknown').length, 4);
  assert.equal(persisted.records.find((r) => r.key === input.key)?.operationId,
    reservation.record.operationId);

  const restored = new IdempotencyStore(root);
  await restored.initialize();
  assert.equal((await restored.get('legacy-0'))?.status, 'unknown');
  assert.equal((await restored.get(input.key))?.status, 'succeeded');
  assert.equal((await restored.begin(input)).created, false);

  // Older Hub builds have a 2,000-entry ceiling; rollback must remain
  // unavailable/fail-closed, not silently discard the new reservation.
  const preHotfixCapacity = new IdempotencyStore(root, 2000);
  await assert.rejects(() => preHotfixCapacity.initialize(), {
    code: 'IDEMPOTENCY_STORE_FULL',
  });
});

test('hotfix: 5,000-entry schema bound preserves every tombstone and rejects 5,001st', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-idempotency-upper-bound-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'idempotency-records.json');
  await fs.writeFile(file, JSON.stringify(legacySnapshot(5000)) + '\n', 'utf8');
  const before = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const store = new IdempotencyStore(root);
  await store.initialize();
  await assert.rejects(() => store.begin({
    key: 'capacity-excess', fingerprint: 'f'.repeat(64),
    targetId: 'device-a', capability: 'files.write',
  }), { code: 'IDEMPOTENCY_STORE_FULL' });
  assert.equal(await store.get('capacity-excess'), undefined);
  assert.equal((await store.get('legacy-0'))?.status, 'unknown');
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), before,
    'full-capacity rejection must leave durable journal byte-identical');
});

test('hotfix: invalid capacity configurations fail before any journal mutation', () => {
  for (const limit of [0, -1, 5001, 1.5, NaN, Infinity]) {
    assert.throws(() => new IdempotencyStore('synthetic-only', limit), (error: unknown) =>
      error instanceof IdempotencyStoreError &&
      error.code === 'IDEMPOTENCY_CAPACITY_INVALID');
  }
});
