import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCase, renderAdminSource } from './issue539-admin-status-probe.mjs';

const request = [{
  url: '/api/v1/admin/overview',
  options: { credentials: 'include', headers: { Accept: 'application/json' } },
}];
const observation = (pill, users = '—', calls24h = '—', errorVisible = true) =>
  ({ pill, users, calls24h, errorVisible, requests: request });

test('T-274: negative or missing counts shown as healthy are rejected', () => {
  assert.equal(assessCase('invalid-negative', observation('Zero-spend aktif', '-1', '4')).pass, false);
  assert.equal(assessCase('invalid-missing', observation('Offline')).pass, true);
});

test('T-275: 401 and 403 must not be disguised as transport offline', () => {
  for (const code of [401, 403]) {
    assert.equal(assessCase(`http-${code}`, observation('Offline')).pass, false);
    assert.equal(assessCase(`http-${code}`, observation('Erişim reddedildi')).pass, true);
  }
});

test('T-275: a 503 transport/server failure is a separate error case', () => {
  assert.equal(assessCase('http-503', observation('Offline')).pass, true);
  assert.equal(assessCase('http-503', observation('Zero-spend aktif', '3', '4', false)).pass, false);
});

test('T-276: the probe refuses additional mutation calls or missing credentials', () => {
  const sample = observation('Erişim reddedildi');
  sample.requests = [{ ...request[0], options: { method: 'POST', credentials: 'include' } }];
  assert.equal(assessCase('http-403', sample).pass, false);
  sample.requests = [{ ...request[0], options: { method: 'GET' } }];
  assert.equal(assessCase('http-403', sample).pass, false);
});

test('T-273: read-only VM correctly records the actual displayed 403 response', async () => {
  const source = `
    async function load() {
      const response = await fetch('/api/v1/admin/overview', { credentials: 'include' });
      if (!response.ok) {
        document.getElementById('admin-pill').textContent = 'Offline';
        document.getElementById('admin-error').classList.remove('hidden');
      }
    }
    load();
  `;
  const result = await renderAdminSource(source, { ok: false, status: 403 });
  assert.equal(result.pill, 'Offline');
  assert.equal(result.errorVisible, true);
  assert.equal(assessCase('http-403', result).pass, false);
});
