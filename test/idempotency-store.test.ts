import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
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
    assert.equal((await store.get('write-1'))?.status, 'succeeded');
    assert.equal(await store.get('missing-key'), undefined);
    // Persisted timestamps are millisecond precision; ensure ordering is stable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.begin({
      key: 'foreign-newer',
      fingerprint: '2'.repeat(64),
      capability: 'files.write',
      targetId: 'foreign-device',
    });
    await store.complete('foreign-newer', 'succeeded');
    assert.equal((await store.list(1))[0]?.key, 'foreign-newer');
    assert.deepEqual(
      (await store.list(1, new Set(['device-1']))).map((record) => record.key),
      ['write-1'],
    );
    assert.deepEqual(
      (await store.list(1, new Set(['foreign-device']))).map((record) => record.key),
      ['foreign-newer'],
    );
    assert.deepEqual(await store.list(1, new Set(['absent-device'])), []);
    assert.deepEqual(replay.cachedResult, {
      ok: true,
      data: { secret: 'memory-only-result' },
    });

    const persisted = await fs.readFile(path.join(root, 'idempotency-records.sqlite'));
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
    const fingerprint = operationFingerprint({
      targetId: 'device-1',
      capability: 'files.patch',
      payload: { path: 'a.txt', operations: [{ old: 'a', next: 'b' }] },
    });
    // A restart is a *different process incarnation*, not a second store
    // object inside the still-running Hub. Reproduce a real abandoned claim.
    const crashed = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', `
        import { IdempotencyStore } from './src/operations/idempotency-store.js';
        const store = new IdempotencyStore(process.argv[1]);
        await store.begin({
          key: 'patch-1', fingerprint: process.argv[2],
          capability: 'files.patch', targetId: 'device-1',
        });
      `, root, fingerprint,
    ], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    assert.equal(crashed.status, 0, crashed.stderr);

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

test('concurrent initialization does not admit conflicting idempotency key before journal loads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-idempotency-load-race-'));
  try {
    const original = new IdempotencyStore(root);
    await original.begin({
      key: 'historical-key',
      fingerprint: 'a'.repeat(64),
      capability: 'files.write',
      targetId: 'device-1',
    });
    await original.complete('historical-key', 'succeeded');

    const resumed = new IdempotencyStore(root);
    // Leave initialization pending at the disk read and issue a competing
    // request before awaiting it. This previously treated the map as empty.
    const loading = resumed.initialize();
    await assert.rejects(
      () => resumed.begin({
        key: 'historical-key',
        fingerprint: 'b'.repeat(64),
        capability: 'files.write',
        targetId: 'device-1',
      }),
      (error: unknown) => error instanceof IdempotencyStoreError &&
        error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    await loading;
    assert.equal((await resumed.get('historical-key'))?.fingerprint, 'a'.repeat(64));
    const db = new DatabaseSync(path.join(root, 'idempotency-records.sqlite'));
    try {
      const stored = db.prepare(
        'SELECT fingerprint FROM idempotency_records WHERE key=?',
      ).get('historical-key') as { fingerprint: string } | undefined;
      assert.equal(stored?.fingerprint, 'a'.repeat(64));
    } finally { db.close(); }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed SQLite reservation does not create a key and a later valid reservation survives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-idempotency-sqlite-fail-'));
  try {
    const store = new IdempotencyStore(root);
    await store.initialize();
    const db = new DatabaseSync(path.join(root, 'idempotency-records.sqlite'));
    try {
      db.exec(`CREATE TRIGGER deny_one BEFORE INSERT ON idempotency_records
        WHEN NEW.key='recoverable-write'
        BEGIN SELECT RAISE(ABORT, 'INJECTED_SQLITE_RESERVATION_FAILURE'); END;`);
    } finally { db.close(); }
    const request = {key: 'recoverable-write',fingerprint:'c'.repeat(64),
      capability:'files.write',targetId:'device-1'};
    await assert.rejects(() => store.begin(request), /INJECTED_SQLITE_RESERVATION_FAILURE/);
    assert.equal(await store.get(request.key), undefined);
    const reopenedDb = new DatabaseSync(path.join(root, 'idempotency-records.sqlite'));
    try { reopenedDb.exec('DROP TRIGGER deny_one'); } finally { reopenedDb.close(); }
    const accepted = await store.begin(request);
    assert.equal(accepted.created,true);
    assert.equal((await store.get(request.key))?.status,'in_progress');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
