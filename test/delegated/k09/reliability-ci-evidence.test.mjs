import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileReliability, reportReliability, snapshot } from './reliability-ci-evidence.mjs';

test('issue #539: main backlog matches the 22 open R IDs', () => {
  const out = reconcileReliability();
  assert.equal(out.rCount, 22);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows.map((row) => row.issue539), ['OPEN_NOT_RESOLVED', 'OPEN_NOT_RESOLVED']);
});

test('both K09 PRs: 7/7 hosted CI cannot prove undiscovered nested MJS assertions', () => {
  const out = reconcileReliability();
  assert.deepEqual(out.rows.map((row) => row.hostedCi), ['RUN_SUCCESS', 'RUN_SUCCESS']);
  assert.deepEqual(out.rows.map((row) => row.delegatedTest), ['NOT_PROVEN', 'NOT_PROVEN']);
  assert.deepEqual(out.rows.map((row) => row.physical), ['NOT_RUN', 'NOT_RUN']);
});

test('changed canonical backlog blob fails closed rather than reusing 22/22 evidence', () => {
  const changed = { ...snapshot, source: { ...snapshot.source,
    'docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md': '0'.repeat(40) } };
  assert.throws(() => reconcileReliability(changed), /Source drift/);
});

test('duplicate R ID and duplicate PR identity both rejected', () => {
  assert.throws(() => reconcileReliability({ ...snapshot, issueIds: [...snapshot.issueIds, 'R01'] }), /IDs diverge/);
  assert.throws(() => reconcileReliability({ ...snapshot, prs: [snapshot.prs[0], snapshot.prs[0]] }), /Duplicated PR/);
});

test('a fabricated green PR with zero successful CI jobs is not green', () => {
  const changed = { ...snapshot, prs: [{ ...snapshot.prs[0], jobsSucceeded: 0 }] };
  assert.equal(reconcileReliability(changed).rows[0].hostedCi, 'CI_NOT_GREEN');
});

test('merge status and test discovery remain independent of CI success', () => {
  const out = reconcileReliability({ ...snapshot, prs: [{ ...snapshot.prs[0], state: 'closed', mergedAt: '2026-11-08T00:00:00Z' }] });
  assert.equal(out.rows[0].state, 'MERGED');
  assert.equal(out.rows[0].delegatedTest, 'NOT_PROVEN');
  assert.equal(out.rows[0].physical, 'NOT_RUN');
});

test('CLI report remains deterministic and never advertises live acceptance', () => {
  assert.equal(reportReliability(), reportReliability());
  assert.match(reportReliability(), /K09_TEST_NOT_PROVEN/);
  assert.doesNotMatch(reportReliability(), /PHYSICAL_PASS|ISSUE_RESOLVED/);
});
