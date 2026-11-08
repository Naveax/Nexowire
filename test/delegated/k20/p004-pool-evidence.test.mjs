import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCiContext, auditFixedTapCount } from '../../../scripts/delegated/k20/ci-context-audit.mjs';
import { auditPlatformProof } from '../../../scripts/delegated/k20/platform-proof-audit.mjs';
import { auditIssueSourceEvidence } from '../../../scripts/delegated/k20/issue-source-evidence.mjs';

const prHead = 'd51d9d4c2c25797405227bad223039c6b31055d2';
const oldHead = '4e7db16f4233048a956664bef6b607781eb63fb7';
const job = (id, overrides = {}) => ({ id, run_id: 42411030903, run_attempt: 1,
  head_sha: prHead, status: 'completed', conclusion: 'success', ...overrides });
const ci = (overrides = {}) => ({
  pr: { number: 1118, head: { sha: prHead } },
  run: { id: 42411030903, run_attempt: 1, head_sha: prHead, event: 'pull_request',
    status: 'completed', conclusion: 'success' },
  jobsPage: { total_count: 2, jobs: [job(1), job(2)] }, ...overrides,
});

test('T-381: raw run, attempt, each job and complete page must match exact PR HEAD', () => {
  assert.equal(auditCiContext(ci()).verdict, 'REPORTED_GREEN_UNVERIFIED');
  const wrongRun = ci({ run: { ...ci().run, head_sha: oldHead } });
  assert.ok(auditCiContext(wrongRun).reasons.includes('RUN_HEAD_NOT_PR_HEAD'));
  const staleJob = ci({ jobsPage: { total_count: 2, jobs: [job(1), job(2, { head_sha: oldHead })] } });
  assert.ok(auditCiContext(staleJob).reasons.includes('STALE_HEAD_JOB:2'));
  const otherAttempt = ci({ jobsPage: { total_count: 2, jobs: [job(1), job(2, { run_attempt: 2 })] } });
  assert.ok(auditCiContext(otherAttempt).reasons.includes('FOREIGN_ATTEMPT_JOB:2'));
  const otherRun = ci({ jobsPage: { total_count: 2, jobs: [job(1), job(2, { run_id: 100 })] } });
  assert.ok(auditCiContext(otherRun).reasons.includes('FOREIGN_RUN_JOB:2'));
});

test('T-381: failed, cancelled, in-progress, skipped, zero or partial CI job pages are NO_GO', () => {
  for (const [status, conclusion] of [['completed', 'failure'], ['completed', 'cancelled'],
    ['completed', 'skipped'], ['in_progress', null]]) {
    const result = auditCiContext(ci({ jobsPage: { total_count: 2,
      jobs: [job(1), job(2, { status, conclusion })] } }));
    assert.equal(result.verdict, 'NO_GO');
  }
  assert.equal(auditCiContext(ci({ jobsPage: { total_count: 0, jobs: [] } })).verdict, 'NO_GO');
  assert.ok(auditCiContext(ci({ jobsPage: { total_count: 100, jobs: [job(1)] } }))
    .reasons.includes('INCOMPLETE_JOB_PAGINATION'));
  assert.throws(() => auditCiContext(ci({ jobsPage: { total_count: 2, jobs: [job(1), job(1)] } })));
  assert.equal(auditCiContext(ci({ run: { ...ci().run, event: 'pull_request_target' } })).verdict, 'NO_GO');
});

test('T-381: observed CI source pins 41 TAP tests; 50 passing assertions still trip that gate', () => {
  // Immutable reproduction of the 2026-11-07 workflow; the owner may safely
  // remove this pin later without breaking the delegated QA regression.
  const workflow = 'grep -qx \'# tests 41\' "$RUNNER_TEMP/nw-k20-qa.tap"\n' +
    'grep -qx \'# pass 41\' "$RUNNER_TEMP/nw-k20-qa.tap"\n';
  const audit = auditFixedTapCount(workflow, { tests: 50, passed: 50, failed: 0 });
  assert.equal(audit.verdict, 'FIXED_COUNT_MISMATCH');
  assert.deepEqual(audit.expectedTests, [41]);
  assert.deepEqual(audit.expectedPasses, [41]);
  assert.equal(audit.allAssertionsPassed, true);
  assert.equal(auditFixedTapCount('no fixed grep', { tests: 50, passed: 50, failed: 0 }).verdict,
    'NO_FIXED_COUNT_GATES_DETECTED');
});

const platform = (overrides = {}) => ({ targetPlatform: 'win32', runnerPlatform: 'win32',
  attempted: true, physical: true, machineEvidenceId: 'owner-work-pc-log-1',
  exitCode: 0, tests: 2, passed: 2, failed: 0, skipped: 0, ...overrides });

test('T-385: Windows-only tests skipped on Linux are NOT_RUN not PASS or FAIL', () => {
  assert.deepEqual(auditPlatformProof(platform({ runnerPlatform: 'linux', attempted: false })),
    { verdict: 'NOT_RUN', reason: 'OTHER_PLATFORM' });
  assert.deepEqual(auditPlatformProof(platform({ attempted: false })),
    { verdict: 'NOT_RUN', reason: 'NO_EXECUTION' });
  assert.deepEqual(auditPlatformProof(platform({ tests: 2, passed: 0, skipped: 2 })),
    { verdict: 'NOT_RUN', reason: 'NO_EXECUTED_TESTS' });
  assert.equal(auditPlatformProof(platform({ tests: 2, passed: 1, skipped: 1 })).verdict, 'PARTIAL');
});

test('T-385: zero test failures but nonzero TAP process exit remains FAIL', () => {
  assert.deepEqual(auditPlatformProof(platform({ exitCode: 1 })),
    { verdict: 'FAIL', reason: 'PROCESS_EXIT_NONZERO' });
  assert.equal(auditPlatformProof(platform({ timedOut: true })).verdict, 'FAIL');
  assert.equal(auditPlatformProof(platform({ physical: false })).verdict,
    'PASS_HOSTED_OR_SYNTHETIC_REPORTED');
  assert.equal(auditPlatformProof(platform({ machineEvidenceId: undefined })).verdict, 'INCOMPLETE');
  assert.equal(auditPlatformProof(platform()).verdict, 'PASS_PHYSICAL_REPORTED');
});

const issue = { number: 539, state: 'open' };
const pr = { number: 1031, state: 'closed', merged_at: null, head: { sha: prHead } };
const source = { mainHeadSha: oldHead, prHeadSha: prHead,
  files: [{ path: 'scripts/delegated/k20/example.mjs',
    sourceBlobSha: oldHead, mainBlobSha: oldHead }] };

test('T-388: owner-integrated same blobs never convert a closed-unmerged PR into merged', () => {
  const result = auditIssueSourceEvidence({ issue, pr, source });
  assert.deepEqual({ issue: result.issueState, lifecycle: result.prLifecycle,
    source: result.sourceState, device: result.installedState, resolved: result.resolvedClaimSupported },
  { issue: 'OPEN', lifecycle: 'CLOSED_UNMERGED', source: 'IDENTICAL_BLOBS_ON_MAIN',
    device: 'NOT_VERIFIED', resolved: false });
  assert.equal(auditIssueSourceEvidence({ issue, pr: { ...pr, merged_at: '2026-11-03T14:58:45Z' } }).prLifecycle,
    'MERGED');
});

test('T-388: unverified source or simulated/device-less PASS cannot close an open issue', () => {
  const missing = auditIssueSourceEvidence({ issue, pr });
  assert.equal(missing.sourceState, 'NOT_VERIFIED');
  const synthetic = auditIssueSourceEvidence({ issue, pr, source,
    device: { environment: 'synthetic', status: 'PASS', installedBuildSha: oldHead,
      evidenceId: 'unit', observedAt: '2026-11-07' } });
  assert.equal(synthetic.installedState, 'NO_ACCEPTED_PHYSICAL_EVIDENCE');
  assert.equal(synthetic.resolvedClaimSupported, false);
  assert.equal(auditIssueSourceEvidence({ issue, pr, source: { ...source,
    files: [{ path: 'doc', sourceBlobSha: prHead, mainBlobSha: oldHead }] } }).sourceState,
  'DIFFERENT_BLOBS');
  assert.throws(() => auditIssueSourceEvidence({ issue, pr, source: { ...source, prHeadSha: oldHead } }));
});
