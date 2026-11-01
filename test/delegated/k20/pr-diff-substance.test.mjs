import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPrFiles } from '../../../scripts/delegated/k20/pr-diff-substance.mjs';

const headSha = 'a'.repeat(40);
const obj = files => ({ headSha, filesComplete: true, files });

test('flags a PR touching only team reports, not a product implementation', () => {
  assert.equal(classifyPrFiles(obj(['ekip/durum/K20.md', 'ekip/PANO.md'])).kind, 'TEAM_REPORT_ONLY');
});

test('documents, tests and code remain distinct, not mislabeled as empty', () => {
  assert.equal(classifyPrFiles(obj(['docs/README.md'])).kind, 'DOCS_ONLY');
  assert.equal(classifyPrFiles(obj(['test/x.test.ts'])).kind, 'TEST_ONLY');
  assert.equal(classifyPrFiles(obj(['src/agent.ts', 'docs/a.md'])).kind, 'CODE_OR_MIXED');
});

test('missing pagination proof or an empty diff does not imply product progress', () => {
  assert.equal(classifyPrFiles({ headSha, files: ['ekip/PANO.md'] }).kind, 'UNKNOWN');
  assert.equal(classifyPrFiles(obj([])).kind, 'EMPTY_DIFF');
});

test('malformed paths and absent exact SHA fail closed', () => {
  assert.throws(() => classifyPrFiles({ headSha: 'abc', filesComplete: true, files: [] }));
  assert.throws(() => classifyPrFiles(obj(['../secrets.txt'])));
});
