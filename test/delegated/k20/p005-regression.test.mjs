import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTapGate, classifyPrReviewEvidence, summarizePrCohort, detectOwnerHeadDrift } from
  '../../../scripts/delegated/k20/p005-ci-audit.mjs';
import { auditP005Ownership, resolveDuplicatePoolClaim, classifyWindowsProcessIssue } from
  '../../../scripts/delegated/k20/p005-ownership-evidence.mjs';

const oldMain = '4e7db16f4233048a956664bef6b607781eb63fb7';
const newMain = 'b5a3f8840517d65ecbd6a018699c4c8bdde09987';
const k20Head = 'd51d9d4c2c25797405227bad223039c6b31055d2';
const workflow = `grep -qx '# tests 41' "$RUNNER_TEMP/nw-k20-qa.tap"
grep -qx '# pass 41' "$RUNNER_TEMP/nw-k20-qa.tap"
grep -qx '# fail 0' "$RUNNER_TEMP/nw-k20-qa.tap"
`;
const tap = n => `# tests ${n}\n# pass ${n}\n# fail 0\n# skipped 0\n# todo 0\n`;

test('T-509: #1118 all 50 assertions pass yet hard-coded 41 gate makes CI red', () => {
  const r = auditTapGate({ workflow, tap: tap(50), tapFile: 'nw-k20-qa.tap',
    prHead: k20Head, logHead: k20Head, jobConclusion: 'failure' });
  assert.equal(r.verdict, 'ASSERTIONS_GREEN_WORKFLOW_RED');
  assert.equal(r.gate, 'COUNT_DRIFT');
  assert.deepEqual(r.pins, { tests: [41], pass: [41] });
  assert.equal(r.result.fail, 0);
});

test('T-509: #1130 similarly fails at 48 green assertions; stable baseline 41 matches', () => {
  const input = { workflow, tapFile: 'nw-k20-qa.tap', prHead: k20Head,
    logHead: k20Head, jobConclusion: 'failure' };
  assert.equal(auditTapGate({ ...input, tap: tap(48) }).verdict, 'ASSERTIONS_GREEN_WORKFLOW_RED');
  assert.equal(auditTapGate({ ...input, tap: tap(41) }).gate, 'MATCH');
  const timeStamped = tap(50).split('\n').map(line => line && `2026-11-07T20:30:15.123456Z ${line}`).join('\n');
  assert.equal(auditTapGate({ ...input, tap: timeStamped }).gate, 'COUNT_DRIFT');
});

test('T-509: mismatched exact log HEAD and failing assertions never become source-fix PASS', () => {
  const input = { workflow, tapFile: 'nw-k20-qa.tap', prHead: k20Head,
    logHead: oldMain, jobConclusion: 'failure' };
  assert.equal(auditTapGate({ ...input, tap: tap(50) }).verdict, 'STALE_HEAD');
  assert.equal(auditTapGate({ ...input, logHead: k20Head, tap: '# tests 2\n# pass 1\n# fail 1\n# skipped 0\n# todo 0\n' }).verdict,
    'ASSERTION_INCOMPLETE_OR_FAILED');
  assert.equal(auditTapGate({ ...input, logHead: k20Head, tap: 'missing TAP' }).verdict,
    'UNKNOWN_TAP');
});

const greenJobs = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, status: 'completed', conclusion: 'success' }));
const cohortEntry = overrides => ({ number: 1112, headSha: k20Head, prState: 'open',
  mergedAt: null, run: { id: 42, headSha: k20Head, totalJobs: 7, status: 'completed', conclusion: 'success' },
  jobs: greenJobs, ...overrides });

test('T-510: 7/7 hosted CI alone proves neither nested test discovery nor physical acceptance', () => {
  const x = classifyPrReviewEvidence(cohortEntry());
  assert.deepEqual({ ci: x.ci, discovery: x.discovery, physical: x.physical, acceptance: x.ownerAcceptance },
    { ci: 'REPORTED_7_OF_7_GREEN', discovery: 'NOT_VERIFIED',
      physical: 'NOT_RUN_OR_UNVERIFIED', acceptance: 'NOT_INFERRED' });
  assert.equal(classifyPrReviewEvidence(cohortEntry({
    newTestPaths: ['test/delegated/k20/nested.test.mjs'], executedTestPaths: [],
  })).discovery, 'MISSING_TEST_DISCOVERY');
});

test('T-510: failed job beside six green, stale head or incomplete page is never green', () => {
  const failed = classifyPrReviewEvidence(cohortEntry({
    jobs: [...greenJobs.slice(0, 6), { id: 7, status: 'completed', conclusion: 'failure' }],
  }));
  assert.equal(failed.ci, 'CI_NOT_GREEN');
  assert.equal(classifyPrReviewEvidence(cohortEntry({
    run: { id: 42, headSha: oldMain, totalJobs: 7, status: 'completed', conclusion: 'success' },
  })).ci, 'STALE_HEAD');
  assert.equal(classifyPrReviewEvidence(cohortEntry({
    run: { id: 42, headSha: k20Head, totalJobs: 8, status: 'completed', conclusion: 'success' },
  })).ci, 'INCOMPLETE_JOBS');
  assert.equal(classifyPrReviewEvidence(cohortEntry({
    run: { id: 42, headSha: k20Head, totalJobs: 1, status: 'completed', conclusion: 'success' },
    jobs: greenJobs.slice(0, 1),
  })).ci, 'REPORTED_1_OF_1_GREEN_NOT_SEVEN');
});

test('T-510: complete 32-PR cohort cannot silently omit or double-count a PR', () => {
  const sample = [cohortEntry({ number: 1099 }), cohortEntry({ number: 1100,
    jobs: [greenJobs[0]], run: { id: 42, headSha: k20Head, totalJobs: 1,
      status: 'completed', conclusion: 'success' } })];
  const result = summarizePrCohort(sample, { first: 1099, last: 1100 });
  assert.equal(result.complete, true);
  assert.equal(result.counts.ciReported7of7, 1);
  assert.equal(result.counts.discoveryNotVerified, 2);
  assert.equal(result.counts.physicalNotVerified, 2);
  assert.deepEqual(summarizePrCohort(sample.slice(0, 1), { first: 1099, last: 1100 }).missing, [1100]);
  assert.throws(() => summarizePrCohort([sample[0], sample[0]], { first: 1099, last: 1100 }));
});

test('T-511: pool T-385 belongs to smaller K02; K20 retains distinct code, not task credit', () => {
  assert.deepEqual(resolveDuplicatePoolClaim(385, ['K20', 'K16', 'K02']),
    { task: 385, owner: 'K02', nonCredit: ['K16', 'K20'] });
  assert.throws(() => resolveDuplicatePoolClaim(385, ['K20', 'K99']));
});

test('T-512: owner HEAD drift #1096 and #1068 invalidates earlier green job claims', () => {
  const old1096 = 'fe94e204a9f5b2b46b7fd4231c9292868f4e5e03';
  const new1096 = 'e879ecb8e70a0e798c73c6028400b11e3e8bb4e7';
  const new1068 = '94d38799e9e4b50fe84f7924e6fc84f90aeba090';
  assert.equal(detectOwnerHeadDrift({ prNumber: 1096, recordedHead: old1096,
    currentHead: new1096, runHead: old1096, runConclusion: 'success' }).verdict, 'STALE_EVIDENCE');
  assert.equal(detectOwnerHeadDrift({ prNumber: 1068, recordedHead: oldMain,
    currentHead: new1068, runHead: new1068, runConclusion: 'success' }).verdict, 'STALE_EVIDENCE');
  assert.equal(detectOwnerHeadDrift({ prNumber: 1096, recordedHead: new1096,
    currentHead: new1096, runHead: new1096, runConclusion: 'success' }).verdict,
  'CURRENT_HEAD_REPORTED_GREEN_ONLY');
});

test('T-513: green K16 test/docs PR for #540 does not prove Windows ProcessManager fixed', () => {
  const evidence = classifyWindowsProcessIssue({ issue: { number: 540, state: 'open' },
    pull: { number: 1105, state: 'open', headSha: k20Head },
    paths: ['test/delegated/k16/windows-taskkill-contract.test.ts',
      'test/delegated/k16/WINDOWS_PROCESS_TREE_ACCEPTANCE.md'],
    ci: { headSha: k20Head, conclusion: 'success' } });
  assert.deepEqual({ source: evidence.sourceClass, ci: evidence.ciVerdict,
    physical: evidence.physicalVerdict, resolved: evidence.resolvedClaim },
  { source: 'QA_SOURCE_ONLY', ci: 'GREEN_REPORTED', physical: 'PHYSICAL_NOT_VERIFIED', resolved: false });
  assert.equal(classifyWindowsProcessIssue({ issue: { number: 540, state: 'open' },
    pull: { number: 1105, state: 'open', headSha: k20Head },
    paths: ['src/agent/process-manager.ts'], ci: { headSha: oldMain, conclusion: 'success' },
  }).ciVerdict, 'STALE_OR_UNKNOWN_HEAD');
});

const boardFixture = `### K01 — Connect
- **ROL/ALAN:** web/connect.html, web/connect.js; test/delegated/k01/**.
- **ODAK / ISSUE:** #485 #539. **Önceki açık:** test.
- **AKTİF T-395:** #485.
- **KUYRUK (1):**
  1. **T-396:** #539.
### K02 — Styles
- **ROL/ALAN:** web/styles.css; test/delegated/k02/**.
- **ODAK / ISSUE:** #485 #539. **Önceki açık:** test.
- **AKTİF T-401:** #485.
- **KUYRUK (1):**
  1. **T-402:** #539.
## HAVUZ — test
`;

test('T-514: P005 board counts worker/task ownership without confusing shared issue for path collision', () => {
  const x = auditP005Ownership(boardFixture);
  assert.equal(x.workers.length, 2);
  assert.deepEqual(x.assignments.map(a => a.id), [395,396,401,402]);
  assert.deepEqual(x.collisions, []);
  assert.deepEqual(x.duplicateTaskIds, []);
  const collision = auditP005Ownership(boardFixture.replace('web/styles.css', 'web/connect.js'));
  assert.deepEqual(collision.collisions[0].workers, ['K01', 'K02']);
  const duplicate = auditP005Ownership(boardFixture.replace('T-402', 'T-396'));
  assert.deepEqual(duplicate.duplicateTaskIds, [{ task: 396, workers: ['K01','K02'] }]);
});

test('T-514: source HEAD is immutable; new upstream main does not automatically accept old PR', () => {
  assert.notEqual(oldMain, newMain);
  assert.equal(classifyPrReviewEvidence(cohortEntry({
    prState: 'closed', mergedAt: '2026-11-07T20:00:00Z',
  })).lifecycle, 'MERGED');
});
