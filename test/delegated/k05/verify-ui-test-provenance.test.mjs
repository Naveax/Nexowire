import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUiProvenance, DEFAULT_SUITES } from '../../../scripts/delegated/k05/verify-ui-test-provenance.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TREE_A = '1'.repeat(40);
const TREE_B = '2'.repeat(40);
const DIGEST_A = 'c'.repeat(64);
const DIGEST_B = 'd'.repeat(64);
const good = () => ({
  expectedMainSha: SHA_A, currentMainSha: SHA_A,
  checkoutWebTree: TREE_A, mainWebTree: TREE_A,
  webStatusBefore: '', webStatusAfter: '',
  sourceHashBefore: DIGEST_A, sourceHashAfter: DIGEST_A,
});

test('T-382: two UI suites run from one checkout, source tree and source digest', () => {
  assert.deepEqual(DEFAULT_SUITES, [
    'test/delegated/k05/audit-html.test.mjs',
    'test/delegated/k05/dynamic-id-contract.test.mjs',
  ]);
  assert.deepEqual(validateUiProvenance(good()), []);
});

test('T-382: old main SHA mixed with current main cannot become PASS', () => {
  assert.deepEqual(validateUiProvenance({ ...good(), expectedMainSha: SHA_B }), ['stale-main-ref']);
  assert.ok(validateUiProvenance({ ...good(), expectedMainSha: 'main' }).includes('invalid-main-sha'));
});

test('T-382: owner PR web source mixed into main-only UI run fails', () => {
  assert.deepEqual(validateUiProvenance({ ...good(), checkoutWebTree: TREE_B }), ['mixed-web-source-tree']);
  assert.ok(validateUiProvenance({ ...good(), mainWebTree: 'NOT_RUN' }).includes('invalid-web-tree'));
});

test('T-382: uncommitted web changes before/after tests invalidate run', () => {
  assert.deepEqual(validateUiProvenance({ ...good(), webStatusBefore: ' M web/connect.html' }), ['dirty-web-source-before']);
  assert.deepEqual(validateUiProvenance({ ...good(), webStatusAfter: '?? web/extra.html' }), ['dirty-web-source-after']);
});

test('T-382: source changed during tests is not accepted as single snapshot', () => {
  assert.deepEqual(validateUiProvenance({ ...good(), sourceHashAfter: DIGEST_B }), ['changed-web-source-during-tests']);
  assert.ok(validateUiProvenance({ ...good(), sourceHashBefore: 'UNKNOWN' }).includes('invalid-source-hash'));
});

test('T-382: simultaneous dirty, mixed source and stale ref preserve all failure reasons', () => {
  assert.deepEqual(validateUiProvenance({ ...good(), currentMainSha: SHA_B, mainWebTree: TREE_B,
    webStatusBefore: ' M web/admin.html', sourceHashAfter: DIGEST_B }), [
    'stale-main-ref', 'mixed-web-source-tree', 'dirty-web-source-before', 'changed-web-source-during-tests',
  ]);
});
