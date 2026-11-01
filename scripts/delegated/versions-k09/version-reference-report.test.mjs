import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, inspectFile, parseVersion } from './version-reference-report.mjs';

test('active older installer guidance is flagged as a candidate, not automatically a defect', () => {
  assert.deepEqual(inspectFile('guide.md', 'Kurucu yayımlanmış v1.0.7 uygulamasını kullanır.', 'v1.0.8'), [
    { path: 'guide.md', line: 1, version: 'v1.0.7', classification: 'POTENTIAL_STALE_GUIDANCE' },
  ]);
});

test('archival rollback reference is not treated as current install advice', () => {
  const text = 'Önceki resmî yayın:\nhttps://example.invalid/releases/tag/v1.0.7\nEski kurucu v1.0.7 arşivdir.';
  const result = inspectFile('history.md', text, 'v1.0.8');
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.classification === 'HISTORICAL_CONTEXT'));
});

test('same-release references are excluded; future refs require separate review', () => {
  assert.deepEqual(inspectFile('readme.md', 'Release v1.0.8', 'v1.0.8'), []);
  assert.equal(inspectFile('readme.md', 'Release v1.0.9', 'v1.0.8')[0].classification, 'FUTURE_VERSION_REVIEW');
});

test('invalid baseline is rejected rather than producing a misleading report', () => {
  for (const value of ['latest', 'v1.0', '1.0.8-rc', 'v1.0.8;curl', 'v999999999999999999999.0.0']) {
    assert.throws(() => parseVersion(value), TypeError);
  }
  assert.throws(() => buildReport({}, 'v1.0.8', 'someday'), TypeError);
});

test('deterministic ordered offline report does not mutate supplied content', () => {
  const files = Object.freeze({ 'z.md': 'Newest v1.0.8', 'a.md': 'Download v1.0.7' });
  const before = JSON.stringify(files);
  const report = buildReport(files, 'v1.0.8', '2026-11-01');
  assert.deepEqual(report.scanned, ['a.md', 'z.md']);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].classification, 'POTENTIAL_STALE_GUIDANCE');
  assert.match(report.baseline_provenance, /NOT independently checked/);
  assert.equal(JSON.stringify(files), before);
});
