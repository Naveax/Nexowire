const $ = (id) => document.getElementById(id);

function formatNumber(value) {
  return new Intl.NumberFormat('tr-TR').format(value);
}

function setPill(text, state) {
  const pill = $('connection-pill');
  pill.textContent = text;
  pill.className = 'pill ' + state;
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
    $('usage').textContent =
      formatNumber(usage.usedCredits) + ' / ' +
      formatNumber(usage.monthlyCredits);
    const percent = Math.min(
      100,
      Math.round((usage.usedCredits / usage.monthlyCredits) * 100),
    );
    $('usage-bar').style.width = percent + '%';
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
    render(await response.json());
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

load();
