import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildBrowserEvidenceInventory, renderInventoryMarkdown } from '../../../scripts/delegated/pool-k10/browser-evidence-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(readFileSync(join(root, 'test/delegated/k10/state-scenarios.json'), 'utf8'));
const web = join(root, 'web');

test('all shipped HTML pages are inventoried; none claims a browser screenshot', () => {
  const result = buildBrowserEvidenceInventory(web, manifest);
  assert.equal(result.origin, 'READ_ONLY_OFFLINE_SOURCE_INVENTORY');
  assert.equal(result.browserEvidence, 'NOT_RUN');
  assert.equal(result.authenticatedRuntimeEvidence, 'NOT_RUN');
  const files = result.pages.map(({ file }) => file);
  assert.deepEqual(files, ['admin.html', 'connect.html', 'custom-usage-consent-preview.html', 'index.html']);
  assert.equal(result.pages.filter(({ staticSmoke }) => staticSmoke === 'PASS').length, 3);
  assert.ok(result.pages.some(({ file, staticSmoke }) => file === 'custom-usage-consent-preview.html' && staticSmoke === 'NOT_COVERED'));
  for (const item of result.pages) {
    assert.equal(item.screenshotCapture, 'NOT_RUN');
    assert.equal(item.keyboardFocus, 'NOT_RUN');
    assert.equal(item.horizontalOverflow, 'NOT_RUN');
    assert.equal(item.candidateViewports.length, 3);
    assert.ok(item.candidateViewports.every(({ screenshot }) => screenshot === 'NOT_RUN'));
  }
  assert.equal(result.pages.filter(({ auditedPage }) => auditedPage !== null).reduce((sum, page) => sum + page.scenarioNames.length, 0), 12);
});

test('new HTML page is counted as a gap, not as source PASS or browser evidence', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'nexowire-k10-inventory-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(web, temp, { recursive: true });
  writeFileSync(join(temp, 'new-example.html'), '<!doctype html><html lang="tr"><title>Future page</title></html>');
  const result = buildBrowserEvidenceInventory(temp, manifest);
  assert.equal(result.pages.length, 5);
  assert.equal(result.pages.find(({ file }) => file === 'new-example.html').staticSmoke, 'NOT_COVERED');
  assert.match(renderInventoryMarkdown(result), /Candidate screenshots lacking evidence: 15/);
});

test('broken existing source cannot be promoted to static PASS', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'nexowire-k10-inventory-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(web, temp, { recursive: true });
  writeFileSync(join(temp, 'connect.html'), readFileSync(join(temp, 'connect.html'), 'utf8').replace('./styles.css', './missing.css'));
  const result = buildBrowserEvidenceInventory(temp, manifest);
  assert.equal(result.staticStatus, 'FAIL');
  assert.equal(result.pages.find(({ file }) => file === 'connect.html').staticSmoke, 'FAIL');
  assert.equal(result.pages.find(({ file }) => file === 'connect.html').screenshotCapture, 'NOT_RUN');
});
