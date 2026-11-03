import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderRiskOverlay } from '../../../scripts/delegated/k20/scenario-risk-audit.mjs';

const source = JSON.parse(readFileSync('docs/delegated/maintenance-k20/scenario-risk-overlay.json', 'utf8'));

test('five original scenario IDs have unique negative/acceptance mapping', () => {
  assert.deepEqual(source.map(x => x.id), ['NC-001','NC-002','NC-003','NC-004','NC-005']);
  assert.equal((renderRiskOverlay(source).match(/\| NOT_RUN \|/g) || []).length, 5);
});

test('missing negative evidence, duplicate IDs and false acceptance are rejected', () => {
  assert.throws(() => renderRiskOverlay([...source, source[0]]));
  assert.throws(() => renderRiskOverlay([{ ...source[0], negativeCase: '' }]));
  assert.throws(() => renderRiskOverlay([{ ...source[0], acceptance: 'PASS' }]));
});
