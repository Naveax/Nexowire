import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';
import { ProcessManager } from '../src/agent/process-manager.js';
import { ProgressSupervisor } from '../src/agent/progress-supervisor.js';
import { TaskGraphStore } from '../src/agent/task-graph-store.js';
import { RunbookStore } from '../src/agent/runbook-store.js';

test('real managed synthetic process: process.start/read progress separated from PID and proof', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-progress-integ-'));
  const progressSupervisor = new ProgressSupervisor({ stallAfterMs: 1000 });
  const manager = new ProcessManager({
    stateFile: path.join(dir, 'sessions.json'),
    onEvent: event => progressSupervisor.observeProcessEvent(event),
  });
  try {
    await manager.initialize();
    const fixture = path.resolve('test/fixtures/progress-proof-fixture.cjs');
    const started = (await executeCapability('process.start', {
      command: 'node "' + fixture + '"',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      cwd: dir,
    }, new PathPolicy(['*']), { processes: manager, progressSupervisor })) as {
      data: { sessionId: string; progress: Record<string, unknown> };
    };
    assert.ok(started.data.sessionId);
    const initial = started.data.progress;
    assert.equal(initial.state, 'progress_unknown');
    let latest: { data: {
      session: { status: string; exitCode: number | null };
      progress: Record<string, unknown>;
    } } | undefined;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      latest = (await executeCapability('process.read', {
        session_id: started.data.sessionId, wait_ms: 100, max_events: 30,
      }, new PathPolicy(['*']), { processes: manager, progressSupervisor })) as typeof latest;
      if (latest?.data.progress.completedCount === 2) break;
    }
    assert.ok(latest, 'process.read must return session');
    assert.ok(['running', 'exited'].includes(latest.data.session.status));
    assert.equal(latest.data.progress.completedCount, 2);
    assert.equal(latest.data.progress.pendingCount, 0);
    assert.ok(['active', 'reported_complete'].includes(String(latest.data.progress.state)));
    assert.equal(latest.data.progress.completionEvidence, 'self_reported_unverified');
    assert.equal(latest.data.progress.progressVerified, false);
    assert.equal(latest.data.progress.lastVerifiedProgressAt, null);
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('graph/runbook persisted counters are explicitly not independent application proof', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-proof-levels-'));
  try {
    const taskGraphs = new TaskGraphStore({stateFile:path.join(dir,'graphs.json')});
    const runbooks = new RunbookStore({stateFile:path.join(dir,'runbooks.json')});
    await Promise.all([taskGraphs.initialize(),runbooks.initialize()]);
    const graph = await taskGraphs.prepare({
      id:'graph-proof',specHash:'a'.repeat(64),jobs:[{id:'job',dependsOn:[]}],
      resume:false,retryFailed:false,retryUnknown:false,
    });
    graph.status = 'succeeded';
    graph.jobs[0]!.status = 'succeeded';
    graph.jobs[0]!.completedAt = '2026-10-18T16:00:00.000Z';
    // The file does not exist: a cached hash is NOT a fresh verification.
    graph.jobs[0]!.artifacts = [{
      requestedPath:path.join(dir,'missing.json'), path:path.join(dir,'missing.json'),
      size:50, sha256:'a'.repeat(64), modifiedAt:'2026-10-18T16:00:00.000Z',
    }];
    await taskGraphs.save(graph);
    const runbook = await runbooks.prepare({
      id:'runbook-proof',specHash:'b'.repeat(64),
      steps:[{id:'step',kind:'task_graph',dependsOn:[],taskGraphId:'graph-proof'}],
      resume:false,retryFailed:false,retryUnknown:false,
    });
    runbook.status = 'succeeded';
    runbook.steps[0]!.status = 'succeeded';
    runbook.steps[0]!.completedAt = '2026-10-18T16:00:00.000Z';
    await runbooks.save(runbook);
    const graphResult = await executeCapability('task.graph.get',
      {graph_id:'graph-proof'},new PathPolicy(['*']),{taskGraphs}) as {
        data:{progress:Record<string,unknown>}
      };
    const gp = graphResult.data.progress;
    assert.equal(gp.completedCount, 1);
    assert.equal(gp.lastRecordedJobCompletionAt, '2026-10-18T16:00:00.000Z');
    assert.equal(gp.lastVerifiedProgressAt, null);
    assert.equal(gp.progressVerified, false);
    assert.equal(gp.artifactReverificationRequired, true);
    assert.deepEqual(gp.resultArtifactSha256, ['a'.repeat(64)]);
    assert.equal(gp.unit, 'graph_jobs_not_application_work');
    const rbResult = await executeCapability('runbook.get',
      {runbook_id:'runbook-proof'},new PathPolicy(['*']),{runbooks}) as {
        data:{progress:Record<string,unknown>}
      };
    const rp = rbResult.data.progress;
    assert.equal(rp.completedCount, 1);
    assert.equal(rp.unit, 'runbook_steps_not_application_work');
    assert.equal(rp.lastVerifiedProgressAt, null);
    assert.equal(rp.progressVerified, false);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});
