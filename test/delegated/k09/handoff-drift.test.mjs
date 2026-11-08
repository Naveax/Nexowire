import assert from 'node:assert/strict';
import test from 'node:test';
import { observations, reconcileHandoff, reportHandoff } from './handoff-drift.mjs';

test('issue #481: two changed states, six unchanged issues, and one updated PR HEAD', () => {
  const result = reconcileHandoff(observations);
  assert.equal(result.length, 8);
  assert.deepEqual(result.filter((row) => row.drift === 'STALE_HANDOFF').map((row) => row.key),
    ['pull_request:480', 'issue:260']);
  assert.equal(result.find((row) => row.key === 'pull_request:480').now, 'closed_unmerged');
  assert.equal(result.find((row) => row.key === 'pull_request:480').ci, 'OLD_HEAD_CI_NOT_TRANSFERABLE');
});

test('PR 7/7 CI from the old SHA never becomes CI acceptance on changed HEAD', () => {
  const result = reconcileHandoff([observations[0]])[0];
  assert.equal(observations[0].previousCi, 'success');
  assert.notEqual(observations[0].previousHead, observations[0].currentHead);
  assert.equal(result.ci, 'OLD_HEAD_CI_NOT_TRANSFERABLE');
  assert.equal(result.completion, 'NOT_VERIFIED');
});

test('closed without merged_at is not merged; real merged_at changes classification only', () => {
  const [closed] = reconcileHandoff([observations[0]]);
  assert.equal(closed.now, 'closed_unmerged');
  const [merged] = reconcileHandoff([{ ...observations[0], mergedAt: '2026-11-07T00:00:00Z' }]);
  assert.equal(merged.now, 'merged');
  assert.equal(merged.completion, 'NOT_VERIFIED');
});

test('#271 remains owner HOLD even though the issue is open', () => {
  const hold = reconcileHandoff([observations.find((row) => row.number === 271)])[0];
  assert.equal(hold.now, 'open');
  assert.equal(hold.restriction, 'OWNER_HOLD_DO_NOT_RESUME');
  assert.equal(hold.completion, 'NOT_VERIFIED');
});

test('fail closed on duplicate identity, invalid issue state or absent PR merge status', () => {
  assert.throws(() => reconcileHandoff([observations[1], observations[1]]), /Duplicate handoff identity/);
  assert.throws(() => reconcileHandoff([{ ...observations[1], currentState: 'succeeded' }]), /Invalid issue state/);
  const { mergedAt: _unused, ...missing } = observations[0];
  assert.throws(() => reconcileHandoff([missing]), /Invalid pull request state/);
});

test('report is deterministic and cannot show an accepted live result', () => {
  assert.equal(reportHandoff(), reportHandoff());
  assert.equal(reportHandoff().split('\n').length, 8);
  assert.doesNotMatch(reportHandoff(), /DEPLOYED|ACCEPTED|CI_PASS/);
});
