#!/usr/bin/env node
// Independent, read-only #539/#485 source and CI discovery checks.
// No DOM/keyboard/assistive-tech claim can be inferred from this output.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const K05_NEW_TESTS = Object.freeze([
  'test/delegated/k05/audit-owner-web.test.mjs',    // PR #1115
  'test/delegated/k05/verify-ui-test-provenance.test.mjs', // PR #1122
]);

export function inspectCiDiscovery(workflow, packageText, paths = K05_NEW_TESTS) {
  const pkg = JSON.parse(packageText);
  const npmTest = String(pkg.scripts?.test ?? '');
  // Only action step `run:` bodies count; comments, step labels and env cannot prove invocation.
  const lines = workflow.split('\n');
  const executable = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length;
    if (start[2] !== '|') executable.push(start[2]);
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const childIndent = /^\s*/.exec(lines[j])[0].length;
      if (childIndent <= indent) break;
      if (!/^\s*#/.test(lines[j])) executable.push(lines[j]);
    }
  }
  const commands = executable.join('\n');
  // Current `npm test` only selects TS; do not infer .mjs discovery from `npm run check`.
  const npmIncludesMjs = /(?:\*\*\/\*|\.test\.mjs)/.test(npmTest) && !/\.test\.ts\b/.test(npmTest);
  return paths.map((path) => ({
    path,
    explicitlyInvoked: commands.includes(path),
    npmIncludesMjs,
    discovered: commands.includes(path) || npmIncludesMjs,
  }));
}

export function classifyAdminDenial(status, observed) {
  if (![401, 403].includes(status)) throw new Error('Only unauthorized/forbidden statuses are in scope');
  const failures = [];
  if (/offline/i.test(observed.pill ?? '')) failures.push('auth-denial-misreported-as-offline');
  if (/başarı|success|hazır|good/i.test(observed.pill ?? '') || observed.pillClass?.includes('good')) {
    failures.push('auth-denial-misreported-as-success');
  }
  if (!observed.alertVisible || !observed.alertMessage) failures.push('denial-alert-missing');
  if (observed.busy !== 'false') failures.push('denial-loading-not-cleared');
  return failures;
}

export async function executeAdminDenial(adminJs, httpStatus) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) {
      const attributes = new Map();
      const classes = new Set(['hidden']);
      elements.set(id, {
        textContent: '', className: '',
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        setAttribute: (key, value) => attributes.set(key, value),
        getAttribute: (key) => attributes.get(key),
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get },
    fetch: async () => ({ ok: false, status: httpStatus }),
  });
  if (!/\bload\(\);\s*$/.test(adminJs)) throw new Error('Expected boot-time load() at end of admin source');
  vm.runInContext(adminJs.replace(/\bload\(\);\s*$/, 'globalThis.__loadPromise = load();'), context, { timeout: 1500 });
  await context.__loadPromise;
  return {
    pill: get('admin-pill').textContent,
    pillClass: get('admin-pill').className,
    alertMessage: get('admin-error-message').textContent,
    alertVisible: !get('admin-error').classList.contains('hidden'),
    busy: get('admin-metrics').getAttribute('aria-busy'),
  };
}

export function inspectConnectFocus(html, js) {
  const findings = [];
  const invalid = /if\s*\(!callback\)\s*\{([\s\S]*?)\n\s*\}/.exec(js)?.[1] ?? '';
  if (!invalid.includes("$('install-panel').classList.remove('hidden')")) findings.push('invalid-callback-has-no-install-recovery');
  if (!/\.focus\(\)/.test(invalid)) findings.push('invalid-callback-focus-not-proven');
  if (!/\$\('error-panel'\)\.focus\(\)/.test(js) || !/approve\.focus\(\)/.test(js)) {
    findings.push('failed-pairing-focus-not-proven');
  }
  if (!/<a[^>]+class="[^"]*connect-cancel[^\"]*"[^>]+href="\/"/.test(html) &&
      !/<a[^>]+href="\/"[^>]+class="[^"]*connect-cancel/.test(html)) {
    findings.push('cancel-link-not-proven');
  }
  return findings;
}

export function inspectDuplicateDeviceNames(js) {
  const findings = [];
  if (!/deviceLabel\s*=\s*device\.name\s*\+[^;]*devices\.indexOf\(device\)/.test(js)) {
    findings.push('same-named-devices-unqualified');
  }
  const actions = ['core-shortcut', 'bridge-quick-toggle', 'folder-assign', 'pc-settings-button'];
  for (const action of actions) {
    if (!js.includes(`row.querySelector('.${action}')`)) findings.push(`missing-action:${action}`);
  }
  // K03 owns the dynamic DOM test; finding does not prove a real wrong-device dispatch.
  return findings;
}

export function evaluateEvidence(record) {
  const errors = [];
  const nonPhysical = record.scope === 'SOURCE_ONLY';
  if (nonPhysical && record.nvda === 'PASS') errors.push('source-passed-off-as-nvda');
  if (nonPhysical && record.chromium === 'PASS') errors.push('source-passed-off-as-chromium');
  if (nonPhysical && record.device === 'PASS') errors.push('source-passed-off-as-device');
  if (record.k05CiDiscovered !== true && record.k05CiStatus === 'PASS') errors.push('uninvoked-tests-claimed-ci-pass');
  if (record.ciRunConclusion !== 'success' && record.ciStatus === 'PASS') errors.push('non-success-run-claimed-pass');
  return errors;
}

export function readSnapshot(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  return {
    workflow: read('.github/workflows/ci.yml'), packageText: read('package.json'),
    adminJs: read('web/admin.js'), adminHtml: read('web/admin.html'),
    connectJs: read('web/connect.js'), connectHtml: read('web/connect.html'), appJs: read('web/app.js'),
  };
}

export async function auditP005(root) {
  const src = readSnapshot(root);
  const denial401 = await executeAdminDenial(src.adminJs, 401);
  const denial403 = await executeAdminDenial(src.adminJs, 403);
  return {
    ci: inspectCiDiscovery(src.workflow, src.packageText),
    admin: { 401: classifyAdminDenial(401, denial401), 403: classifyAdminDenial(403, denial403) },
    connect: inspectConnectFocus(src.connectHtml, src.connectJs),
    devices: inspectDuplicateDeviceNames(src.appJs),
    verified: 'SOURCE_ONLY', browser: 'NOT_RUN', nvda: 'NOT_RUN', device: 'NOT_RUN',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditP005(resolve(process.argv[2] ?? '.'));
  console.log(JSON.stringify(result, null, 2));
  const failures = result.ci.filter((x) => !x.discovered).length +
    Object.values(result.admin).flat().length + result.connect.length + result.devices.length;
  if (failures) process.exitCode = 1;
}
