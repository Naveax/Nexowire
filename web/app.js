const $ = (id) => document.getElementById(id);

function formatNumber(value) {
  return new Intl.NumberFormat('tr-TR').format(value);
}

// Free credits renew at midnight UTC on the first day of each month.
function nextUtcPeriodStart(now = new Date()) {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() + 1, 1,
  )).toISOString().slice(0, 10);
}

function setPill(text, state) {
  const pill = $('connection-pill');
  pill.textContent = text;
  pill.className = 'pill ' + state;
}

function setBillingBusy(busy) {
  for (const id of [
    'upgrade-plus',
    'upgrade-pro',
    'billing-portal',
  ]) {
    $(id).disabled = busy;
  }
  for (const button of $('prepaid-packs').querySelectorAll('button')) {
    button.disabled = busy;
  }
}

function subscriptionLabel(status) {
  const labels = {
    on_trial: 'Deneme',
    active: 'Aktif',
    paused: 'Duraklatıldı',
    past_due: 'Ödeme bekleniyor',
    unpaid: 'Ödenmedi',
    cancelled: 'İptal edildi',
    expired: 'Sona erdi',
  };
  return labels[status] ?? status;
}

const FREE_ONLY_MODE = true;

function renderBilling(status) {
  const panel = $('billing-panel');
  panel.classList.remove('hidden');

  $('upgrade-plus').classList.add('hidden');
  $('upgrade-pro').classList.add('hidden');
  $('billing-portal').classList.add('hidden');
  const prepaidRoot = $('prepaid-packs');
  prepaidRoot.classList.add('hidden');
  prepaidRoot.textContent = '';

  if (status.prepaid) {
    const refundDebt =
      Number(status.prepaid.refundDebt ?? 0);
    $('billing-detail').textContent =
      'Custom prepaid · ' +
      formatNumber(status.prepaid.balance) +
      ' kredi bakiye' +
      (refundDebt > 0
        ? ' · ' +
          formatNumber(refundDebt) +
          ' kredi iade borcu; yeni paket önce bu borcu kapatır'
        : '');
    if (Array.isArray(status.prepaid.packs) && status.prepaid.packs.length) {
      prepaidRoot.classList.remove('hidden');
      for (const pack of status.prepaid.packs) {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = pack.label ||
          formatNumber(pack.credits) + ' kredi';
        button.addEventListener('click', () => {
          void startPrepaidCheckout(pack.variantId);
        });
        prepaidRoot.appendChild(button);
      }
    } else {
      $('billing-detail').textContent +=
        ' · Satın alınabilir kredi paketi yapılandırılmamış.';
    }
    return;
  }

  if (status.subscription) {
    $('billing-detail').textContent =
      status.subscription.planId.toUpperCase() +
      ' · ' +
      subscriptionLabel(status.subscription.status);
    $('billing-portal').classList.remove('hidden');
    return;
  }

  if (status.planId === 'custom') {
    $('billing-detail').textContent =
      'Custom planın yönetilen faturalama akışını kullanıyor.';
    return;
  }

  $('billing-detail').textContent =
    status.planId === 'free'
      ? 'İhtiyacına göre Plus veya Pro planına geçebilirsin.'
      : status.planId.toUpperCase() + ' planı aktif.';

  if (status.planId === 'free') {
    $('upgrade-plus').classList.remove('hidden');
    $('upgrade-pro').classList.remove('hidden');
  }
}

async function loadBilling(snapshot) {
  const panel = $('billing-panel');
  if (FREE_ONLY_MODE) {
    panel.classList.remove('hidden');
    $('upgrade-plus').classList.add('hidden');
    $('upgrade-pro').classList.add('hidden');
    $('billing-portal').classList.add('hidden');
    $('prepaid-packs').classList.add('hidden');
    $('billing-detail').textContent =
      snapshot?.billingMode === 'free' && snapshot.usage?.monthlyCredits === null
        ? 'Sahip hesabı: MCP tool kullanım kotası sınırsız. Ödeme kapalı.'
        : 'Herkese ücretsiz: ayda 1.000 ağırlıklı tool çağrısı. Normal çağrı 1, özel skill çağrısı 5 birim. Ödeme kapalı.';
    return;
  }
  panel.classList.add('hidden');

  const response = await fetch('/api/v1/billing/status', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 503) {
    return;
  }
  if (response.status === 401) {
    return;
  }
  if (!response.ok) {
    throw new Error('Billing HTTP ' + response.status);
  }
  renderBilling(await response.json());
}

async function startCheckout(planId) {
  if (FREE_ONLY_MODE) return;
  setBillingBusy(true);
  try {
    const response = await fetch(
      '/api/v1/billing/checkout',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planId }),
      },
    );
    const body = await response.json();
    if (response.status === 409 &&
        body.error === 'BILLING_PORTAL_REQUIRED') {
      await openBillingPortal();
      return;
    }
    if (!response.ok || typeof body.url !== 'string') {
      throw new Error(
        body.error || 'Checkout açılamadı.',
      );
    }
    window.location.assign(body.url);
  } catch (error) {
    $('billing-detail').textContent =
      error instanceof Error
        ? error.message
        : String(error);
    setBillingBusy(false);
  }
}

async function startPrepaidCheckout(variantId) {
  if (FREE_ONLY_MODE) return;
  setBillingBusy(true);
  try {
    const response = await fetch(
      '/api/v1/billing/prepaid/checkout',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ variantId }),
      },
    );
    const body = await response.json();
    if (!response.ok || typeof body.url !== 'string') {
      throw new Error(
        body.error || 'Kredi checkout açılamadı.',
      );
    }
    window.location.assign(body.url);
  } catch (error) {
    $('billing-detail').textContent =
      error instanceof Error
        ? error.message
        : String(error);
    setBillingBusy(false);
  }
}

async function openBillingPortal() {
  if (FREE_ONLY_MODE) return;
  setBillingBusy(true);
  try {
    const response = await fetch(
      '/api/v1/billing/portal',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      },
    );
    const body = await response.json();
    if (!response.ok || typeof body.url !== 'string') {
      throw new Error(
        body.error || 'Abonelik portalı açılamadı.',
      );
    }
    window.location.assign(body.url);
  } catch (error) {
    $('billing-detail').textContent =
      error instanceof Error
        ? error.message
        : String(error);
    setBillingBusy(false);
  }
}

function render(snapshot) {
  $('welcome').textContent = snapshot.displayName
    ? 'Merhaba, ' + snapshot.displayName
    : 'Nexowire hesabın';

  $('plan').textContent = snapshot.planId.toUpperCase();
  $('plan-detail').textContent = snapshot.privateControlsIncluded
    ? 'Özel ekran / klavye / pointer dahil'
    : 'Temel özellikler';

  const usage = snapshot.usage;
  if (usage.monthlyCredits !== null) {
    const usageLabel =
      formatNumber(usage.usedCredits) + ' / ' +
      formatNumber(usage.monthlyCredits);
    // Explain why tools stop running when a lower Free limit is applied
    // to an account that may already have more credits used this month.
    $('usage').textContent =
      FREE_ONLY_MODE && usage.usedCredits >= usage.monthlyCredits
        ? usageLabel + ' · Kota doldu. Yenilenme: ' +
          nextUtcPeriodStart() + ' 00:00 UTC'
        : usageLabel;
    const percent = Math.min(
      100,
      Math.round((usage.usedCredits / usage.monthlyCredits) * 100),
    );
    $('usage-bar').style.width = percent + '%';
  } else if (snapshot.billingMode === 'free') {
    $('usage').textContent = 'Sınırsız · ' + formatNumber(usage.usedCredits) + ' birim kullanıldı';
    $('usage-bar').style.width = '0%';
  } else {
    const remaining = usage.prepaidCredits ?? 0;
    $('usage').textContent = formatNumber(remaining) + ' kredi';
    $('usage-bar').style.width = '0%';
  }

  const online = snapshot.devices.filter((d) => d.online).length;
  $('devices-count').textContent = String(snapshot.devices.length);
  $('devices-detail').textContent = online + ' online';

  const stability = snapshot.stability;
  $('stability').textContent =
    stability.successRate === null
      ? '—'
      : stability.successRate.toFixed(2) + '%';
  $('latency').textContent =
    stability.medianLatencyMs === null
      ? 'Latency verisi yok'
      : 'Medyan ' + Math.round(stability.medianLatencyMs) + ' ms';

  const root = $('devices');
  root.textContent = '';
  if (!snapshot.devices.length) {
    root.innerHTML = '<div class="empty">Henüz bağlı cihaz yok.</div>';
  } else {
    for (const device of snapshot.devices) {
      const row = document.createElement('article');
      row.className = 'device';
      row.innerHTML = `
        <div>
          <div class="device-name"></div>
          <small class="platform"></small>
        </div>
        <div class="status">
          <span class="dot"></span>
          <span class="status-text"></span>
        </div>
        <small class="last-seen"></small>
      `;
      row.querySelector('.device-name').textContent = device.name;
      row.querySelector('.platform').textContent = device.platform;
      row.querySelector('.dot').classList.toggle('online', device.online);
      row.querySelector('.status-text').textContent =
        device.online ? 'Online' : 'Offline';
      row.querySelector('.last-seen').textContent =
        device.lastSeenAt ?? 'Henüz görülmedi';
      root.appendChild(row);
    }
  }

  $('connect-device').disabled = false;
  setPill('Bağlı', 'good');
}

async function load() {
  $('error-panel').classList.add('hidden');
  $('login').classList.add('hidden');
  setPill('Bağlanıyor', 'muted');

  try {
    const response = await fetch('/api/v1/me/dashboard', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401) {
      setPill('Oturum yok', 'muted');
      $('error-message').textContent =
        'Dashboard için hesabınla giriş yap.';
      $('login').classList.remove('hidden');
      $('error-panel').classList.remove('hidden');
      return;
    }
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const snapshot = await response.json();
    render(snapshot);
    try {
      await loadBilling(snapshot);
    } catch (billingError) {
      $('billing-panel').classList.remove('hidden');
      $('billing-detail').textContent =
        billingError instanceof Error
          ? billingError.message
          : String(billingError);
    }
  } catch (error) {
    setPill('Offline', 'bad');
    $('error-message').textContent =
      error instanceof Error ? error.message : String(error);
    $('error-panel').classList.remove('hidden');
  }
}

$('retry').addEventListener('click', load);
$('login').addEventListener('click', () => {
  window.location.href =
    '/auth/github/start?next=' +
    encodeURIComponent(window.location.pathname);
});
$('connect-device').addEventListener('click', () => {
  window.location.href = '/connect.html';
});
$('upgrade-plus').addEventListener('click', () => {
  void startCheckout('plus');
});
$('upgrade-pro').addEventListener('click', () => {
  void startCheckout('pro');
});
$('billing-portal').addEventListener('click', () => {
  void openBillingPortal();
});

load();
