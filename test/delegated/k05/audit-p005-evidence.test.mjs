import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  inspectCiDiscovery, executeAdminDenial, classifyAdminDenial,
  inspectConnectFocus, inspectDuplicateDeviceNames, evaluateEvidence,
  readSnapshot,
} from '../../../scripts/delegated/k05/audit-p005-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const current = readSnapshot(root);

test('T-419: exact-HEAD green CI does not prove invocation of either new K05 MJS suite', () => {
  const result = inspectCiDiscovery(current.workflow, current.packageText);
  assert.equal(result.length, 2);
  assert.ok(result.every((x) => !x.discovered && !x.explicitlyInvoked && !x.npmIncludesMjs));
  for (const old of ['test/delegated/k05/audit-html.test.mjs', 'test/delegated/k05/dynamic-id-contract.test.mjs']) {
    assert.ok(inspectCiDiscovery(current.workflow, current.packageText, [old])[0].discovered, old);
  }
});

test('T-419: explicit invocation or real MJS npm glob is needed; text in comments is not proof', () => {
  const target = 'test/delegated/k05/audit-owner-web.test.mjs';
  assert.ok(!inspectCiDiscovery(`# ${target}\nrun: npm test`, current.packageText, [target])[0].discovered);
  assert.ok(inspectCiDiscovery(`- run: node --test ${target}`, current.packageText, [target])[0].discovered);
  assert.ok(inspectCiDiscovery('run: npm test', JSON.stringify({scripts:{test:'node --test test/**/*.test.mjs'}}), [target])[0].discovered);
});

test('T-420: actual 401/403 denied admin overview is displayed as Offline, with an error alert visible', async () => {
  for (const status of [401, 403]) {
    const observed = await executeAdminDenial(current.adminJs, status);
    assert.equal(observed.pill, 'Offline');
    assert.equal(observed.alertVisible, true);
    assert.equal(observed.alertMessage, `HTTP ${status}`);
    assert.ok(classifyAdminDenial(status, observed).includes('auth-denial-misreported-as-offline'));
  }
});

test('T-420: source-only classifier independently rejects false success and missing alert', () => {
  const failure = classifyAdminDenial(403, {pill:'Başarılı',pillClass:'good',alertVisible:false,alertMessage:'',busy:'true'});
  assert.deepEqual(failure, ['auth-denial-misreported-as-success','denial-alert-missing','denial-loading-not-cleared']);
  assert.deepEqual(classifyAdminDenial(401, {pill:'Yetki reddedildi',pillClass:'bad',alertVisible:true,
    alertMessage:'HTTP 401',busy:'false'}), []);
  assert.throws(() => classifyAdminDenial(200, {}), /Only unauthorized/);
});

test('T-421: invalid callback, failed pairing and cancellation focus paths are checked separately', () => {
  const findings = inspectConnectFocus(current.connectHtml, current.connectJs);
  assert.ok(findings.includes('invalid-callback-focus-not-proven'));
  assert.ok(findings.includes('failed-pairing-focus-not-proven'));
  assert.ok(!findings.includes('cancel-link-not-proven'));
  assert.ok(!findings.includes('invalid-callback-has-no-install-recovery'));
});

test('T-421: added explicit focus paths pass; missing cancel and install fallback fail', () => {
  const synthetic = current.connectJs.replace(
    "$('install-panel').classList.remove('hidden');",
    "$('install-panel').classList.remove('hidden'); $('install-panel').focus();",
  ).replace("$('error-panel').classList.remove('hidden');",
    "$('error-panel').classList.remove('hidden'); $('error-panel').focus(); approve.focus();");
  assert.deepEqual(inspectConnectFocus(current.connectHtml, synthetic), []);
  const noCancel = current.connectHtml.replace(/connect-cancel/g, 'dismiss');
  assert.ok(inspectConnectFocus(noCancel, synthetic).includes('cancel-link-not-proven'));
  assert.ok(inspectConnectFocus(current.connectHtml, synthetic.replace("$('install-panel').classList.remove('hidden');", ''))
    .includes('invalid-callback-has-no-install-recovery'));
});

test('T-422: duplicate names require ordinal source context; generic main lacks it', () => {
  assert.ok(inspectDuplicateDeviceNames(current.appJs).includes('same-named-devices-unqualified'));
  const js = `const deviceLabel = device.name + ' · cihaz ' + (devices.indexOf(device) + 1);
  row.querySelector('.core-shortcut'); row.querySelector('.bridge-quick-toggle');
  row.querySelector('.folder-assign'); row.querySelector('.pc-settings-button');`;
  assert.deepEqual(inspectDuplicateDeviceNames(js), []);
  assert.ok(inspectDuplicateDeviceNames(js.replace('devices.indexOf(device)', '0'))
    .includes('same-named-devices-unqualified'));
});

test('T-423: source-only evidence cannot masquerade as physical, NVDA or Chromium acceptance', () => {
  const base = {scope:'SOURCE_ONLY', nvda:'NOT_RUN', chromium:'NOT_RUN',device:'NOT_RUN',
    k05CiDiscovered:false,k05CiStatus:'NOT_RUN',ciRunConclusion:'success',ciStatus:'PASS'};
  assert.deepEqual(evaluateEvidence(base), []);
  assert.deepEqual(evaluateEvidence({...base,nvda:'PASS',chromium:'PASS',device:'PASS',k05CiStatus:'PASS'}), [
    'source-passed-off-as-nvda','source-passed-off-as-chromium','source-passed-off-as-device',
    'uninvoked-tests-claimed-ci-pass',
  ]);
  assert.ok(evaluateEvidence({...base,ciRunConclusion:null}).includes('non-success-run-claimed-pass'));
});
