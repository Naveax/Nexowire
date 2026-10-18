import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProgressSupervisor, PROGRESS_PREFIX, evaluateRetryPolicy,
} from '../src/agent/progress-supervisor.js';

const record = (completed_count: number, pending_count: number, failure_count = 0,
  extra: Record<string, unknown> = {}) =>
  PROGRESS_PREFIX + JSON.stringify({ completed_count, pending_count, failure_count, ...extra }) + '\n';

test('alive PID never implies progress, completion, or a made-up percentage', () => {
  let now = 0;
  const supervisor = new ProgressSupervisor({ now: () => now, stallAfterMs: 100 });
  supervisor.register('silent');
  assert.deepEqual(
    [supervisor.snapshot('silent').state, supervisor.snapshot('silent').completedCount],
    ['progress_unknown', null],
  );
  now = 101;
  assert.equal(supervisor.scan()[0]?.code, 'PROGRESS_UNKNOWN');
  assert.deepEqual(supervisor.scan(), []); // alert is de-duplicated
  assert.equal(supervisor.snapshot('silent').progressVerified, false);
  assert.equal(supervisor.snapshot('silent').lastVerifiedProgressAt, null);
});

test('fragmented newline records and unverified artifact digests are not completion proof', () => {
  let now = 100;
  const supervisor = new ProgressSupervisor({ now: () => now, stallAfterMs: 1000 });
  supervisor.register('worker');
  const line = record(2, 8, 1, { result_artifact_sha256: 'a'.repeat(64) });
  const part = Math.floor(line.length / 2);
  supervisor.observeProcessEvent({ topic: 'process.output', data: { sessionId: 'worker', stream: 'stdout', text: line.slice(0, part) } });
  assert.equal(supervisor.snapshot('worker').state, 'progress_unknown');
  now += 10;
  supervisor.observeProcessEvent({ topic: 'process.output', data: { sessionId: 'worker', stream: 'stdout', text: line.slice(part) } });
  const first = supervisor.snapshot('worker');
  assert.equal(first.state, 'active');
  assert.equal(first.completedCount, 2);
  assert.equal(first.pendingCount, 8);
  assert.equal(first.failureCount, 1);
  assert.equal(first.completionEvidence, 'self_reported_unverified');
  assert.equal(first.resultArtifactSha256Reported, 'a'.repeat(64));
  assert.equal(first.lastVerifiedProgressAt, null);
  now += 5;
  supervisor.observeProcessEvent({ topic: 'process.output', data: { sessionId: 'worker', stream: 'stdout', text: record(3, 7, 1) } });
  assert.equal(supervisor.snapshot('worker').lastReportedProgressAt, new Date(now).toISOString());
});

test('queue growth without completed progress triggers stuck warning, then clears after progress', () => {
  let now = 1000;
  const supervisor = new ProgressSupervisor({ now: () => now, stallAfterMs: 100 });
  supervisor.register('queue');
  supervisor.observeMetrics('queue', { completed_count: 0, pending_count: 10, failure_count: 0 });
  now += 20;
  supervisor.observeMetrics('queue', { completed_count: 0, pending_count: 11, failure_count: 0 });
  now += 130;
  assert.equal(supervisor.snapshot('queue').state, 'stalled');
  assert.equal(supervisor.scan()[0]?.code, 'QUEUE_GROWING_WITHOUT_COMPLETIONS');
  assert.equal(supervisor.scan().length, 0);
  now += 1;
  supervisor.observeMetrics('queue', { completed_count: 1, pending_count: 10, failure_count: 0 });
  assert.equal(supervisor.snapshot('queue').state, 'active');
  assert.equal(supervisor.scan().length, 0);
});

test('flat queue, reported blocker, stale heartbeat and failure are distinguished', () => {
  let now = 10;
  const supervisor = new ProgressSupervisor({ now: () => now, stallAfterMs: 100 });
  supervisor.register('flat');
  supervisor.register('rate');
  supervisor.register('crash');
  supervisor.observeMetrics('flat', { completed_count: 0, pending_count: 5, failure_count: 0 });
  supervisor.observeMetrics('rate', { completed_count: 1, pending_count: 5, failure_count: 0, diagnosis: 'rate_limited' });
  supervisor.observeProcessEvent({ topic: 'process.exited', data: { sessionId: 'crash', exitCode: 1 } });
  now += 150;
  const warnings = supervisor.scan();
  assert.equal(warnings.find(x => x.sessionId === 'flat')?.code, 'NO_COMPLETIONS');
  assert.equal(warnings.find(x => x.sessionId === 'rate')?.code, 'WORKER_REPORTED_BLOCKER');
  assert.equal(warnings.find(x => x.sessionId === 'rate')?.certainty, 'worker_reported');
  assert.equal(warnings.find(x => x.sessionId === 'crash')?.code, 'PROCESS_EXITED_FAILED');
  assert.ok(warnings.every(x => x.restartAllowed === false));
  assert.equal(supervisor.snapshot('crash').state, 'failed');
});

test('malformed and regressing metrics cannot fabricate heartbeat or counter progress', () => {
  let now = 0;
  const supervisor = new ProgressSupervisor({ now: () => now });
  supervisor.register('x');
  const bad = [
    PROGRESS_PREFIX + '{"completed_count":-1,"pending_count":2,"failure_count":0}\n',
    PROGRESS_PREFIX + '{"completed_count":1,"pending_count":2,"failure_count":0,"secret":"x"}\n',
    PROGRESS_PREFIX + 'not-json\n',
    PROGRESS_PREFIX + '{"completed_count":1,"pending_count":2,"failure_count":0' + 'x'.repeat(12000) + '\n',
  ];
  for (const payload of bad) supervisor.observeProcessEvent({ topic:'process.output', data:{ sessionId:'x', stream:'stdout', text:payload } });
  assert.equal(supervisor.snapshot('x').completedCount, null);
  assert.equal(supervisor.observeMetrics('x', { completed_count: 8, pending_count: 2, failure_count: 3 }), true);
  now = 100;
  assert.equal(supervisor.observeMetrics('x', { completed_count: 7, pending_count: 3, failure_count: 2 }), false);
  assert.equal(supervisor.snapshot('x').completedCount, 8);
  assert.equal(supervisor.snapshot('x').heartbeatAt, new Date(0).toISOString());
});

test('exiting with pending work is incomplete even for exit code zero', () => {
  const supervisor = new ProgressSupervisor();
  supervisor.register('partial');
  supervisor.observeMetrics('partial', { completed_count: 9, pending_count: 1, failure_count: 0 });
  supervisor.observeProcessEvent({ topic: 'process.exited', data: { sessionId: 'partial', exitCode: 0 } });
  assert.equal(supervisor.snapshot('partial').state, 'incomplete');
  assert.equal(supervisor.scan()[0]?.code, 'PROCESS_EXITED_INCOMPLETE');
});

test('retry safety requires explicit owner approval, bounded budget and reconciliation', () => {
  const base = { effect:'idempotent' as const, ownerApproved:true, retryBudget:2, attemptsUsed:1, processTerminatedAndReconciled:true };
  assert.equal(evaluateRetryPolicy(base).restartAllowed, true);
  for (const variant of [
    { ...base, ownerApproved:false },
    { ...base, effect:'side_effecting' as const },
    { ...base, effect:'unknown' as const },
    { ...base, retryBudget:1 },
    { ...base, processTerminatedAndReconciled:false },
  ]) assert.equal(evaluateRetryPolicy(variant).restartAllowed, false);
});

for (const count of [10, 100, 1000]) {
  test(`synthetic ${count} jobs: counters, bounds and no false 100% without proof`, () => {
    let now = 1;
    const supervisor = new ProgressSupervisor({ now: () => now, maxSessions:1000, stallAfterMs:10000 });
    for (let n = 0; n < count; n++) {
      const id = 'worker-' + n;
      supervisor.register(id);
      supervisor.observeProcessEvent({ topic: 'process.output', data: {
        sessionId:id, stream:'stdout', text:record(n % 3, count - n, n % 2),
      } });
      const snapshot = supervisor.snapshot(id);
      assert.equal(snapshot.pendingCount, count - n);
      assert.equal(snapshot.progressVerified, false);
      assert.equal(snapshot.lastVerifiedProgressAt, null);
    }
    now = 5;
    assert.equal(supervisor.trackedSessionCount, count);
    assert.equal(supervisor.scan().length, 0);
    supervisor.register('overflow');
    assert.equal(supervisor.trackedSessionCount, Math.min(1000, count + 1));
    if (count === 1000) assert.equal(supervisor.snapshot('overflow').state, 'progress_unknown');
  });
}
