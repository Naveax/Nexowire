import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  IdempotencyStore,
  IdempotencyStoreError,
  operationFingerprint,
} from '../src/operations/idempotency-store.js';

test('idempotency fingerprint is stable across object key order', () => {
  const a = operationFingerprint({
    targetId: 'device-1',
    capability: 'files.write',
    payload: {
      path: 'x',
      nested: { b: 2, a: 1 },
    },
  });
  const b = operationFingerprint({
    targetId: 'device-1',
    capability: 'files.write',
    payload: {
      nested: { a: 1, b: 2 },
      path: 'x',
    },
  });
  assert.equal(a, b);
});

test('idempotency store persists metadata without payloads and blocks key reuse', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-idempotency-'),
  );

  try {
    const store = new IdempotencyStore(root);
    await store.initialize();

    const fingerprint = operationFingerprint({
      targetId: 'device-1',
      capability: 'files.write',
      payload: { path: 'secret.txt', content: 'super-secret-payload' },
    });
    const started = await store.begin({
      key: 'write-1',
      fingerprint,
      capability: 'files.write',
      targetId: 'device-1',
    });
    assert.equal(started.created, true);
    assert.equal(started.record.status, 'in_progress');

    await store.complete('write-1', 'succeeded', {
      ok: true,
      data: { secret: 'memory-only-result' },
    });

    const replay = await store.begin({
      key: 'write-1',
      fingerprint,
      capability: 'files.write',
      targetId: 'device-1',
    });
    assert.equal(replay.created, false);
    assert.equal(replay.record.status, 'succeeded');
    assert.deepEqual(replay.cachedResult, {
      ok: true,
      data: { secret: 'memory-only-result' },
    });

    const persisted = await fs.readFile(
      path.join(root, 'idempotency-records.json'),
      'utf8',
    );
    assert.equal(persisted.includes('super-secret-payload'), false);
    assert.equal(persisted.includes('memory-only-result'), false);

    await assert.rejects(
      () =>
        store.begin({
          key: 'write-1',
          fingerprint: 'f'.repeat(64),
          capability: 'files.write',
          targetId: 'device-1',
        }),
      (error: unknown) =>
        error instanceof IdempotencyStoreError &&
        error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('in-progress records become unknown after hub restart', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-idempotency-restart-'),
  );

  try {
    const first = new IdempotencyStore(root);
    const fingerprint = operationFingerprint({
      targetId: 'device-1',
      capability: 'files.patch',
      payload: { path: 'a.txt', operations: [{ old: 'a', next: 'b' }] },
    });
    await first.begin({
      key: 'patch-1',
      fingerprint,
      capability: 'files.patch',
      targetId: 'device-1',
    });

    const second = new IdempotencyStore(root);
    await second.initialize();
    const records = await second.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, 'unknown');

    const replay = await second.begin({
      key: 'patch-1',
      fingerprint,
      capability: 'files.patch',
      targetId: 'device-1',
    });
    assert.equal(replay.created, false);
    assert.equal(replay.record.status, 'unknown');
    assert.equal(replay.cachedResult, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
