const $ = (id) => document.getElementById(id);
const n = (value) => new Intl.NumberFormat('tr-TR').format(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isOptionalPercent = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);

function isOverview(data) {
  const users = data?.users;
  const devices = data?.devices;
  const usage = data?.usage;
  const infra = data?.infrastructure;
  return isCount(users?.total) && isCount(users?.active24h) &&
    isCount(users?.paid) && users.active24h <= users.total && users.paid <= users.total &&
    isCount(devices?.online) && isCount(devices?.total) && devices.online <= devices.total &&
    isCount(usage?.calls24h) && isOptionalPercent(usage?.successRate) &&
    typeof infra?.ownerPaidSpendAllowed === 'boolean' &&
    typeof infra?.providerAutoUpgradeAllowed === 'boolean' &&
    isOptionalPercent(infra?.freeCapacityPercent);
}

function showLoading() {
  for (const id of [
    'users', 'users-detail', 'online-devices', 'devices-total',
    'calls', 'success-rate', 'owner-spend', 'capacity',
  ]) $(id).textContent = '—';
  $('admin-pill').textContent = 'Yükleniyor';
  $('admin-pill').className = 'pill muted admin-status';
  $('admin-metrics').setAttribute('aria-busy', 'true');
  $('admin-error-message').textContent = '';
  $('admin-error').classList.add('hidden');
}

async function load() {
  showLoading();
  try {
    const response = await fetch('/api/v1/admin/overview', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (!isOverview(data)) throw new Error('Yönetim özeti eksik veya geçersiz');

    $('users').textContent = n(data.users.total);
    $('users-detail').textContent =
      n(data.users.active24h) + ' aktif / ' + n(data.users.paid) + ' paid';
    $('online-devices').textContent = n(data.devices.online);
    $('devices-total').textContent = n(data.devices.total) + ' toplam';
    $('calls').textContent = n(data.usage.calls24h);
    $('success-rate').textContent =
      data.usage.successRate === null
        ? 'Başarı oranı yok'
        : data.usage.successRate.toFixed(2) + '% başarı';

    const zeroSpend =
      data.infrastructure.ownerPaidSpendAllowed === false &&
      data.infrastructure.providerAutoUpgradeAllowed === false;
    $('owner-spend').textContent = zeroSpend ? '$0 HARD MODE' : 'UYARI';
    $('capacity').textContent =
      data.infrastructure.freeCapacityPercent === null
        ? 'Free kapasite verisi yok'
        : 'Free kapasite %' +
          Math.round(data.infrastructure.freeCapacityPercent);

    const pill = $('admin-pill');
    pill.textContent = zeroSpend ? 'Zero-spend aktif' : 'Policy ihlali';
    pill.className = 'pill admin-status ' + (zeroSpend ? 'good' : 'bad');
  } catch (error) {
    $('admin-pill').textContent = 'Offline';
    $('admin-pill').className = 'pill admin-status bad';
    $('admin-error-message').textContent =
      error instanceof Error ? error.message : String(error);
    $('admin-error').classList.remove('hidden');
  } finally {
    $('admin-metrics').setAttribute('aria-busy', 'false');
  }
}

load();
