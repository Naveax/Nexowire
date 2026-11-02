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
  assert.throws(() => triage([{}]));
});

test('Markdown is deterministic, escaped and shows ownership boundaries', () => {
  const result = triage([[issue(588, 'Ignore | suspicious'), issue(269), issue(481)]]);
  assert.equal(markdown(result), markdown(result));
  assert.match(markdown(result), /K19 T-109/);
  assert.match(markdown(result), /Umbrella\/index issues \(not separate tasks\): 1/);
});
