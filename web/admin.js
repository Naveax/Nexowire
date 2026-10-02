const $ = (id) => document.getElementById(id);
const n = (value) => new Intl.NumberFormat('tr-TR').format(value);

async function load() {
  try {
    const response = await fetch('/api/v1/admin/overview', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();

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
    pill.className = 'pill ' + (zeroSpend ? 'good' : 'bad');
  } catch (error) {
    $('admin-pill').textContent = 'Offline';
    $('admin-pill').className = 'pill bad';
    $('admin-error-message').textContent =
      error instanceof Error ? error.message : String(error);
    $('admin-error').classList.remove('hidden');
  }
}

load();
