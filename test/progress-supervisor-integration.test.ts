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

test('real managed synthetic process: process.start/read progress separated from PID and proof', async (t) => {
  // #559 requires an independently trusted native Job Object helper on
  // Windows. Do not bypass Process Manager ownership to make this green.
  // Its physical integration gate is SKIPPED when no helper is provisioned.
  if (process.platform === 'win32') {
    const helper = path.resolve('native/windows-job-owner.exe');
    const available = await fs.stat(helper).then(s => s.isFile()).catch(() => false);
    if (!available) {
      t.skip('Windows Job Object helper not provisioned: process.start physical acceptance blocked');
      return;
    }
  }
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

for (const mode of ['complete','false_progress'] as const) {
  test(`managed synthetic worker ${mode}: process exit and actual result hash must reconcile`, async t => {
    if (process.platform === 'win32') {
      const helper = path.resolve('native/windows-job-owner.exe');
      if (!(await fs.stat(helper).then(s=>s.isFile()).catch(()=>false))) {
        t.skip('Windows native Job owner helper not provisioned: physical start blocked');
        return;
      }
    }
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-managed-proof-'));
    const progressSupervisor=new ProgressSupervisor({stallAfterMs:2000});
    const manager=new ProcessManager({
      stateFile:path.join(root,'sessions.json'),
      onEvent:event=>progressSupervisor.observeProcessEvent(event),
    });
    let sessionId:string|undefined;
    let state='running';
    try{
      await manager.initialize();
      const fixture=path.resolve('test/fixtures/progress-managed-proof-worker.cjs');
      // The current Windows Job guardian invokes cmd.exe with Windows
      // argument quoting already applied. Keep this fixture's controlled
      // paths unquoted only when they contain no shell metacharacters;
      // otherwise fail closed rather than passing ambiguous quoting.
      const windows = process.platform==='win32';
      if(windows && !/^[A-Za-z0-9_:./\\\\-]+$/.test(fixture+root)) {
        throw new Error('UNSAFE_FIXTURE_PATH: native cmd quoting acceptance required');
      }
      const command=windows ? `node ${fixture} ${root} ${mode}` :
        `node "${fixture}" "${root}" ${mode}`;
      const started=await manager.start({
        command,shell:windows?'cmd':'bash',cwd:root,
      },new PathPolicy(['*']));
      sessionId=started.sessionId;
      assert.equal(progressSupervisor.snapshot(sessionId).progressVerified,false);
      await manager.write({session_id:sessionId,input:sessionId,append_newline:true});
      let last: Awaited<ReturnType<typeof manager.read>>|undefined;
      const deadline=Date.now()+12_000;
      let cursor=0;
      const testEvents: Array<{stream:string;text:string}>=[];
      while(Date.now()<deadline){
        last=await manager.read({session_id:sessionId,after_seq:cursor,wait_ms:200});
        cursor=last.nextSeq;
        testEvents.push(...last.events);
        state=last.session.status;
        if(state==='exited' && progressSupervisor.snapshot(sessionId).completedCount===2)break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.ok(last,'worker must report process outcome');
      assert.equal(last.session.status,'exited','controlled worker must exit; events: '+JSON.stringify(testEvents).slice(0,2600));
      assert.equal(last.session.exitCode,0,'OS-observed exit must be clean; controlled fixture events: '+JSON.stringify(testEvents).slice(0,2500));
      assert.equal(progressSupervisor.snapshot(sessionId).completedCount,2);
      const trusted={
        runRoot:root,
        scope:{ownerAccountId:'owner-fixture',deviceId:'device-fixture',
          projectId:'project-fixture',runId:'run-fixture',sessionId},
        expectedCount:2,
      };
      const evidence=await progressSupervisor.verifySessionFromDisk(sessionId,trusted);
      const proof=progressSupervisor.snapshot(sessionId);
      if(mode==='complete'){
        assert.equal(evidence.status,'verified');
        assert.equal(proof.state,'completed_verified');
        assert.equal(proof.verifiedCompletedCount,2);
        assert.equal(proof.verifiedPendingCount,0);
        assert.equal(proof.verifiedFailureCount,0);
        assert.equal(proof.progressVerified,true);
        assert.ok(proof.lastVerifiedProgressAt);
      }else{
        assert.equal(evidence.status,'unverified');
        assert.equal(evidence.reason,'SEALED_INCOMPLETE');
        assert.equal(proof.state,'progress_mismatch');
        assert.equal(proof.progressVerified,false);
        assert.equal(proof.lastVerifiedProgressAt,null);
      }
    }finally{
      if(sessionId && state==='running'){
        try{await manager.stop({session_id:sessionId});}catch{/* test-owned only */}
      }
      await manager.shutdown();
      await fs.rm(root,{recursive:true,force:true});
    }
  });
}
