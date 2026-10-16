import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';

test('a concurrently committed reservation cannot persist another failed reservation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-journal-concurrent-failure-'));
  const journalTemp = path.join(root, 'idempotency-records.json.tmp');
  const original = fs.writeFile;
  let firstAttempt = true;
  let reached!: () => void;
  let release!: () => void;
  const firstAttemptReached = new Promise<void>((resolve) => { reached = resolve; });
  const firstAttemptReleased = new Promise<void>((resolve) => { release = resolve; });
  try {
    const store = new IdempotencyStore(root);
    await store.initialize();
    // Inject a single, delayed failure at the journal persistence boundary.
    // All other filesystem operations remain real and use a private temp dir.
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]) === journalTemp && firstAttempt) {
        firstAttempt = false;
        reached();
        await firstAttemptReleased;
        throw new Error('INJECTED_FIRST_JOURNAL_WRITE_FAILURE');
      }
      return original(...args);
    }) as typeof fs.writeFile;

    const failed = {
      key: 'failed-reservation',
      fingerprint: 'a'.repeat(64),
      capability: 'files.write',
      targetId: 'device-1',
    };
    const survivor = {
      key: 'durable-reservation',
      fingerprint: 'b'.repeat(64),
      capability: 'files.write',
      targetId: 'device-2',
    };
    const first = assert.rejects(
      store.begin(failed), /INJECTED_FIRST_JOURNAL_WRITE_FAILURE/,
    );
    await firstAttemptReached;
    const second = store.begin(survivor);
    // Let the second caller attempt to enter the reservation path while
    // the first persistence write is still unresolved.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await first;
    assert.equal((await second).created, true);
    assert.equal(await store.get(failed.key), undefined);
    assert.equal((await store.get(survivor.key))?.status, 'in_progress');

    // Restart changes the durable in_progress state to unknown, but must not
    // resurrect the reservation whose first disk write actually failed.
    const reopened = new IdempotencyStore(root);
    await reopened.initialize();
    assert.equal(await reopened.get(failed.key), undefined);
    assert.equal((await reopened.get(survivor.key))?.status, 'unknown');
  } finally {
    release();
    fs.writeFile = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});
