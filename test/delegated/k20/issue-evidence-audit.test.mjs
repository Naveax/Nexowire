import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPullRequest, auditTeamBoard, auditHold271, evaluateAcceptance,
} from '../../../scripts/delegated/k20/issue-evidence-audit.mjs';

const mainSha = '4e7db16f4233048a956664bef6b607781eb63fb7';
const oldSha = '99a76109e69e73c5a835b8ac6e980ee1d2dcb8d5';
const board = `### K01 — Connect
- ROL/ALAN: \`web/connect.js, web/connect.html\`; \`test/delegated/k01/**\`
- İLGİLİ ISSUE: #485, #539/R01. SAHİPLİK/BAĞIMLILIK: #1068 owner
- **AKTİF: T-255** — #485 inspect
- **KUYRUK (1):**
  - T-256 — #539 check
### K02 — CSS
- ROL/ALAN: \`web/styles.css\`; \`test/delegated/k02/**\`
- İLGİLİ ISSUE: #485, #539/R11. SAHİPLİK/BAĞIMLILIK: #1068 owner
- **AKTİF: T-261** — #485 inspect
`;

test('PR closed-unmerged is never labelled merged because owner PR later integrated files', () => {
  const source = { number: 1031, state: 'closed', merged_at: null };
  assert.deepEqual(classifyPullRequest(source), {
    number: 1031, lifecycle: 'closed-unmerged',
    sourceDisposition: 'no-independent-integration-proof',
  });
  assert.deepEqual(classifyPullRequest({ number: 1066, state: 'closed', merged_at: '2026-11-03T14:58:45Z' }).lifecycle, 'merged');
  assert.equal(classifyPullRequest({ number: 1096, state: 'open', merged_at: null }).lifecycle, 'open');
});

test('superseded demands verified exact-head source evidence and remains closed-unmerged', () => {
  const source = { number: 1031, state: 'closed', merged_at: null };
  const evidence = { ownerPrNumber: 1066, ownerMergedAt: '2026-11-03T14:58:45Z',
    sourceMainSha: mainSha, sourcePrHeadSha: oldSha,
    verifiedMatchingPaths: ['docs/delegated/maintenance-k20/ISSUES.md'] };
  assert.deepEqual(classifyPullRequest(source, evidence), {
    number: 1031, lifecycle: 'closed-unmerged',
    sourceDisposition: 'superseded-with-source-evidence',
  });
  assert.throws(() => classifyPullRequest(source, { ...evidence, verifiedMatchingPaths: [] }));
  assert.throws(() => classifyPullRequest({ ...source, state: 'open' }, evidence));
  assert.throws(() => classifyPullRequest({ ...source, state: 'open', merged_at: '2026-11-03' }));
});

test('board enumerates worker→issue mapping and distinct safe-owned files', () => {
  const result = auditTeamBoard(board);
  assert.deepEqual(result.workers.map(x => x.worker), ['K01', 'K02']);
  assert.deepEqual(result.workers[0].issues, [485, 539]);
  assert.deepEqual(result.workers[0].tasks.map(x => x.task), [255, 256]);
  assert.deepEqual(result.workers[0].tasks[0].issues, [485]);
  assert.deepEqual(result.overlaps, []);
  const duplicate = board.replace('web/styles.css', 'web/connect.js');
  assert.deepEqual(auditTeamBoard(duplicate).overlaps[0].workers, ['K01', 'K02']);
});

test('hold #271 cannot be reactivated by a new board task', () => {
  const hold = '- [ ] P0 #271 is explicitly **ON HOLD by user instruction**. No ACL remediation.';
  assert.deepEqual(auditHold271(hold, board).invalidAssignments, []);
  const mistake = board.replace('T-256 — #539 check', 'T-256 — #271 fix ACL');
  assert.deepEqual(auditHold271(hold, mistake).invalidAssignments,
    [{ worker: 'K01', task: 256 }]);
  const guard = board.replace('T-256 — #539 check', 'T-256 — #481: ON HOLD #271 yanlışlıkla görevlendirilmesini engelle');
  assert.deepEqual(auditHold271(hold, guard).invalidAssignments, []);
  assert.deepEqual(auditHold271(hold, guard).protectiveChecks, [{ worker: 'K01', task: 256 }]);
  assert.throws(() => auditHold271('P0 #271 active!', board));
});

test('zero jobs, wrong HEAD, skipped, pending or failed CI never count as DONE', () => {
  const success = { expectedHead: mainSha, ci: { head_sha: mainSha,
    jobs: [{ name: 'test', head_sha: mainSha, status: 'completed', conclusion: 'success' }] } };
  assert.equal(evaluateAcceptance(success).decision, 'PASS');
  assert.ok(evaluateAcceptance({ ...success, ci: { head_sha: mainSha, jobs: [] } })
    .blockers.includes('CI_ZERO_JOBS'));
  assert.equal(evaluateAcceptance({ ...success, ci: { ...success.ci, head_sha: oldSha } }).decision, 'NO_GO');
  for (const [status, conclusion] of [['completed', 'skipped'], ['in_progress', null],
    ['completed', 'failure'], ['queued', null]]) {
    assert.equal(evaluateAcceptance({ ...success, ci: { head_sha: mainSha,
      jobs: [{ name: 'win', head_sha: mainSha, status, conclusion }] } }).decision, 'NO_GO');
  }
});

test('synthetic or NOT_RUN Windows proof rejects physical acceptance even with green CI', () => {
  const success = { expectedHead: mainSha, ci: { head_sha: mainSha,
    jobs: [{ name: 'test', head_sha: mainSha, status: 'completed', conclusion: 'success' }] } };
  for (const physical of [
    [{ name: 'two-PC', status: 'NOT_RUN', environment: 'physical-windows' }],
    [{ name: 'two-PC', status: 'PASS', environment: 'synthetic', evidenceId: 'fixture-1', observedAt: '2026-11-07' }],
    [{ name: 'two-PC', status: 'PASS', environment: 'physical-windows', evidenceId: '', observedAt: '2026-11-07' }],
  ]) assert.equal(evaluateAcceptance({ ...success, physical }).decision, 'NO_GO');
});
