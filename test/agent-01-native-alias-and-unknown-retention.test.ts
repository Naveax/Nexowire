/**
 * #01 TEMP-only trust regression. The original #847 RED file remains
 * BYTE-IDENTICAL on its own branch. This test adapts only its outcome:
 * current source denies with RECONCILE_REQUIRED before marker execution.
 * It also guards against local TTL destroying unreconciled UNKNOWN evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeDurableRunbook, RunbookAdmissionRequiredError } from '../src/agent/runbooks.js';
import { executeCapability } from '../src/agent/executors.js';
import { RunbookStore } from '../src/agent/runbook-store.js';
import { TaskGraphStore, TaskGraphStoreError } from '../src/agent/task-graph-store.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('#847-equivalent: original UNKNOWN denies two direct graph aliases without external CAS', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nx01-847-equivalent-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const runbooks = new RunbookStore({ stateFile: path.join(root, 'runbooks.json') });
  const graphs = new TaskGraphStore({ stateFile: path.join(root, 'graphs.json') });
  await runbooks.initialize();
  await graphs.initialize();
  // #847's same untrusted, immutable illustrative fixture, never a permit.
  const original = Object.freeze({
    logicalMutationId: 'logical-original-1',
    requestId: 'fd953236-6a11-4c72-a472-478a864f7e40',
    sourceSha: 'b'.repeat(40),
    worktreeId: 'original-worktree-1',
    ownerEpoch: 7, grantGeneration: 2,
    ownerId: 'owner-test', deviceId: 'device-test',
  });
  const steps = [{
    id: 'logical-original-step', kind: 'task_graph' as const,
    task_graph: { jobs: [{ id: 'inert-job', command: 'not-executed' }] },
  }];
  let nestedDispatches = 0;
  const first = await executeDurableRunbook(
    { runbook_id: 'original-runbook', steps }, runbooks, {
      runTaskGraph: async () => {
        nestedDispatches++;
        throw Object.assign(new Error('synthetic unknown'), {
          code: 'MUTATION_STATE_UNKNOWN',
        });
      },
      runAssertions: async () => ({ data: { ok: true } }),
    },
  ) as { data: { steps: Array<{ status: string; errorCode?: string }> } };
  assert.equal(first.data.steps[0]?.status, 'unknown');
  assert.equal(first.data.steps[0]?.errorCode, 'RECONCILE_REQUIRED');
  assert.equal(nestedDispatches, 0);
  assert.equal(original.ownerEpoch, 7);
  assert.equal(original.grantGeneration, 2);

  const policy = new PathPolicy([root]);
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  let nativeCapableDispatches = 0;
  for (const graph_id of ['clone-session-epoch8-a', 'clone-session-epoch9-b']) {
    // #847 expected a returned result, so it turns RED on rejection. Here
    // rejection is the supported safe outcome, without weakening its intent.
    const attempted = executeCapability('task.graph.run', {
      graph_id, max_parallel: 1, total_timeout_ms: 20_000,
      jobs: [{
        id: 'inert-job', shell, cwd: root,
        command: "node -e \"console.log('INERT_GRAPH_EXECUTOR_MARKER')\"",
      }],
    }, policy, { taskGraphs: graphs }).then(() => {
      nativeCapableDispatches++;
    });
    await assert.rejects(attempted, error =>
      error instanceof RunbookAdmissionRequiredError &&
      error.code === 'RECONCILE_REQUIRED');
    assert.equal(graphs.list().length, 0);
  }
  assert.equal(runbooks.get('original-runbook').steps[0]?.status, 'unknown');
  assert.equal(runbooks.get('original-runbook').steps[0]?.errorCode, 'RECONCILE_REQUIRED');
  assert.equal(nativeCapableDispatches, 0);
});

test('expired TTL reads, unrelated metadata write, restart and prune cannot erase UNKNOWN', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nx01-retention-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'graphs.json');
  const store = new TaskGraphStore({ stateFile, retentionMs: 5 });
  await store.initialize();
  const original = await store.prepare({
    id: 'original-unreconciled-effect', specHash: 'a'.repeat(64),
    jobs: [{ id: 'possible-native-effect', dependsOn: [] }],
    resume: false, retryFailed: false, retryUnknown: false,
  });
  original.status = 'interrupted';
  original.jobs[0]!.status = 'unknown';
  original.jobs[0]!.attempts = 1;
  original.jobs[0]!.startedAt = '2026-10-23T08:00:00.000Z';
  await store.save(original);
  const checkpoint = store.get(original.id);
  const bytesBefore = await readFile(stateFile, 'utf8');

  await delay(40);
  const policy = new PathPolicy([root]);
  for (let i = 0; i < 3; i++) {
    const listed = await executeCapability('task.graph.list', {},
      policy, { taskGraphs: store }) as { data: Array<{id: string}> };
    assert.ok(listed.data.some(item => item.id === original.id));
    const artifacts = await executeCapability('task.artifact.list',
      { graph_id: original.id }, policy, { taskGraphs: store }) as {
        data: { artifacts: unknown[] }
      };
    assert.deepEqual(artifacts.data.artifacts, []);
    assert.deepEqual(store.get(original.id), checkpoint);
    assert.equal(await readFile(stateFile, 'utf8'), bytesBefore);
  }
  await assert.rejects(store.prune({ olderThanMs: 1 }), error =>
    error instanceof TaskGraphStoreError && error.code === 'RECONCILE_REQUIRED');
  assert.deepEqual(store.get(original.id), checkpoint);

  await store.prepare({
    id: 'unrelated-metadata-only', specHash: 'b'.repeat(64),
    jobs: [{ id: 'unrelated-pending', dependsOn: [] }],
    resume: false, retryFailed: false, retryUnknown: false,
  });
  const restarted = new TaskGraphStore({ stateFile, retentionMs: 5 });
  await restarted.initialize();
  assert.deepEqual(restarted.get(original.id), checkpoint);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
    graphs: Array<{id: string}>
  };
  assert.ok(persisted.graphs.some(graph => graph.id === original.id));
});
