import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, randomBytes, randomUUID} from 'node:crypto';
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

test('full AAD refuses a legacy path-only ciphertext for changed source/worktree/grant', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  const [name] = await (await import('node:fs/promises')).readdir(d.dir);
  const file = path.join(d.dir, name!);
  // Adversarial test-only legacy envelope: the old AAD bound ONLY the file
  // path, so a correctly tagged payload with a different source/worktree or
  // epoch could be opened before the post-decryption scope comparison.
  // NEW AAD binds the exact expected identity BEFORE plaintext parsing.
  for (const modify of [
    (c: SecureTaskCheckpoint) => {c.scope.worktreeId = randomUUID()},
    (c: SecureTaskCheckpoint) => {c.scope.sourceSha = 'f'.repeat(40); c.ciWitnesses[0]!.sourceSha = c.scope.sourceSha},
    (c: SecureTaskCheckpoint) => {c.scope.ownerEpoch++; c.approvals[0]!.approvalEpoch++},
    (c: SecureTaskCheckpoint) => {c.scope.signedGrantScopeDigest = hash('f'); c.approvals[0]!.grantScopeDigest = hash('f')},
  ]) {
    const alternative = structuredClone(cp);
    modify(alternative);
    assert.equal(SecureTaskCheckpointSchema.safeParse(alternative).success, true);
    const iv = Buffer.alloc(12, 4);
    const cipher = createCipheriv('aes-256-gcm', d.key, iv);
    cipher.setAAD(Buffer.from('Nexowire/secure-task-checkpoint/v1/' + file));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(alternative)), cipher.final(),
    ]);
    await writeFile(file, JSON.stringify({version: 1, iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64')}));
    const denied = await d.open().restore(alternative.scope, true);
    assert.equal(denied.verdict, 'STOP');
    assert.equal(denied.reason, 'CORRUPT_OR_MISSING');
    assert.equal(denied.mayDispatch, false);
    assert.equal(denied.mayReplay, false);
  }
});

test('well-formed AEAD envelope with corrupted tag fails closed', async t => {
  const d = await disposable(t);
  const cp = fixture();
  await d.open().create(cp);
  const [name] = await (await import('node:fs/promises')).readdir(d.dir);
  const file = path.join(d.dir, name!);
  const envelope = JSON.parse(await readFile(file, 'utf8')) as {
    version: number; iv: string; tag: string; ciphertext: string;
  };
  envelope.tag = (envelope.tag[0] === 'a' ? 'b' : 'a') + envelope.tag.slice(1);
  await writeFile(file, JSON.stringify(envelope));
  const result = await d.open().restore(cp.scope, true);
  assert.equal(result.verdict, 'STOP');
  assert.equal(result.reason, 'CORRUPT_OR_MISSING');
  await assert.rejects(d.open().create(cp), {code: 'EEXIST'});
});

test('approval/CI metadata reject accidental private output and token-shaped IDs', () => {
  const cp = fixture();
  const cases: unknown[] = [
    {...cp, approvals: [{...cp.approvals[0], rawDiff: 'private diff'}]},
    {...cp, approvals: [{...cp.approvals[0], token: 'PRIVATE_TOKEN'}]},
    {...cp, approvals: [{...cp.approvals[0], justification: 'PRIVATE_TEXT'}]},
    {...cp, ciWitnesses: [{...cp.ciWitnesses[0], stdout: 'PRIVATE_STDOUT'}]},
    {...cp, ciWitnesses: [{...cp.ciWitnesses[0], stderr: 'PRIVATE_STDERR'}]},
    {...cp, ciWitnesses: [{...cp.ciWitnesses[0], secret: 'PRIVATE_SECRET'}]},
    {...cp, scope: {...cp.scope, taskId: 'ghp_' + 'Z'.repeat(36)}},
    {...cp, scope: {...cp.scope, taskId: 'github_pat_' + 'Z'.repeat(30)}},
    {...cp, events: [{...cp.events[0], stepId: 'sk-' + 'Z'.repeat(30)}]},
    {...cp, mutation: {...cp.mutation, originalErrorCode: 'ghp_' + 'Z'.repeat(36)}},
  ];
  for (const candidate of cases) {
    assert.equal(SecureTaskCheckpointSchema.safeParse(candidate).success, false);
  }
});

test('UNKNOWN and CI/approval lineage remain sticky after repeated compaction', async t => {
  const d = await disposable(t);
  const cp = fixture();
  cp.mutation.state = 'RECONCILE_REQUIRED';
  cp.mutation.pendingUnknown = true;
  cp.mutation.originalErrorCode = 'MUTATION_STATE_UNKNOWN';
  cp.events[0]!.outcome = 'UNKNOWN';
  await d.open().create(cp);
  let prior = cp;
  let revision = (await d.open().restore(cp.scope, true)).revision!;
  for (let cycle = 0; cycle < 3; cycle++) {
    const folded = compactTaskContext(prior);
    revision = await d.open().update(prior, folded, revision);
    const resumed = await d.open().restore(cp.scope, true);
    assert.equal(resumed.verdict, 'RECONCILE_REQUIRED');
    assert.equal(resumed.mayReplay, false);
    assert.equal(resumed.snapshot?.mutation.requestId, cp.mutation.requestId);
    assert.deepEqual(resumed.snapshot?.approvals, cp.approvals);
    assert.deepEqual(resumed.snapshot?.ciWitnesses, cp.ciWitnesses);
    const erased = structuredClone(folded);
    erased.mutation.pendingUnknown = false;
    erased.mutation.state = 'PLANNED';
    delete erased.mutation.originalErrorCode;
    await assert.rejects(d.open().update(folded, erased, revision));
    if (cycle === 2) break;
    const appended = structuredClone(folded);
    appended.events.push({stepId: 'step-' + (cycle + 2), phase: 'OBSERVE',
      outcome: 'UNKNOWN', fingerprint: hash('e')});
    revision = await d.open().update(folded, appended, revision);
    prior = appended;
  }
  const snapshot = (await d.open().restore(cp.scope, true)).snapshot!;
  assert.equal(snapshot.foldedEvents?.count, 3);
  assert.equal(snapshot.mutation.pendingUnknown, true);
});
