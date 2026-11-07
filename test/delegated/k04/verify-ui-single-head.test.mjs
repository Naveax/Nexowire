import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTestSummary, UI_SUITES, validateEvidence } from './verify-ui-single-head.mjs';

const head = 'a'.repeat(40);
const complete = () => ({ before: head, after: head, cleanBefore: true, cleanAfter: true,
  records: UI_SUITES.map((suite) => ({ id: suite.id, path: suite.file, head, afterHead: head,
    exitCode: 0, summary: { tests: suite.count, pass: suite.count, fail: 0, skipped: 0, todo: 0 } })) });

test('T-382: Node spec and TAP summary counts are parsed without guessing', () => {
  assert.deepEqual(parseTestSummary('ℹ tests 13\nℹ pass 13\nℹ fail 0\nℹ skipped 0\nℹ todo 0'),
    { tests: 13, pass: 13, fail: 0, skipped: 0, todo: 0 });
  assert.deepEqual(parseTestSummary('# tests 17\n# pass 17\n# fail 0\n# skipped 0\n# todo 0'),
    { tests: 17, pass: 17, fail: 0, skipped: 0, todo: 0 });
  assert.deepEqual(parseTestSummary('All tests succeeded'), {});
});

test('T-382: four suite results on one exact commit can prove 56 source checks', () => {
  const result = validateEvidence(complete());
  assert.equal(result.ok, true);
  assert.equal(result.expectedTests, 56);
});

test('T-382: one stale K04 SHA or a head change prevents PASS', () => {
  const evidence = complete();
  evidence.records[3].head = 'b'.repeat(40);
  evidence.after = 'b'.repeat(40);
  const result = validateEvidence(evidence);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('K04:different-head'));
  assert.ok(result.issues.includes('head-changed-during-tests'));
});

test('T-382: skipped, TODO or fewer tests are not silently counted as PASS', () => {
  const evidence = complete();
  evidence.records[0].summary.skipped = 1;
  evidence.records[1].summary.tests = 16;
  evidence.records[2].summary.todo = 1;
  const result = validateEvidence(evidence);
  assert.equal(result.ok, false);
  for (const id of ['K01', 'K02', 'K03']) assert.ok(result.issues.includes(`${id}:incomplete-tap`));
});

test('T-382: missing/duplicate suite and nonzero exit are explicit failures', () => {
  const evidence = complete();
  evidence.records = [evidence.records[0], evidence.records[0], evidence.records[2], evidence.records[3]];
  evidence.records[2].exitCode = 1;
  const result = validateEvidence(evidence);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('K01:missing-or-duplicate'));
  assert.ok(result.issues.includes('K02:missing-or-duplicate'));
  assert.ok(result.issues.includes('K03:failed-or-not-run'));
});

test('T-382: dirty checkout or changed test file path cannot prove exact source', () => {
  const evidence = complete();
  evidence.cleanAfter = false;
  evidence.records[0].path = 'test/delegated/old.test.ts';
  const result = validateEvidence(evidence);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('dirty-worktree'));
  assert.ok(result.issues.includes('K01:unexpected-path'));
});
