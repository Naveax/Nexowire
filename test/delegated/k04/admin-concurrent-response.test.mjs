import assert from 'node:assert/strict';
import test from 'node:test';
import { auditOutOfOrder, probeOutOfOrder } from './admin-concurrent-response.mjs';

const fixture = ({ guarded = false, guardAfterJson = guarded, credentials = 'include' } = {}) => `
const $ = (id) => document.getElementById(id);
let generation = 0;
async function load() {
  const current = ++generation;
  $('users').textContent = '—';
  $('admin-pill').textContent = 'Yükleniyor';
  $('admin-error-message').textContent = '';
  $('admin-error').classList.add('hidden');
  $('admin-metrics').setAttribute('aria-busy', 'true');
  const response = await fetch('/api/v1/admin/overview', { credentials: '${credentials}' });
  ${guarded ? 'if (current !== generation) return;' : ''}
  if (!response.ok) {
    $('admin-pill').textContent = 'Yetki yetersiz';
    $('admin-error-message').textContent = 'HTTP ' + response.status;
    $('admin-error').classList.remove('hidden');
  } else {
    const data = await response.json();
    ${guardAfterJson ? 'if (current !== generation) return;' : ''}
    $('users').textContent = String(data.users.total);
    $('admin-pill').textContent = 'Zero-spend aktif';
  }
  $('admin-metrics').setAttribute('aria-busy', 'false');
}
load();`;

test('late 200 cannot overwrite newer HTTP403 denial', async () => {
  const got = await probeOutOfOrder(fixture({ guarded: true }), 200, 403);
  assert.equal(got.pass, true);
  assert.deepEqual(got.afterLate, got.latest);
});

test('late HTTP403 cannot overwrite newer successful 200', async () => {
  const got = await probeOutOfOrder(fixture({ guarded: true }), 403, 200);
  assert.equal(got.pass, true);
  assert.deepEqual(got.afterLate, got.latest);
});

test('an unguarded implementation fails in both response orders', async () => {
  const got = await auditOutOfOrder(fixture());
  assert.equal(got.pass, false);
  assert.equal(got.passed, 0);
  for (const item of got.cases) {
    assert.equal(item.expectedLatest, true);
    assert.equal(item.requestContract, true);
    assert.equal(item.stable, false);
  }
});

test('omitting credentials never passes the check even with a request generation guard', async () => {
  const got = await auditOutOfOrder(fixture({ guarded: true, credentials: 'omit' }));
  assert.equal(got.pass, false);
  assert.ok(got.cases.every((item) => !item.requestContract));
});

test('invalid same-status scenario is rejected before running any source', async () => {
  await assert.rejects(probeOutOfOrder(fixture(), 403, 403), RangeError);
});

test('delayed older HTTP200 JSON cannot overwrite a newer HTTP403', async () => {
  const got = await probeOutOfOrder(fixture({ guarded: true }), 200, 403, {
    delayOlderJson: true,
  });
  assert.equal(got.pass, true);
  assert.deepEqual(got.afterLate, got.latest);
});

test('a fetch-only guard misses a delayed stale JSON completion', async () => {
  const got = await probeOutOfOrder(fixture({ guarded: true, guardAfterJson: false }),
    200, 403, { delayOlderJson: true });
  assert.equal(got.pass, false);
  assert.equal(got.requestContract, true);
  assert.equal(got.stable, false);
});

test('JSON-delay case rejects unsupported older HTTP403 status', async () => {
  await assert.rejects(probeOutOfOrder(fixture(), 403, 200,
    { delayOlderJson: true }), RangeError);
});
