import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { analyzeSnapshot, mapClosedTransfers, compareOpenSources, markdown } from './issue1006-audit.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const file = (path, blob = A) => ({ path, blob });
const owner = { number: 12, mergeCommit: C, files: [file('a.md'), file('b.md', B)] };

test('exact SHA of every file is required for an exact source transfer', () => {
  const result = mapClosedTransfers([{ number: 1, head: B, files: [file('a.md')] }], [owner]);
  assert.equal(result[0].status, 'EXACT_BLOB_TRANSFER');
  assert.equal(result[0].owner, 12);
});
test('matching paths with differing blobs are not exact integration', () => {
  const result = mapClosedTransfers([{ number: 1, files: [file('a.md', B), file('b.md', B)] }], [owner]);
  assert.equal(result[0].status, 'PATH_TRANSFER_CONTENT_ADAPTED');
  assert.equal(result[0].exact, 1);
});
test('source absent in main and owner is explicitly unresolved', () => {
  const result = mapClosedTransfers([{ number: 6, files: [file('gone.md')] }], [owner], { 6: ['gone.md'] });
  assert.equal(result[0].status, 'NO_CURRENT_MAIN_EVIDENCE');
  assert.equal(result[0].owner, undefined);
});
test('same-path overlap reports different blobs without claiming merge conflict', () => {
  const result = compareOpenSources([{ number: 1, head: A, files: [file('a.md', B), file('unique.md')] }],
    { number: 50, head: B, files: [file('a.md', A)] });
  assert.equal(result[0].pathOverlap, 1);
  assert.equal(result[0].sameBlob, 0);
  assert.deepEqual(result[0].independent, ['unique.md']);
});
test('bad blob or unknown owner merge SHA does not produce fake transfer', () => {
  assert.throws(() => mapClosedTransfers([{ number: 1, files: [file('x.md', 'short')] }], [owner]), /Incomplete closed/);
  assert.throws(() => mapClosedTransfers([{ number: 1, files: [file('x.md')] }], [{ ...owner, mergeCommit: 'unknown' }]), /Unverified merged owner/);
});
test('dated 30-source historical snapshot matches exact/partial/gap and 6 open', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/issue1006-20261107.json', import.meta.url), 'utf8'));
  const r = analyzeSnapshot(fixture);
  assert.equal(r.transfers.length, 30);
  assert.equal(r.transferCounts.EXACT_BLOB_TRANSFER, 28);
  assert.equal(r.transferCounts.PATH_TRANSFER_CONTENT_ADAPTED, 1);
  assert.equal(r.transferCounts.NO_CURRENT_MAIN_EVIDENCE, 1);
  assert.equal(r.open.length, 6);
  assert.equal(r.upstreamDelta.totalPaths, 201);
  assert.equal(r.upstreamDelta.owner1096SamePaths.length, 5);
  assert.equal(r.ci.sevenOfSeven, true);
  assert.equal(r.mergeReady, false);
  assert.match(markdown(r), /#1026.*NO_CURRENT_MAIN_EVIDENCE/);
});
test('CI 7/7 is SHA-bound and never automatically merge-ready', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/issue1006-20261107.json', import.meta.url), 'utf8'));
  fixture.ci.owner1068.sha = A;
  const r = analyzeSnapshot(fixture);
  assert.equal(r.ci.sevenOfSeven, false);
  assert.equal(r.mergeReady, false);
});
