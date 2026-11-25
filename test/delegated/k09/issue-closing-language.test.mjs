import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUnsafeClosingRefs, reviewPullRequestText, suggestedSafeWording } from './issue-closing-language.mjs';

test('#1006: a negation does not neutralize a GitHub closing-keyword risk', () => {
  const [risk] = detectUnsafeClosingRefs('We cannot close #487 until owner acceptance.');
  assert.equal(risk.issue, 487);
  assert.equal(risk.phrase.toLowerCase(), 'close #487');
  assert.equal(risk.reason, 'UNINTENDED_ISSUE_CLOSING_RISK');
});

test('several documented keyword inflections are flagged independently', () => {
  const risks = detectUnsafeClosingRefs('Fixes #487; resolved #487. Closes: #487.');
  assert.equal(risks.length, 3);
  assert.deepEqual(risks.map((r) => r.issue), [487, 487, 487]);
});

test('qualified same-repository references are not missed when keyword is negated', () => {
  const result = detectUnsafeClosingRefs('We cannot fix Naveax/Nexowire#487 yet. Resolves: naveax/nexowire#487');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((risk) => risk.issue), [487, 487]);
});

test('qualified references to a different repository do not implicate Nexowire issue 487', () => {
  assert.deepEqual(detectUnsafeClosingRefs('Fixes unrelated/project#487.'), []);
  assert.equal(detectUnsafeClosingRefs('Fixes unrelated/project#487.', [487], 'unrelated/project').length, 1);
});

test('neutral reference leaves issue open and returns no false acceptance', () => {
  assert.deepEqual(detectUnsafeClosingRefs(suggestedSafeWording), []);
  assert.deepEqual(detectUnsafeClosingRefs('Investigate issue #487 and update evidence.'), []);
});

test('unrelated issue numbers are not automatically flagged as this issue', () => {
  assert.deepEqual(detectUnsafeClosingRefs('Fixes #588.'), []);
  assert.equal(detectUnsafeClosingRefs('Fixes #588.', [588]).length, 1);
});

test('PR title, body and commit messages all receive the same preflight', () => {
  const result = reviewPullRequestText({ title: 'Fix #487 safely',
    body: 'This does not resolve #487.', commits: ['closed #487'] });
  assert.deepEqual(result.map((r) => r.location), ['title', 'body', 'commit:1']);
});

test('malformed input and zero issue numbers fail closed', () => {
  assert.throws(() => detectUnsafeClosingRefs(null), /Invalid text/);
  assert.throws(() => detectUnsafeClosingRefs('fix #487', [0]), /Invalid text/);
  assert.throws(() => detectUnsafeClosingRefs('fix #487', [487], '../wrong'), /Invalid text/);
  assert.throws(() => reviewPullRequestText({ title: '', body: '', commits: [42] }), /Commit messages/);
});
