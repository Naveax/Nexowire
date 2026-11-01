import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderCatalog } from '../../../scripts/delegated/k20/regression-catalog.mjs';

const sample = { id: 'NC-100', description: 'Connect UX',
  pr: 'https://github.com/Naveax/Nexowire/pull/1011', status: 'DRAFT' };

test('catalog marks open PRs Draft and keeps acceptance NOT_RUN', () => {
  const scenarios = JSON.parse(readFileSync('docs/delegated/maintenance-k20/scenarios.json', 'utf8'));
  assert.equal(scenarios.length, 5);
  const text = renderCatalog(scenarios);
  assert.match(text, /NC-001/);
  assert.equal((text.match(/\| DRAFT \|/g) || []).length, 5);
  assert.doesNotMatch(text, /MERGED_VERIFIED/); // No merge claim on rows.
});

test('rejects duplicate scenario IDs and unverified merge assertions', () => {
  assert.throws(() => renderCatalog([sample, sample]));
  assert.throws(() => renderCatalog([{ ...sample, status: 'MERGED_VERIFIED' }]));
  assert.throws(() => renderCatalog([{ ...sample, mergeSha: 'a'.repeat(40) }]));
});

test('exact SHA plus evidence is required for a verified merge record', () => {
  const text = renderCatalog([{ ...sample, status: 'MERGED_VERIFIED', mergeSha: 'a'.repeat(40), evidence: 'node test/x: PASS' }]);
  assert.match(text, /MERGED_VERIFIED/);
});
