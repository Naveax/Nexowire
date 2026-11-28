import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOwnerWeb,
  inspectConnectKeyboard,
  inspectDeviceActionNames,
  inspectListAnnouncements,
  inspectReadableSource,
  readWebSnapshot,
} from '../../../scripts/delegated/k05/audit-owner-web.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const web = readWebSnapshot(root);
const rules = (items) => new Set(items);

test('T-279: current main is audited as source evidence; no physical PASS is implied', () => {
  const report = auditOwnerWeb(web);
  assert.deepEqual(report.issues, ['#539/R11', '#485']);
  assert.equal(report.verified, 'SOURCE_ONLY');
  for (const value of ['browser', 'keyboard', 'screenReader', 'mobileLayout']) {
    assert.equal(report[value], 'NOT_RUN', value);
  }
  assert.ok(report.findings.every(({ owner, rule }) => /^K0[1-4]$/.test(owner) && rule));
  assert.ok(report.findings.some(({ owner, rule }) => owner === 'K01' && rule === 'nested-live-region'));
});

test('T-280: real connect source includes semantic tabs and all four keyboard navigation keys', () => {
  const issues = inspectConnectKeyboard(web.connectHtml, web.connectJs);
  assert.ok(!issues.includes('os-tabs-not-semantic'));
  assert.ok(!issues.includes('os-tabs-keyboard-contract-missing'));
  // These checks only prove source wiring, never actual keyboard execution.
});

test('T-280: missing tabs, keys or focus paths are individually reported', () => {
  const html = '<div role="tablist"><button role="tab">Windows</button><button role="tab">Mac</button><button role="tab">Linux</button></div>';
  const js = "tab.addEventListener('keydown', () => { ArrowRight; ArrowLeft; Home; End; tab.focus(); }); $('error-panel').focus(); approve.focus();";
  assert.deepEqual(inspectConnectKeyboard(html, js), []);
  assert.ok(rules(inspectConnectKeyboard(html.replace('tablist', 'group'), js)).has('os-tabs-not-semantic'));
  assert.ok(rules(inspectConnectKeyboard(html, js.replace('ArrowLeft', 'Left'))).has('os-tabs-keyboard-contract-missing'));
  assert.ok(rules(inspectConnectKeyboard(html, js.replace("$('error-panel').focus()", ''))).has('connect-error-focus-not-proven'));
});

const duplicateActionJs = `
const deviceLabel = device.name + ' · cihaz ' + (devices.indexOf(device) + 1);
row.querySelector('.core-shortcut').setAttribute('aria-label', deviceLabel + ' · CORE');
row.querySelector('.bridge-quick-toggle').setAttribute('aria-label', deviceLabel + ' · Bridge');
const folderSelect = row.querySelector('.folder-assign');
folderSelect.setAttribute('aria-label', deviceLabel + ' · klasör');
const pcButton = row.querySelector('.pc-settings-button');
pcButton.setAttribute('aria-label', deviceLabel + ' · ayarlar');`;

test('T-281: same-name devices have ordinal context for all per-device actions', () => {
  assert.deepEqual(inspectDeviceActionNames(duplicateActionJs), []);
  const names = ['Depo', 'Depo'];
  const labels = names.map((name, index) => name + ' · cihaz ' + (index + 1));
  assert.equal(new Set(labels).size, names.length);
  assert.ok(inspectDeviceActionNames(duplicateActionJs.replace('devices.indexOf(device)', '0'))
    .includes('nonunique-device-context'));
});

test('T-281: changing accessible names to shared generic labels is detected', () => {
  const broken = duplicateActionJs.replace("deviceLabel + ' · ayarlar'", "'PC ayarları'")
    .replace("deviceLabel + ' · CORE'", "'CORE'");
  const issues = rules(inspectDeviceActionNames(broken));
  assert.ok(issues.has('unscoped-action:.pc-settings-button'));
  assert.ok(issues.has('unscoped-action:.core-shortcut'));
});

test('T-282: list status needs live semantics, safe update and loading transition', () => {
  const html = '<p id="device-list-status" role="status" aria-live="polite" aria-atomic="true"></p>';
  const js = "$('device-list-status').textContent = message; root.setAttribute('aria-busy', String(loading)); root.setAttribute('aria-busy', 'false');";
  assert.deepEqual(inspectListAnnouncements(html, js), []);
  assert.ok(rules(inspectListAnnouncements(html.replace('role="status"', ''), js)).has('missing-device-list-live-status'));
  assert.ok(rules(inspectListAnnouncements(html, js.replace('.textContent', '.innerHTML'))).has('unbound-device-list-status'));
  assert.ok(rules(inspectListAnnouncements(html, js.replace("root.setAttribute('aria-busy', 'false')", '')))
    .has('unverified-list-busy-transition'));
});

test('T-282: actual error panels are evaluated for live announcements and text sink', () => {
  const report = auditOwnerWeb(web);
  assert.ok(report.findings.some(({ owner, rule }) => owner === 'K04' && rule === 'silent-error-panel'));
  assert.ok(!report.findings.some(({ rule }) => rule === 'unsafe-error-sink'));
  // Keep these assertions tied to main's source; no claim about owner PR or NVDA.
});

test('T-283: responsive source contract detects missing long-content wrapping and breakpoint', () => {
  const css = `.device-name { overflow-wrap: anywhere; }
    .error-panel { overflow-wrap: anywhere; }
    @media (max-width:620px) { .device-name { max-width: 100%; } }`;
  assert.deepEqual(inspectReadableSource(css), []);
  assert.ok(rules(inspectReadableSource(css.replace('overflow-wrap: anywhere;', 'white-space: nowrap;')))
    .has('long-device-name-wrap-not-proven'));
  assert.ok(rules(inspectReadableSource(css.replace('.error-panel', '.error-message')))
    .has('long-error-wrap-not-proven'));
  assert.ok(rules(inspectReadableSource(css.replace('620px', '900px')))
    .has('mobile-breakpoint-not-proven'));
});

test('T-283: Turkish, combining Unicode and long device strings retain distinct labels', () => {
  const strings = ['Şube / teslimât — çığ', 'Şube / teslimât — çığ', 'İşletme adı: '.repeat(50), 'Çeşitli üniteler'.normalize('NFD')];
  const named = strings.map((name, i) => `${name} · cihaz ${i + 1}`);
  assert.equal(new Set(named).size, strings.length);
  assert.ok(named[2].length > 500);
  // Visibility, zoom, localization and small-viewport behavior require a live run.
});
