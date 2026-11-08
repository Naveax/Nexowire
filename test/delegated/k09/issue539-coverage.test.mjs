import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditCoverage, CANONICAL_PATH, extractCanonicalItems, gitBlobSha, LANES, PINNED_BLOB, renderCoverage } from './issue539-coverage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const text = readFileSync(resolve(root, CANONICAL_PATH), 'utf8');

test('canonical issue #539 has exactly 22 uniquely mapped reliability items', () => {
  const { errors, items } = auditCoverage(text);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 22);
  assert.equal(new Set(items.map((x) => x.id)).size, 22);
  assert.equal(Object.keys(LANES).length, 22);
  assert.equal(gitBlobSha(text), PINNED_BLOB);
});

test('each work item has a concrete exit evidence field and a defined ownership lane', () => {
  for (const item of extractCanonicalItems(text)) {
    assert.ok(item.exit.length >= 10, item.id);
    assert.match(LANES[item.id], /^(protected|non-core) /);
  }
});

test('duplicate and missing IDs fail closed without rewriting the roadmap', () => {
  const duplicate = text.replace('| R02 |', '| R01 |');
  const result = auditCoverage(duplicate, { requirePinned: false });
  assert.ok(result.errors.some((e) => e.includes('R01 must appear exactly once')));
  assert.ok(result.errors.some((e) => e.includes('R02 must appear exactly once')));
});

test('a different source blob cannot silently reuse the verified main snapshot', () => {
  const stale = `${text}\nnew unreviewed line`;
  assert.match(auditCoverage(stale).errors.join('\n'), /Canonical source blob changed/);
});

test('report shows every item as NOT_VERIFIED and never closes an issue', () => {
  const report = renderCoverage(text, { mainSha: '4e7db16f4233048a956664bef6b607781eb63fb7', date: '2026-11-07' });
  assert.equal((report.match(/\| R\d{2} \|/g) ?? []).length, 22);
  assert.equal((report.match(/\| NOT_VERIFIED \|/g) ?? []).length, 22);
  assert.match(report, /not proof of any fix/i);
});
