import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifyPath, classifyPr, summarizeKinds, markdown } from './pr-kind.mjs';

const pr = (number, files, filesComplete = true) => ({ number, files, filesComplete, head: 'a'.repeat(40) });

test('documentation alone is not executable code or a test', () => {
  const r = classifyPr(pr(1, ['README.md', 'docs/S3_TROUBLESHOOTING.md']));
  assert.equal(r.category, 'DOC_ONLY');
  assert.equal(r.docsOnly, true);
  assert.equal(r.executableTestChanged, false);
});
test('test README does not count as executed test', () => {
  const r = classifyPr(pr(2, ['test/delegated/k14/ACCEPTANCE.md']));
  assert.equal(r.docsOnly, true);
  assert.equal(r.executableTestChanged, false);
});
test('source with test code signals presence only, not success', () => {
  const r = classifyPr(pr(3, ['web/connect.js', 'test/delegated/k01/connect.test.mjs']));
  assert.equal(r.category, 'RUNTIME_SOURCE_PRESENT');
  assert.equal(r.productRuntimeCodeChanged, true);
  assert.equal(r.executableTestChanged, true);
  assert.match(r.acceptance, /NOT_INFERRED/);
});
test('CLI tool code differs from product runtime code', () => {
  const r = classifyPr(pr(4, ['scripts/delegated/k14/pr-overlap.mjs', 'scripts/delegated/k14/pr-overlap.test.mjs']));
  assert.equal(r.category, 'TOOLING_PRESENT');
  assert.equal(r.productRuntimeCodeChanged, false);
  assert.equal(r.executableTestChanged, true);
});
test('prototypes and fixtures never silently become product source', () => {
  assert.equal(classifyPath('docs/delegated/prototypes/onboarding.html'), 'PROTOTYPE');
  assert.equal(classifyPath('test/delegated/k02/mobile.html'), 'TEST_FIXTURE');
  assert.equal(classifyPath('test/delegated/k02/results.json'), 'TEST_FIXTURE');
});
test('incomplete file inventory or unknown extension refuses confident category', () => {
  assert.equal(classifyPr(pr(5, ['README.md'], false)).category, 'UNVERIFIED_FILE_SCOPE');
  assert.equal(classifyPr(pr(6, ['mystery.bin'])).category, 'UNVERIFIED_FILE_SCOPE');
  assert.equal(classifyPr(pr(7, [])).category, 'UNVERIFIED_FILE_SCOPE');
});
test('dated real-path snapshot yields stable 23 classifications', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/pr-1010-1032-rolling.json', import.meta.url), 'utf8'));
  const r = summarizeKinds(fixture);
  assert.equal(r.sourcePrCount, 23);
  assert.ok(r.prs.some(x => x.docsOnly));
  assert.ok(r.prs.some(x => x.productRuntimeCodeChanged));
  assert.ok(r.prs.some(x => x.executableTestChanged));
  assert.match(markdown(r), /does \*\*not\*\* mean/);
});
