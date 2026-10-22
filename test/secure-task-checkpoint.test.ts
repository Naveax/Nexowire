import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SecureTaskCheckpointStore, SecureTaskCheckpointSchema,
  compactTaskContext, type SecureTaskCheckpoint} from
  '../src/coding/secure-task-checkpoint/index.js';

const hash = (c: string) => c.repeat(64);
const src = 'a'.repeat(40);
function fixture(): SecureTaskCheckpoint {
  return {
    version: 1,
    scope: {ownerId: randomUUID(), deviceId: randomUUID(), taskId: 'task-34',
      worktreeId: randomUUID(), sourceSha: src, ownerEpoch: 7, grantGeneration: 3,
      signedGrantScopeDigest: hash('b')},
    mutation: {logicalMutationId: randomUUID(), requestId: randomUUID(),
      fingerprint: hash('c'), state: 'PLANNED', pendingUnknown: false},
    budget: {maxSteps: 10, stepsUsed: 1, maxTools: 8, toolsUsed: 1,
      maxElapsedMs: 60_000, elapsedMs: 100},
    cancelled: false,
    approvals: [{approvalId: randomUUID(), decision: 'APPROVED',
      approvalEpoch: 7, diffFingerprint: hash('d'), grantScopeDigest: hash('b')}],
    ciWitnesses: [{sourceSha: src, workflowId: 2, runId: 39841880930,
      conclusion: 'FAILURE'}],
    events: [{stepId: 'step-1', phase: 'PLAN', outcome: 'SUCCEEDED_LOCAL',
      fingerprint: hash('e')}],
  };
}
async function disposable(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nw-secure-task-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const key = randomBytes(32);
  return {dir, key, open: () => new SecureTaskCheckpointStore(dir, key)};
}

test('sealed metadata round trips after restart but can only be inspected', async t => {
  const d = await disposable(t);
  const cp = fixture();
  const revision = await d.open().create(cp);
  const result = await d.open().restore(cp.scope, true);
  assert.equal(result.verdict, 'INSPECT_ONLY');
  assert.equal(result.revision, revision);
  assert.equal(result.mayDispatch, false);
  assert.equal(result.mayReplay, false);
  assert.equal(result.completedVerified, false);
  assert.deepEqual(result.snapshot, cp);
  const filename = (await import('node:fs/promises')).readdir(d.dir);
  const raw = await readFile(path.join(d.dir, (await filename)[0]!), 'utf8');
  for (const secret of [cp.mutation.requestId, cp.scope.ownerId, cp.scope.taskId,
    cp.approvals[0]!.approvalId]) assert.equal(raw.includes(secret), false);
});

test('UNKNOWN after lost ACK survives encrypted restore and cannot replay', async t => {
  const d = await disposable(t);
  const cp = fixture();
  cp.mutation.state = 'RECONCILE_REQUIRED';
  cp.mutation.pendingUnknown = true;
  cp.mutation.originalErrorCode = 'MUTATION_STATE_UNKNOWN';
  await d.open().create(cp);
  const resumed = await d.open().restore(cp.scope, true);
  assert.equal(resumed.verdict, 'RECONCILE_REQUIRED');
  assert.equal(resumed.reason, 'UNKNOWN_NEEDS_EXTERNAL_CAS');
  assert.equal(resumed.snapshot?.mutation.requestId, cp.mutation.requestId);
  assert.equal(resumed.mayReplay, false);
  const cleared = structuredClone(cp);
  cleared.mutation.pendingUnknown = false;
  cleared.mutation.state = 'PLANNED';
  delete cleared.mutation.originalErrorCode;
  await assert.rejects(
    d.open().update(cp, cleared, resumed.revision!), /CHECKPOINT_UNKNOWN_PROVENANCE_ERASED/);
});

test('revoked grant, changed owner epoch, worktree or SHA fails closed', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  assert.equal((await d.open().restore(cp.scope, false)).reason, 'GRANT_REVOKED');
  for (const mutation of [
    (s: typeof cp.scope) => {s.ownerEpoch++},
    (s: typeof cp.scope) => {s.grantGeneration++},
    (s: typeof cp.scope) => {s.worktreeId = randomUUID()},
    (s: typeof cp.scope) => {s.sourceSha = 'f'.repeat(40)},
  ]) {
    const scope = structuredClone(cp.scope);
    mutation(scope);
    const response = await d.open().restore(scope, true);
    assert.equal(response.verdict, 'STOP');
    assert.ok(['SCOPE_OR_GRANT_STALE', 'CORRUPT_OR_MISSING'].includes(response.reason));
  }
});

test('corrupt/truncated ciphertext and wrong key stop, never reset to empty', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  assert.equal((await new SecureTaskCheckpointStore(d.dir, randomBytes(32))
    .restore(cp.scope, true)).verdict, 'STOP');
  const files = await (await import('node:fs/promises')).readdir(d.dir);
  await writeFile(path.join(d.dir, files[0]!), '{"version":1,"ciphertext":"broken"}');
  assert.equal((await d.open().restore(cp.scope, true)).reason, 'CORRUPT_OR_MISSING');
  await assert.rejects(d.open().create(cp), {code: 'EEXIST'});
});

test('metadata-only strict schema rejects credentials, command output and arbitrary summary', () => {
  const cp = fixture();
  for (const forbidden of [
    {...cp, token: 'PRIVATE_TOKEN'},
    {...cp, commandOutput: 'PRIVATE_STDOUT'},
    {...cp, summary: 'password=private'},
    {...cp, mutation: {...cp.mutation, password: 'PRIVATE_PASSWORD'}},
    {...cp, events: [...cp.events, {...cp.events[0], stdout: 'PRIVATE'}]},
  ]) assert.equal(SecureTaskCheckpointSchema.safeParse(forbidden).success, false);
});

test('budget exhausted, cancellation and historical approvals remain denial only', async t => {
  const d = await disposable(t);
  const cp = fixture();
  cp.budget.stepsUsed = cp.budget.maxSteps;
  await d.open().create(cp);
  assert.equal((await d.open().restore(cp.scope, true)).reason, 'BUDGET_EXHAUSTED');
  const second = fixture();
  const fresh = await disposable(t);
  await fresh.open().create(second);
  const restored = await fresh.open().restore(second.scope, true);
  const cancelled = {...structuredClone(second), cancelled: true};
  const nextRev = await fresh.open().update(second, cancelled, restored.revision!);
  assert.equal((await fresh.open().restore(second.scope, true)).reason, 'CANCELLED');
  await assert.rejects(fresh.open().update(cancelled, second, nextRev),
    /CHECKPOINT_CANCELLATION_ERASED/);
});

test('deterministic compaction keeps original identity, approvals, CI and UNKNOWN', async t => {
  const d = await disposable(t);
  const cp = fixture();
  cp.mutation.pendingUnknown = true;
  cp.mutation.state = 'RECONCILE_REQUIRED';
  cp.mutation.originalErrorCode = 'MUTATION_STATE_UNKNOWN';
  await d.open().create(cp);
  const compacted = compactTaskContext(cp);
  assert.deepEqual(compactTaskContext(cp), compacted);
  assert.equal(compacted.events.length, 0);
  assert.equal(compacted.foldedEvents?.count, 1);
  assert.deepEqual(compacted.approvals, cp.approvals);
  assert.deepEqual(compacted.ciWitnesses, cp.ciWitnesses);
  assert.deepEqual(compacted.mutation, cp.mutation);
  const restored = await d.open().restore(cp.scope, true);
  const revision = await d.open().update(cp, compacted, restored.revision!);
  assert.equal((await d.open().restore(cp.scope, true)).revision, revision);
  assert.equal((await d.open().restore(cp.scope, true)).verdict, 'RECONCILE_REQUIRED');
});

test('revisions fail on concurrent/stale updates and refuse erased witnesses', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  const restored = await d.open().restore(cp.scope, true);
  const next = structuredClone(cp);
  next.budget.stepsUsed++;
  const revision = await d.open().update(cp, next, restored.revision!);
  await assert.rejects(d.open().update(cp, next, restored.revision!),
    /CHECKPOINT_STALE_REVISION/);
  const removedApproval = structuredClone(next);
  removedApproval.approvals = [];
  await assert.rejects(d.open().update(next, removedApproval, revision),
    /CHECKPOINT_APPROVAL_HISTORY_ERASED/);
  const removedCi = structuredClone(next);
  removedCi.ciWitnesses = [];
  await assert.rejects(d.open().update(next, removedCi, revision),
    /CHECKPOINT_CI_WITNESS_ERASED/);
  const cloned = structuredClone(next);
  cloned.mutation.logicalMutationId = randomUUID();
  await assert.rejects(d.open().update(next, cloned, revision),
    /CHECKPOINT_IMMUTABLE_SCOPE_CHANGED/);
});

test('crash-created partial primary remains corrupt and never auto-replaced', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  const files = await (await import('node:fs/promises')).readdir(d.dir);
  await writeFile(path.join(d.dir, files[0]!), '{"version":1');
  assert.equal((await d.open().restore(cp.scope, true)).verdict, 'STOP');
  await assert.rejects(d.open().create(cp), {code: 'EEXIST'});
});
