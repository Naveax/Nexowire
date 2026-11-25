import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditAdminAuthBoundary, probe403Privacy, probeDeniedRetry,
} from './admin-auth-boundary.mjs';

const fixture = ({ leakBody = false, falseGreen = false, leaveCounters = false } = {}) => `
const $ = (id) => document.getElementById(id);
async function load() {
  ${leaveCounters ? '' : `for (const id of ['users','users-detail','online-devices','devices-total',
    'calls','success-rate','owner-spend','capacity']) $(id).textContent = '—';`}
  $('admin-pill').textContent = 'Yükleniyor';
  $('admin-error-message').textContent = '';
  $('admin-error').classList.add('hidden');
  $('admin-metrics').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/v1/admin/overview', { credentials: 'include' });
    if (!response.ok) {
      ${leakBody ? `const content = await response.json();
        $('admin-error-message').textContent = content.token;` :
        "$('admin-error-message').textContent = 'HTTP ' + response.status;"}
      $('admin-pill').textContent = '${falseGreen ? 'Zero-spend aktif' : 'Erişim reddedildi'}';
      $('admin-error').classList.remove('hidden');
      return;
    }
    const overview = await response.json();
    $('users').textContent = String(overview.users.total);
    $('admin-pill').textContent = 'Zero-spend aktif';
  } finally {
    $('admin-metrics').setAttribute('aria-busy', 'false');
  }
}
load();`;

test('403 response body and status text never reach rendered UI or get parsed', async () => {
  const result = await probe403Privacy(fixture());
  assert.equal(result.pass, true);
  assert.equal(result.bodyReads, 0);
  assert.equal(result.state.errorVisible, true);
});

test('a fixture that displays a fake token from HTTP 403 is detected', async () => {
  const result = await probe403Privacy(fixture({ leakBody: true }));
  assert.equal(result.pass, false);
  assert.equal(result.bodyHidden, false);
  assert.equal(result.bodyReads, 1);
});

test('403 → pending retry → 403 → actual 200 never shows early success', async () => {
  const result = await probeDeniedRetry(fixture());
  assert.equal(result.pass, true);
  assert.equal(result.waiting.pill, 'Yükleniyor');
  assert.equal(result.deniedAgain.errorVisible, true);
  assert.equal(result.recovered.pill, 'Zero-spend aktif');
});

test('falsely showing green on 403 fails even if eventual HTTP 200 recovers', async () => {
  const result = await probeDeniedRetry(fixture({ falseGreen: true }));
  assert.equal(result.noPrematureAccess, false);
  assert.equal(result.recoveryReal, true);
  assert.equal(result.pass, false);
});

test('retaining stale metrics during pending retry fails before the fetch resolves', async () => {
  const result = await probeDeniedRetry(fixture({ leaveCounters: true }));
  assert.equal(result.pass, false);
  assert.equal(result.noPrematureAccess, false);
});

test('aggregate audit requires both privacy and retry gates to pass', async () => {
  const good = await auditAdminAuthBoundary(fixture());
  const bad = await auditAdminAuthBoundary(fixture({ falseGreen: true }));
  assert.equal(good.pass, true);
  assert.equal(bad.pass, false);
  assert.equal(bad.bodyPrivacy.pass, false);
  assert.equal(bad.deniedRetry.pass, false);
});
