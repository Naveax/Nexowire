import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileOpenIssues, reportIssueTransitions, source } from './issue-state-transition.mjs';

test('#539 T-583: 22 now-open issue identities, count delta zero, historical identities unverified', () => {
  const result = reconcileOpenIssues();
  assert.equal(result.earlierCount, 22);
  assert.equal(result.currentCount, 22);
  assert.equal(result.countDelta, 0);
  assert.equal(result.identityDelta, 'UNVERIFIED_PREVIOUS_FULL_SET');
});

test('issue #487 close/reopen is retained even when final state and open count match', () => {
  const result = reconcileOpenIssues();
  assert.deepEqual(result.touched[0], { number: 487, finalState: 'open', stateChanges: 2, transientClosed: true });
  assert.deepEqual(result.touched[1], { number: 1006, finalState: 'open', stateChanges: 0, transientClosed: false });
});

test('missing reopened event or wrong order cannot silently pass', () => {
  const row = source.modifiedSinceNov7[0];
  assert.throws(() => reconcileOpenIssues({ ...source, modifiedSinceNov7: [{ ...row, events: row.events.slice(0, 1) }, source.modifiedSinceNov7[1]] }), /Unreconciled final state/);
  assert.throws(() => reconcileOpenIssues({ ...source, modifiedSinceNov7: [{ ...row, events: [...row.events].reverse() }, source.modifiedSinceNov7[1]] }), /Invalid state event|Non-alternating/);
});

test('duplicate issue, mismatched count or missing final open identity fail closed', () => {
  assert.throws(() => reconcileOpenIssues({ ...source, currentOpenIssues: [...source.currentOpenIssues.slice(1), source.currentOpenIssues[1]] }), /duplicated/);
  assert.throws(() => reconcileOpenIssues({ ...source, updatedQueryCount: 1 }), /pagination/);
  assert.throws(() => reconcileOpenIssues({ ...source, currentOpenIssues: source.currentOpenIssues.map((n) => n === 487 ? 490 : n) }), /does not agree/);
});

test('source-only timeline does not assert issue or device completion', () => {
  assert.match(reportIssueTransitions(), /TRANSIENT_CLOSE=true/);
  assert.match(reportIssueTransitions(), /ACCEPTANCE=NOT_VERIFIED/);
  assert.doesNotMatch(reportIssueTransitions(), /DEPLOYED|ISSUE_FIXED/);
});
