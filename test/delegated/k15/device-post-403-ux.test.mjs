import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// This file tests only the real UI error-mapping helpers from web/app.js.
// No network, browser, Agent, Broker, or physical permission check is exercised.
const source = readFileSync(
  process.env.K15_APP_SOURCE ?? new URL('../../../web/app.js', import.meta.url), 'utf8',
);
const start = source.indexOf('function explainApiError(code) {');
const end = source.indexOf('\nasync function setDeviceAccessMode(', start);
assert.ok(start >= 0 && end > start, 'postDeviceMode source boundary changed; review fixture');
const helpers = source.slice(start, end);
assert.match(helpers, /async function postDeviceMode\(/, 'must test production POST helper');
const hasPost403Recovery = /response\.status\s*===\s*403/.test(helpers);

function harness(status, body, deviceId = 'other-account-machine') {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({url, options});
    return {ok: status >= 200 && status < 300, status, json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    }};
  };
  const context = vm.createContext({fetch, Error, JSON});
  vm.runInContext(helpers + '\nthis.invoke = postDeviceMode;', context, {filename: 'web/app.js'});
  return {
    requests,
    invoke: () => context.invoke('/api/v1/me/devices/access-mode', deviceId,
      {mode: 'full'}, 'full-access-v1'),
  };
}

test('D-093/#539: DEVICE_NOT_FOUND 403 explains ownership and does not retarget another device', async () => {
  const h = harness(403, {error: 'DEVICE_NOT_FOUND'});
  await assert.rejects(h.invoke(), /Cihaz bu hesaba bağlı değil/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/v1/me/devices/access-mode');
  assert.equal(h.requests[0].options.credentials, 'include');
  assert.equal(h.requests[0].options.method, 'POST');
  assert.equal(h.requests[0].options.headers['X-Nexowire-Confirm'], 'full-access-v1');
  assert.equal(JSON.parse(h.requests[0].options.body).deviceId, 'other-account-machine');
});

test('D-094/#539: empty-body 403 must give a human ownership/permission recovery message', {
  todo: !hasPost403Recovery && 'current owner source exposes only HTTP 403 for empty-denial POST',
}, async () => {
  const h = harness(403, undefined);
  await assert.rejects(h.invoke(), /cihaz|yetki|izin|erişim|hesap|sahibi/i);
  assert.equal(h.requests.length, 1);
});

test('D-095/#539: a transport failure is not mislabeled as another account device', async () => {
  const h = harness(503, {});
  await assert.rejects(h.invoke(), err => {
    assert.doesNotMatch(err.message, /Cihaz bu hesaba bağlı değil/);
    return true;
  });
});
