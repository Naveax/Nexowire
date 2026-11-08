#!/usr/bin/env node
// Independent owner-web source probes for #539/#485. Never a browser/NVDA claim.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export async function observeAdminHttpError(source, status) {
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      const attributes = new Map();
      nodes.set(id, {
        textContent: '', className: '',
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name) },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: (name) => attributes.get(name),
      });
    }
    return nodes.get(id);
  };
  if (!/\bload\(\);\s*$/.test(source)) throw new Error('admin.js bootstrap missing');
  const context = vm.createContext({
    document: { getElementById: element },
    fetch: async () => ({ ok: false, status }),
  });
  vm.runInContext(source.replace(/\bload\(\);\s*$/, 'globalThis.__pending = load();'), context, { timeout: 1500 });
  await context.__pending;
  return {
    status, pill: element('admin-pill').textContent,
    pillClass: element('admin-pill').className,
    errorText: element('admin-error-message').textContent,
    errorVisible: !element('admin-error').classList.contains('hidden'),
  };
}

export function diagnoseAdminError(observation, html) {
  const found = [];
  if (![401, 403, 429].includes(observation.status)) return ['unrecognized-scenario'];
  if (/offline/i.test(observation.pill ?? '')) found.push('http-error-collapsed-to-offline');
  if (/başarı|success|hazır|ready/i.test(observation.pill ?? '') || /\bgood\b/.test(observation.pillClass ?? '')) {
    found.push('http-error-falsely-successful');
  }
  if (!observation.errorVisible || !observation.errorText) found.push('http-error-not-visible');
  if (!/<[^>]+id="admin-error"[^>]+role="alert"/.test(html)) found.push('admin-alert-semantics-not-proven');
  return found;
}

export function inspectPairingRateLimit(js) {
  const findings = [];
  const failedResponse = /if\s*\(!pairing\.ok\)\s*\{([\s\S]*?)\n\s*\}/.exec(js)?.[1] ?? '';
  if (!/pairing\.status\s*===\s*429|pairing\.status\s*==\s*429/.test(failedResponse)) {
    findings.push('pairing-429-not-distinguished');
  }
  if (!/\bshowError\(/.test(js) || !/\$\('error-panel'\)\.focus\(\)/.test(js)) {
    findings.push('pairing-error-focus-not-proven');
  }
  return findings;
}

export function inspectDeviceNames(js) {
  const findings = [];
  if (!/deviceLabel\s*=\s*device\.name\s*\+[^;]*devices\.indexOf\(device\)/.test(js)) {
    findings.push('duplicate-device-ordinal-not-proven');
  }
  for (const action of ['core-shortcut', 'bridge-quick-toggle', 'folder-assign', 'pc-settings-button']) {
    if (!js.includes(`row.querySelector('.${action}')`)) findings.push(`device-control-missing:${action}`);
  }
  return findings;
}

export function inspectResponsiveSource(html, css) {
  const findings = [];
  if (!/<meta\s+name="viewport"[^>]+width=device-width/.test(html)) findings.push('viewport-meta-missing');
  if (!/@media\s*\(max-width:\s*620px\)/.test(css)) findings.push('narrow-breakpoint-unproven');
  if (!/\.error-panel[^{}]*\{[^}]*overflow-wrap\s*:\s*anywhere/s.test(css)) {
    findings.push('long-error-wrap-unproven');
  }
  return { source: 'SOURCE_ONLY', widths: [320, 375, 768], findings,
    browser: 'NOT_RUN', focusOrder: 'NOT_RUN', viewportPixels: 'NOT_RUN' };
}

export function validateUiEvidence(record) {
  const findings = [];
  const validSha = /^[0-9a-f]{40}$/;
  if (!validSha.test(record.mainSha ?? '') || !validSha.test(record.prHeadSha ?? '')) findings.push('invalid-source-sha');
  if (record.samples?.length === 0 || !Array.isArray(record.samples)) findings.push('missing-tests');
  for (const sample of record.samples ?? []) {
    if (sample.sourceSha !== record.prHeadSha) findings.push(`mixed-source:${sample.path ?? 'unknown'}`);
    if (!sample.path || !/\.test\.(?:mjs|ts)$/.test(sample.path)) findings.push('unidentified-test');
    if (sample.hosted === 'PASS' && (!sample.discovered || sample.runHeadSha !== record.prHeadSha || !sample.runId ||
        sample.runConclusion !== 'success')) {
      findings.push(`unsupported-hosted-pass:${sample.path ?? 'unknown'}`);
    }
    if (sample.physical === 'PASS' && !sample.physicalArtifact) findings.push('unsupported-physical-pass');
  }
  if (record.overall === 'PASS' && findings.length) findings.push('false-overall-pass');
  return findings;
}

export function inspectLongErrorFixture(html, css, text) {
  const findings = [];
  if (!text || text.trim().length === 0) findings.push('empty-error-text');
  if (!/id="error-message"/.test(html) || !/id="approve"[^>]*>[^<]+<\/button>/.test(html)) {
    findings.push('error-or-action-not-named');
  }
  if (!/\.error-panel[^{}]*\{[^}]*overflow-wrap\s*:\s*anywhere/s.test(css)) {
    findings.push('long-error-wrap-not-proven');
  }
  return findings;
}

export function readUiSource(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return {
    adminJs: read('web/admin.js'), adminHtml: read('web/admin.html'),
    connectJs: read('web/connect.js'), connectHtml: read('web/connect.html'),
    appJs: read('web/app.js'), css: read('web/styles.css'),
  };
}

export async function auditUi(root) {
  const src = readUiSource(root);
  const errors = {};
  for (const status of [401, 403, 429]) {
    errors[status] = diagnoseAdminError(await observeAdminHttpError(src.adminJs, status), src.adminHtml);
  }
  return {
    errors, pairing: inspectPairingRateLimit(src.connectJs),
    devices: inspectDeviceNames(src.appJs),
    responsive: inspectResponsiveSource(src.connectHtml, src.css),
    verified: 'SOURCE_ONLY', browser: 'NOT_RUN', nvda: 'NOT_RUN', physical: 'NOT_RUN',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditUi(resolve(process.argv[2] ?? '.'));
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.errors).some((x) => x.length) || result.pairing.length || result.devices.length ||
      result.responsive.findings.length) process.exitCode = 1;
}
