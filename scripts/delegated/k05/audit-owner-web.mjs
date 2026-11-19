#!/usr/bin/env node
// Read-only source contract audit for #539/R11 and #485 UI candidates.
// Findings are not equivalent to a real browser or assistive-technology run.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditErrorBindings } from './audit-html.mjs';

function hasAll(source, fragments) {
  return fragments.every((fragment) => source.includes(fragment));
}

export function inspectConnectKeyboard(html, js) {
  const findings = [];
  if (!html.includes('role="tablist"') || (html.match(/role="tab"/g) ?? []).length < 3) {
    findings.push('os-tabs-not-semantic');
  }
  if (!hasAll(js, ["addEventListener('keydown'", 'ArrowRight', 'ArrowLeft', 'Home', 'End', '.focus()'])) {
    findings.push('os-tabs-keyboard-contract-missing');
  }
  if (!hasAll(js, ["$('error-panel').focus()", 'approve.focus()'])) {
    findings.push('connect-error-focus-not-proven');
  }
  return findings;
}

export function inspectDeviceActionNames(js) {
  const findings = [];
  // Same visible name is allowed for different devices. Include an ordinal in
  // the screen-reader context and bind it to high-risk per-device controls.
  if (!/deviceLabel\s*=\s*device\.name\s*\+[^;]*devices\.indexOf\(device\)/.test(js)) {
    findings.push('nonunique-device-context');
  }
  for (const selector of ['.core-shortcut', '.bridge-quick-toggle', '.folder-assign', '.pc-settings-button']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`row\\.querySelector\\(['"]${escaped}['"]\\)\\.setAttribute\\(['"]aria-label['"],\\s*deviceLabel`);
    // Some controls are assigned through a local variable; keep that explicit.
    const localVariable = {
      '.bridge-quick-toggle': 'bridgeQuickToggle',
      '.folder-assign': 'folderSelect',
      '.pc-settings-button': 'pcButton',
    }[selector];
    const local = localVariable && new RegExp(`${localVariable}\\.setAttribute\\('aria-label',\\s*deviceLabel`).test(js);
    if (!pattern.test(js) && !local) findings.push(`unscoped-action:${selector}`);
  }
  return findings;
}

export function inspectListAnnouncements(html, js) {
  const findings = [];
  const status = html.match(/<[^>]*id="device-list-status"[^>]*>/)?.[0] ?? '';
  if (!status.includes('role="status"') || !status.includes('aria-live="polite"')) {
    findings.push('missing-device-list-live-status');
  }
  if (!js.includes("$('device-list-status').textContent")) {
    findings.push('unbound-device-list-status');
  }
  if (!hasAll(js, ["root.setAttribute('aria-busy', String(loading))", "root.setAttribute('aria-busy', 'false')"])) {
    findings.push('unverified-list-busy-transition');
  }
  return findings;
}

export function inspectReadableSource(css) {
  const findings = [];
  if (!/\.device-name\s*\{[^}]*overflow-wrap\s*:\s*anywhere/s.test(css)) {
    findings.push('long-device-name-wrap-not-proven');
  }
  if (!/\.error-panel[^{}]*\{[^}]*overflow-wrap\s*:\s*anywhere/s.test(css)) {
    findings.push('long-error-wrap-not-proven');
  }
  if (!/@media\s*\(max-width\s*:\s*620px\)/.test(css)) {
    findings.push('mobile-breakpoint-not-proven');
  }
  return findings;
}

export function auditOwnerWeb(source) {
  const findings = [];
  const add = (owner, rule, detail = '') => findings.push({ owner, rule, detail });
  for (const [owner, html, js, panel, message] of [
    ['K01', source.connectHtml, source.connectJs, 'error-panel', 'error-message'],
    ['K04', source.adminHtml, source.adminJs, 'admin-error', 'admin-error-message'],
    ['K03', source.indexHtml, source.appJs, 'error-panel', 'error-message'],
  ]) {
    for (const finding of auditErrorBindings(html, js, 'web/source.html', { panel, message }).findings) {
      add(owner, finding.rule, finding.detail);
    }
  }
  for (const rule of inspectConnectKeyboard(source.connectHtml, source.connectJs)) add('K01', rule);
  for (const rule of inspectDeviceActionNames(source.appJs)) add('K03', rule);
  for (const rule of inspectListAnnouncements(source.indexHtml, source.appJs)) add('K03', rule);
  for (const rule of inspectReadableSource(source.css)) add('K02', rule);
  return {
    issues: ['#539/R11', '#485'],
    findings,
    verified: 'SOURCE_ONLY',
    browser: 'NOT_RUN', keyboard: 'NOT_RUN', screenReader: 'NOT_RUN', mobileLayout: 'NOT_RUN',
  };
}

export function readWebSnapshot(root) {
  const read = (name) => readFileSync(join(root, 'web', name), 'utf8');
  return {
    connectHtml: read('connect.html'), connectJs: read('connect.js'),
    indexHtml: read('index.html'), appJs: read('app.js'),
    adminHtml: read('admin.html'), adminJs: read('admin.js'), css: read('styles.css'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const report = auditOwnerWeb(readWebSnapshot(root));
  for (const finding of report.findings) {
    console.log(`${finding.owner} ${finding.rule}${finding.detail ? ': ' + finding.detail : ''}`);
  }
  console.log(`SOURCE_ONLY: ${report.findings.length} findings; real keyboard/browser/AT/viewport NOT_RUN`);
  if (report.findings.length) process.exitCode = 1;
}
