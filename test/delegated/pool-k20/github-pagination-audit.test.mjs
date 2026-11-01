import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPagination } from '../../../scripts/delegated/pool-k20/github-pagination-audit.mjs';

const link = next => `<https://api.github.com/repos/Naveax/Nexowire/issues?per_page=2&page=${next}>; rel="next"`;
const page = (n, items, more = null) => ({ page: n, perPage: 2, httpStatus: 200, items: items.map(number => ({ number })), link: more });

test('two consecutive pages with a partial final page are consistent but NOT live verified', () => {
  const r = auditPagination({ pages: [page(1, [1, 2], link(2)), page(2, [3])] });
  assert.equal(r.status, 'SNAPSHOT_CONSISTENT_NOT_LIVE_VERIFIED');
  assert.equal(r.uniqueItems, 3);
  assert.equal(r.liveVerified, false);
});

test('full final page with absent Link cannot prove collection complete', () => {
  assert.equal(auditPagination({ pages: [page(1, [1,2])] }).status, 'UNKNOWN');
  assert.equal(auditPagination({ pages: [page(1, [1,2], link(2))] }).status, 'GAP');
});

test('out-of-order, repeated objects, and missing next page fail closed', () => {
  assert.equal(auditPagination({ pages: [page(2, [3])] }).status, 'GAP');
  assert.equal(auditPagination({ pages: [page(1, [1,2], link(2)), page(2, [2])] }).status, 'GAP');
  assert.equal(auditPagination({ pages: [page(1, [1,2], link(3)), page(2, [3])] }).status, 'GAP');
});

test('rate limit, source truncation and declared total mismatch are not PASS', () => {
  assert.equal(auditPagination({ pages: [{ ...page(1, []), httpStatus: 403 }] }).status, 'BLOCKED');
  assert.equal(auditPagination({ pages: [page(1, [1])], incompleteResults: true }).status, 'TRUNCATED');
  assert.equal(auditPagination({ pages: [page(1, [1])], totalCount: 4 }).status, 'TRUNCATED');
});

test('malformed or non-GitHub pagination links fail to UNKNOWN', () => {
  const r = auditPagination({ pages: [page(1, [1,2], '<https://evil.example/items?page=2>; rel="next"')] });
  assert.equal(r.status, 'UNKNOWN');
});
