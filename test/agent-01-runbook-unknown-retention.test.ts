/**
 * #01 runbook mirror of task-graph journal TTL regression.
 * TEMP-only JSON; no graph callback or OS process is started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunbookStore, RunbookStoreError } from '../src/agent/runbook-store.js';

test('runbook UNKNOWN survives TTL list, unrelated save, restart and prune denial', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nx01-runbook-retain-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'runbooks.json');
  const store = new RunbookStore({ stateFile, retentionMs: 5 });
  await store.initialize();
  const seeded = await store.prepare({
    id: 'original-native-mutation',
    specHash: 'a'.repeat(64),
    steps: [{
      id: 'native-capable-step', kind: 'task_graph',
      dependsOn: [], taskGraphId: 'original-graph',
    }],
    resume: false, retryFailed: false, retryUnknown: false,
  });
  seeded.status = 'interrupted';
  seeded.steps[0]!.status = 'unknown';
  seeded.steps[0]!.attempts = 1;
  seeded.steps[0]!.errorCode = 'RECONCILE_REQUIRED';
  seeded.steps[0]!.startedAt = '2026-10-23T08:00:00.000Z';
  await store.save(seeded);
  const checkpoint = store.get(seeded.id);
  const diskBefore = await readFile(stateFile, 'utf8');

  await delay(40);
  for (let i = 0; i < 3; i++) {
    const listed = store.list();
    assert.ok(listed.some(entry => entry.id === seeded.id));
    assert.deepEqual(store.get(seeded.id), checkpoint);
    assert.equal(await readFile(stateFile, 'utf8'), diskBefore);
  }
  await assert.rejects(store.prune({ olderThanMs: 1 }), error =>
    error instanceof RunbookStoreError && error.code === 'RECONCILE_REQUIRED');

  await store.prepare({
    id: 'unrelated-assertions-metadata',
    specHash: 'b'.repeat(64),
    steps: [{ id: 'independent-assertion', kind: 'assertions', dependsOn: [] }],
    resume: false, retryFailed: false, retryUnknown: false,
  });
  const recovered = new RunbookStore({ stateFile, retentionMs: 5 });
  await recovered.initialize();
  assert.deepEqual(recovered.get(seeded.id), checkpoint);
  assert.equal(recovered.get(seeded.id).steps[0]?.errorCode, 'RECONCILE_REQUIRED');
  assert.equal(recovered.get(seeded.id).runCount, 1);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
    runbooks: Array<{ id: string }>;
  };
  assert.ok(persisted.runbooks.some(entry => entry.id === seeded.id));
});
