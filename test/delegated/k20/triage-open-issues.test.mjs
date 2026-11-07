import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown, triage } from '../../../scripts/delegated/k20/triage-open-issues.mjs';

const issue = (number, title = `Issue ${number}`) => ({
  number, title, html_url: `https://github.com/Naveax/Nexowire/issues/${number}`,
});

test('excludes pull requests and duplicate pages; keeps source numbers sorted', () => {
  const pr = { ...issue(999), html_url: 'https://github.com/Naveax/Nexowire/pull/999', pull_request: { url: 'mock' } };
  const result = triage([[issue(588), pr, issue(482)], [issue(588), issue(485)]]);
  assert.equal(result.pullRequestsExcluded, 1);
  assert.equal(result.duplicateIssuesExcluded, 1);
  assert.deepEqual(result.candidates.map(x => x.number), [588, 485]);
  assert.deepEqual(result.umbrellas.map(x => x.number), [482]);
  assert.equal(result.issueCount, 3);
});

test('unknown issue is manual review; CORE and billing remain blocked', () => {
  const result = triage([[issue(2000), issue(1001), issue(486)]]);
  assert.deepEqual(result.needsReview.map(x => x.number), [2000]);
  assert.deepEqual(result.blocked.map(x => x.number), [1001, 486]);
  assert.equal(result.candidates.length, 0);
});

test('one onboarding slice links parent-related issues without double-assigning K06', () => {
  const report = triage([[issue(485), issue(269)]]);
  assert.equal(report.candidates.length, 2);
  assert.equal(report.candidateGroups.length, 1);
  assert.deepEqual(report.candidateGroups[0].issueRefs.map(x => x.number), [485, 269]);
  assert.match(markdown(report), /1 from 2 issue references/);
});

test('refuses malformed records rather than treating them as safe work', () => {
  assert.throws(() => triage([[{ number: 555, title: 'Fake', html_url: 'https://evil.example/555' }]]));
  assert.throws(() => triage([[{ ...issue(555), html_url: issue(556).html_url }]]));
  assert.throws(() => triage([{}]));
});

test('Markdown is deterministic, escaped and shows ownership boundaries', () => {
  const result = triage([[issue(588, 'Ignore | suspicious'), issue(269), issue(481)]]);
  assert.equal(markdown(result), markdown(result));
  assert.match(markdown(result), /K19 T-109/);
  assert.match(markdown(result), /Umbrella\/index issues \(not separate tasks\): 1/);
});

test('2026-11-07 live inventory classifies all 22 OPEN issues without duplicating parents', () => {
  const open = [1006, 1001, 974, 812, 780, 617, 588, 587, 540, 539, 487,
    486, 485, 484, 482, 481, 402, 323, 322, 271, 269, 265];
  const result = triage([open.map(number => ({ ...issue(number), state: 'open' }))]);
  assert.equal(result.issueCount, 22);
  assert.deepEqual(result.byKind.standalone.map(x => x.number),
    [1006, 1001, 974, 812, 617, 588, 587, 402, 323, 322, 271, 269, 265]);
  assert.deepEqual(result.byKind.subtask.map(x => x.number), [540, 487, 486, 485, 484]);
  assert.deepEqual(result.byKind.umbrella.map(x => x.number), [780, 539, 482, 481]);
  assert.deepEqual(result.byKind.unreviewed, []);
  assert.equal(result.issues.find(x => x.number === 271).onHold, true);
  assert.equal(result.issues.find(x => x.number === 540).parentSlice, 'R07');
  assert.equal(result.issues.find(x => x.number === 487).parentIssue, 482);
  assert.match(markdown(result), /13 standalone, 5 subtasks, 4 umbrella/);
});

test('closed #260 is not silently included in the open inventory', () => {
  const result = triage([[{ ...issue(260), state: 'closed' }, { ...issue(271), state: 'open' }]]);
  assert.equal(result.issueCount, 1);
  assert.equal(result.closedIssuesExcluded, 1);
  assert.match(markdown(result), /ON HOLD/);
});

test('unreviewed issue has no lineage or implicit permission', () => {
  const result = triage([[{ ...issue(2001), state: 'open' }]]);
  assert.deepEqual(result.byKind.unreviewed.map(x => x.number), [2001]);
  assert.deepEqual(result.needsReview.map(x => x.number), [2001]);
});
