import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessAnnouncementMarkup, auditAdminDenials, probeAdminSequence,
} from './admin-denial-sequence.mjs';

const regionHtml = `<div id="admin-pill" role="status" aria-live="polite" aria-atomic="true"></div>
<section id="admin-metrics" aria-busy="true"></section>
<section id="admin-error" role="alert" aria-labelledby="admin-error-title" aria-describedby="admin-error-message"></section>
<strong id="admin-error-title">Yönetim verisi alınamadı</strong><p id="admin-error-message"></p>`;

// Compact deterministic fake page verifies that the probe can catch failures.
// Product acceptance is separate: run admin-denial-sequence.mjs on the owner SHA.
function fixture({ offlineForDenial = false, clearMetrics = true, credentials = 'include' } = {}) {
  return `
const $ = (id) => document.getElementById(id);
async function load() {
  ${clearMetrics ? `for (const id of ['users','users-detail','online-devices','devices-total',
    'calls','success-rate','owner-spend','capacity']) $(id).textContent = '—';` : ''}
  $('admin-pill').textContent = 'Yükleniyor';
  $('admin-error').classList.add('hidden');
  $('admin-error-message').textContent = '';
  $('admin-metrics').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/v1/admin/overview', {
      credentials: '${credentials}', headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const code = response.status;
      $('admin-pill').textContent = ${offlineForDenial
        ? "'Offline'"
        : "code === 401 ? 'Oturum gerekli' : code === 403 ? 'Yetki yetersiz' : 'Offline'"};
      $('admin-error-message').textContent = 'HTTP ' + code;
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
}

test('200 → 401 keeps two credentialed GET calls and clears old green metrics', async () => {
  const got = await probeAdminSequence(fixture(), 401);
  assert.equal(got.pass, true);
  assert.equal(got.before.metrics.users, '7');
  assert.equal(got.after.metrics.users, '—');
  assert.equal(got.after.pill, 'Oturum gerekli');
});

test('200 → 403 is visibly an authorization denial, not Offline', async () => {
  const got = await probeAdminSequence(fixture(), 403);
  assert.equal(got.pass, true);
  assert.equal(got.after.pill, 'Yetki yetersiz');
});

test('200 → 503 remains a separate offline/service-unavailable case', async () => {
  const got = await probeAdminSequence(fixture(), 503);
  assert.equal(got.pass, true);
  assert.equal(got.after.pill, 'Offline');
});

test('detects historical 401/403 wrongly labelled Offline without losing stale-metric check', async () => {
  const report = await auditAdminDenials(fixture({ offlineForDenial: true }));
  assert.equal(report.pass, false);
  assert.equal(report.passed, 1);
  assert.deepEqual(report.cases.slice(0, 2).map((x) => x.noFalseOffline), [false, false]);
  assert.deepEqual(report.cases.slice(0, 2).map((x) => x.noStaleSuccess), [true, true]);
});

test('detects stale successful counters after a later rejected request', async () => {
  const got = await probeAdminSequence(fixture({ clearMetrics: false }), 401);
  assert.equal(got.noStaleSuccess, false);
  assert.equal(got.after.metrics.users, '7');
});

test('detects a forbidden credential-mode change during retry', async () => {
  const got = await probeAdminSequence(fixture({ credentials: 'omit' }), 401);
  assert.equal(got.requestContract, false);
  assert.equal(got.pass, false);
});

test('rejects unsupported status before exercising a fake page', async () => {
  await assert.rejects(() => probeAdminSequence(fixture(), 418), RangeError);
});

test('K05-compatible role=status and role=alert bindings reach the IDs updated by admin.js', () => {
  assert.deepEqual(assessAnnouncementMarkup(regionHtml), {
    pass: true,
    checks: {
      statusLive: true,
      errorAlert: true,
      alertLabelBound: true,
      alertDescriptionBound: true,
      metricsBusy: true,
    },
  });
});

test('a missing role=alert or orphaned description fails even if the status is live', () => {
  const bad = regionHtml.replace('role="alert"', 'role="status"')
    .replace('aria-describedby="admin-error-message"', 'aria-describedby="missing-id"');
  const result = assessAnnouncementMarkup(bad);
  assert.equal(result.pass, false);
  assert.equal(result.checks.errorAlert, false);
  assert.equal(result.checks.alertDescriptionBound, false);
});

test('duplicate dynamic error IDs fail the source binding audit', () => {
  const result = assessAnnouncementMarkup(regionHtml + '<p id="admin-error-message"></p>');
  assert.equal(result.pass, false);
  assert.equal(result.checks.alertDescriptionBound, false);
});
