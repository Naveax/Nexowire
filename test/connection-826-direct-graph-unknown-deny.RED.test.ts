/**
 * #06 intentionally RED security regression for the actual executor entry.
 *
 * The original runbook's UNKNOWN is durable; after a simulated session
 * rename/re-pair, direct task.graph.run MUST have zero native-capable
 * subprocess invocations while protected offhost CAS is unavailable.
 * Current #826 does not enforce this at the direct graph entry.
 *
 * Commands are INERT console markers in a disposable temporary test
 * directory. This tests dispatch admission, NOT a real OS write, WSS
 * authentication, or physical duplicate mutation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDurableRunbook } from '../src/agent/runbooks.js';
import { executeCapability } from '../src/agent/executors.js';
import { RunbookStore } from '../src/agent/runbook-store.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('#06 RED: cloned UNKNOWN must deny direct graph native-capable dispatch without external CAS', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nx06-red-graph-alias-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const runbooks = new RunbookStore({ stateFile: path.join(root, 'runbooks.json') });
  const graphs = new TaskGraphStore({ stateFile: path.join(root, 'graphs.json') });
  await runbooks.initialize();
  await graphs.initialize();

  // This immutable tuple must be recovered from a trusted journal / owner
  // readback before dispatch. Neither public runbook.run nor task.graph.run
  // accepts/validates it today. NEVER pass it off as a trusted CAS fixture.
  const original = Object.freeze({
    logicalMutationId: 'logical-original-1',
    requestId: 'fd953236-6a11-4c72-a472-478a864f7e40',
    sourceSha: 'b'.repeat(40),
    worktreeId: 'original-worktree-1',
    ownerEpoch: 7,
    grantGeneration: 2,
    ownerId: 'owner-test',
    deviceId: 'device-test',
  });
  const steps = [{
    id: 'logical-original-step',
    kind: 'task_graph' as const,
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

  // Simulate a session/re-pair alias by fresh graph IDs. The actual direct
  // capability API cannot bind either alias to the original immutable tuple.
  // Two harmless marker processes represent two unauthorized admissions.
  const policy = new PathPolicy([root]);
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  let nativeCapableDispatches = 0;
  for (const graph_id of ['clone-session-epoch8-a', 'clone-session-epoch9-b']) {
    const result = await executeCapability('task.graph.run', {
      graph_id, max_parallel: 1, total_timeout_ms: 20_000,
      jobs: [{
        id: 'inert-job', shell, cwd: root,
        command: 'node -e "console.log(\'INERT_GRAPH_EXECUTOR_MARKER\')"',
      }],
    }, policy, { taskGraphs: graphs }) as {
      data: { ok: boolean; results: Array<{ status: string; stdout?: string }> };
    };
    if (result.data.results[0]?.stdout?.includes('INERT_GRAPH_EXECUTOR_MARKER')) {
      nativeCapableDispatches++;
    }
  }

  assert.equal(runbooks.get('original-runbook').steps[0]?.status, 'unknown');
  assert.equal(runbooks.get('original-runbook').steps[0]?.errorCode, 'RECONCILE_REQUIRED');
  // Deliberately RED on current source: the actual direct task.graph.run
  // dispatches twice. A correct shared external CAS admission must deny.
  assert.equal(
    nativeCapableDispatches,
    0,
    'SECURITY RED: original UNKNOWN + no external CAS must forbid both cloned native-capable graph dispatches',
  );
});
