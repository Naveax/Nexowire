import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { analyzePairs, createOverlapReport, markdown, titleSimilarity } from './pr-overlap.mjs';

const p = (number, title, ...files) => ({ number, title, files, filesComplete: true });

test('exact same path wins even with unrelated titles', () => {
  const pairs = analyzePairs([p(1, 'alpha', 'web/app.js'), p(2, 'beta', 'web/app.js')]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].samePaths, ['web/app.js']);
});
test('same basename in different directories is not a path conflict', () => {
  assert.equal(analyzePairs([p(1, 'alpha', 'x/file.ts'), p(2, 'beta', 'y/file.ts')]).length, 0);
});
test('CSS/HTML dependency surfaces candidate, not proven path collision', () => {
  const result = createOverlapReport({ prs: [p(10, 'css', 'web/styles.css'), p(11, 'screen', 'web/connect.html')] });
  assert.equal(result.samePathPairs.length, 0);
  assert.equal(result.semanticReviewCandidates.length, 1);
  assert.deepEqual(result.semanticReviewCandidates[0].sharedTopics, ['CSS_SCREEN_CONSUMER']);
  assert.match(markdown(result), /unverified/);
});
test('related S5 documents trigger review candidate without duplicate claim', () => {
  const result = createOverlapReport({ prs: [p(997, 'S5 cost', 'scripts/delegated/s5-cost-matrix.ts'),
    p(1029, 'S5 metrics', 'scripts/report-s5-cost-matrix.ts')] });
  assert.equal(result.semanticReviewCandidates.length, 1);
  assert.deepEqual(result.semanticReviewCandidates[0].sharedTopics, ['S5_COST_OR_QUOTA']);
  assert.equal(result.semanticReviewCandidates[0].possibleDuplicate, false);
});
test('near-identical titles require more than one shared content word', () => {
  assert.equal(titleSimilarity('fix(ui): improve connection error handling', 'docs: error reference'), 0);
  assert.ok(titleSimilarity('validate upstream pull request status', 'validate upstream pull request state') >= 0.6);
});
test('unknown or truncated file list cannot certify no conflicts', () => {
  const result = createOverlapReport({ prs: [{ ...p(1, 'alpha', 'a.ts'), filesComplete: false }, p(2, 'beta', 'b.ts')] });
  assert.equal(result.filesAllComplete, false);
  assert.match(markdown(result), /inconclusive/);
});
test('malformed report fails without inventing pair evidence', () => {
  assert.throws(() => createOverlapReport({}), /Expected structured/);
});
test('dated 23-PR inventory has no same path, but flags 14 semantic checks', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/pr-1010-1032-rolling.json', import.meta.url), 'utf8'));
  const report = createOverlapReport(fixture);
  assert.equal(report.sourcePrCount, 23);
  assert.equal(report.samePathPairs.length, 0);
  assert.equal(report.semanticReviewCandidates.length, 14);
});
