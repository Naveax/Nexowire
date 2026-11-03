import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectDeviceCardIds } from '../../../scripts/delegated/k05/dynamic-id-contract.mjs';
import { auditHtml } from '../../../scripts/delegated/k05/audit-html.mjs';

const js = readFileSync(new URL('../../../web/app.js', import.meta.url), 'utf8');
const page = (html) => `<html lang="tr"><head><meta name="viewport" content="width=device-width"></head><body>${html}</body></html>`;
const fragment = (index) => `<button aria-controls="pc-settings-${index}">Ayarlar</button>` +
  `<div id="pc-settings-${index}"></div>`;

test('T-161: device card uses no repeated template ID and binds controls to indexed panel ID', () => {
  assert.deepEqual(inspectDeviceCardIds(js), []);
});

test('T-161: source mutation for a static repeated ID is rejected', () => {
  const mutated = js.replace("'<div class=\"device-header\">'", "'<div id=\"same-for-all-devices\" class=\"device-header\">'");
  assert.ok(inspectDeviceCardIds(mutated).includes('repeated-static-id-in-card'));
});

test('T-161: removing device index or aria-controls binding fails closed', () => {
  assert.ok(inspectDeviceCardIds(js.replace('devices.indexOf(device)', '0')).includes('missing-indexed-panel-id'));
  assert.ok(inspectDeviceCardIds(js.replace("pcButton.setAttribute('aria-controls', pcPanel.id)",
    "pcButton.setAttribute('title', 'Ayarlar')")).includes('missing-panel-id-reference'));
});

test('T-161: two different indices preserve unique IDs; collision fixture is detected', () => {
  assert.ok(!auditHtml(page(fragment(0) + fragment(1))).findings
    .some(({ rule }) => rule === 'duplicate-id' || rule === 'broken-reference'));
  assert.ok(auditHtml(page(fragment(0) + fragment(0))).findings
    .some(({ rule }) => rule === 'duplicate-id'));
});
