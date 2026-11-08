import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  observeAdminHttpError, diagnoseAdminError, inspectPairingRateLimit,
  inspectDeviceNames, inspectResponsiveSource, validateUiEvidence,
  inspectLongErrorFixture, readUiSource, auditUi,
} from '../../../scripts/delegated/k05/audit-p006-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const src = readUiSource(root);

test('T-559: real 401, 403 and 429 admin failures each produce misleading Offline, never success', async () => {
  for (const status of [401, 403, 429]) {
    const observation = await observeAdminHttpError(src.adminJs, status);
    assert.equal(observation.pill, 'Offline');
    assert.equal(observation.errorText, `HTTP ${status}`);
    assert.equal(observation.errorVisible, true);
    const findings = diagnoseAdminError(observation, src.adminHtml);
    assert.ok(findings.includes('http-error-collapsed-to-offline'));
    assert.ok(!findings.includes('http-error-falsely-successful'));
  }
});

test('T-559: denial/rate-limit, true alert and false success are independent checks', () => {
  const html = '<section id="admin-error" role="alert"></section>';
  assert.deepEqual(diagnoseAdminError({status:429,pill:'Çok fazla istek',pillClass:'bad',
    errorText:'HTTP 429',errorVisible:true}, html), []);
  const bad = diagnoseAdminError({status:403,pill:'Başarılı',pillClass:'good',
    errorText:'',errorVisible:false}, '<div id="admin-error"></div>');
  assert.deepEqual(bad, ['http-error-falsely-successful','http-error-not-visible','admin-alert-semantics-not-proven']);
  assert.deepEqual(diagnoseAdminError({status:200}, html), ['unrecognized-scenario']);
});

test('T-559: pairing 429 is not distinguished in current source and failure focus is unproven', () => {
  const found = inspectPairingRateLimit(src.connectJs);
  assert.ok(found.includes('pairing-429-not-distinguished'));
  assert.ok(found.includes('pairing-error-focus-not-proven'));
});

test('T-559: explicit 429 branch and focus remove source warnings; generic branch fails', () => {
  const synthetic = src.connectJs.replace('if (!pairing.ok) {',
    "if (!pairing.ok) { if (pairing.status === 429) throw new Error('Çok fazla istek');")
    .replace("$('error-panel').classList.remove('hidden');",
      "$('error-panel').classList.remove('hidden'); $('error-panel').focus();");
  assert.deepEqual(inspectPairingRateLimit(synthetic), []);
  assert.ok(inspectPairingRateLimit(synthetic.replace('pairing.status === 429', 'pairing.status === 500'))
    .includes('pairing-429-not-distinguished'));
});

test('T-560: same device names cannot rely on identical generic labels', () => {
  assert.ok(inspectDeviceNames(src.appJs).includes('duplicate-device-ordinal-not-proven'));
  const candidate = `const deviceLabel = device.name + ' · cihaz ' + (devices.indexOf(device) + 1);
  row.querySelector('.core-shortcut'); row.querySelector('.bridge-quick-toggle');
  row.querySelector('.folder-assign'); row.querySelector('.pc-settings-button');`;
  assert.deepEqual(inspectDeviceNames(candidate), []);
  assert.ok(inspectDeviceNames(candidate.replace('devices.indexOf(device)', '0'))
    .includes('duplicate-device-ordinal-not-proven'));
  const names = ['Depo','Depo'].map((name,index) => `${name} · cihaz ${index + 1}`);
  assert.equal(new Set(names).size, 2);
});

test('T-561: 320/375/768 matrix is SOURCE_ONLY and physical focus order is NOT_RUN', () => {
  const report = inspectResponsiveSource(src.connectHtml, src.css);
  assert.deepEqual(report.widths, [320,375,768]);
  assert.equal(report.browser, 'NOT_RUN');
  assert.equal(report.focusOrder, 'NOT_RUN');
  assert.equal(report.viewportPixels, 'NOT_RUN');
  assert.ok(report.findings.includes('long-error-wrap-unproven'));
});

test('T-561: missing viewport, breakpoint, and wrap are separate source negatives', () => {
  const markup = '<meta name="viewport" content="width=device-width,initial-scale=1">';
  const css = '.error-panel {overflow-wrap:anywhere;} @media (max-width:620px) {}';
  assert.deepEqual(inspectResponsiveSource(markup, css).findings, []);
  const broken = inspectResponsiveSource('<title>Test</title>', '.error-panel{word-break:normal;}');
  assert.deepEqual(broken.findings, ['viewport-meta-missing','narrow-breakpoint-unproven','long-error-wrap-unproven']);
});

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_C = 'c'.repeat(40);
const sourceEvidence = (overrides = {}) => ({
  mainSha: SHA_A, prHeadSha: SHA_B, overall: 'SOURCE_ONLY',
  samples: [{path:'test/delegated/k05/check.test.mjs',sourceSha:SHA_B,hosted:'PASS',
    discovered:true,runHeadSha:SHA_B,runId:42,runConclusion:'success',physical:'NOT_RUN'}],
  ...overrides,
});

test('T-562: exact PR source-head, run-head and called test path must bind', () => {
  assert.deepEqual(validateUiEvidence(sourceEvidence()), []);
  assert.ok(validateUiEvidence(sourceEvidence({samples:[{...sourceEvidence().samples[0],sourceSha:SHA_C}]}))
    .includes('mixed-source:test/delegated/k05/check.test.mjs'));
  assert.ok(validateUiEvidence(sourceEvidence({samples:[{...sourceEvidence().samples[0],runHeadSha:SHA_C}]}))
    .includes('unsupported-hosted-pass:test/delegated/k05/check.test.mjs'));
});

test('T-562: success of another PR or undiscovered MJS cannot be aggregated as PASS', () => {
  const sample = sourceEvidence().samples[0];
  for (const mutation of [{discovered:false},{runConclusion:'failed'},{runId:null}]) {
    assert.ok(validateUiEvidence(sourceEvidence({samples:[{...sample,...mutation}]}))
      .includes('unsupported-hosted-pass:test/delegated/k05/check.test.mjs'));
  }
  const mixed = sourceEvidence({overall:'PASS',samples:[sample,{...sample,path:'test/delegated/k05/other.test.mjs',sourceSha:SHA_C}]});
  assert.ok(validateUiEvidence(mixed).includes('false-overall-pass'));
});

test('T-562: physical acceptance requires artifact even with hosted success', () => {
  const sample = sourceEvidence().samples[0];
  assert.ok(validateUiEvidence(sourceEvidence({samples:[{...sample,physical:'PASS'}]}))
    .includes('unsupported-physical-pass'));
  assert.deepEqual(validateUiEvidence(sourceEvidence({samples:[{...sample,physical:'PASS',physicalArtifact:'artifact://test'}]})), []);
});

test('T-563: long Turkish errors retain named error and action, but source wrap is not enough', () => {
  const long = ('Şube ücretlendirmesi, sevkiyat adresi ve teslimat durumu doğrulanamadı. ').repeat(20);
  assert.ok(long.length > 1000);
  assert.ok(inspectLongErrorFixture(src.connectHtml, src.css, long).includes('long-error-wrap-not-proven'));
  const html = '<p id="error-message"></p><button id="approve">TEKRAR DENE</button>';
  const css = '.error-panel {overflow-wrap: anywhere;}';
  assert.deepEqual(inspectLongErrorFixture(html,css,long.normalize('NFD')), []);
  assert.deepEqual(inspectLongErrorFixture(html.replace('TEKRAR DENE',''),css,'   '),
    ['empty-error-text','error-or-action-not-named']);
});

test('T-564: exact current main audit remains source-only even where owner candidate differs', async () => {
  const report = await auditUi(root);
  assert.equal(report.verified, 'SOURCE_ONLY');
  assert.equal(report.nvda, 'NOT_RUN');
  assert.equal(report.browser, 'NOT_RUN');
  assert.ok(report.errors[401].includes('http-error-collapsed-to-offline'));
});
