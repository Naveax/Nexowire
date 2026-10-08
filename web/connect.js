const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const callbackRaw = params.get('callback') ?? '';
const state = params.get('state') ?? '';
const deviceId = params.get('deviceId') ?? '';
const deviceName = params.get('deviceName') ?? '';
const platform = params.get('platform') ?? '';
const RELEASE = 'https://github.com/Naveax/Nexowire/releases/download/v1.0.5/';
const ARCHIVE = RELEASE + 'nexowire-1.0.5.tgz';

function detectedOS(ua = navigator.userAgent) {
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os|iphone|ipad/i.test(ua)) return 'macos';
  return 'linux';
}

const installers = {
  windows: {
    heading: 'Windows kurulumu',
    description: 'Resmî Nexowire v1.0.5 Windows kurulum dosyasını indir, çalıştır ve uygulamadaki BAĞLA düğmesini kullan.',
    command: "Invoke-WebRequest -Uri '" + RELEASE + "Nexowire-Setup.cmd' -OutFile \"$env:USERPROFILE\\Downloads\\Nexowire-Setup.cmd\"",
    url: RELEASE + 'Nexowire-Setup.cmd',
    label: 'Windows kurulumunu indir ↗',
    checksum: RELEASE + 'SHA256SUMS-Windows',
    note: 'Komut yalnızca indirir; güvenliğin için tarayıcıdan sessiz komut çalıştırılmaz. Dosyayı çalıştırmadan önce SHA-256 değerini doğrula.',
  },
  macos: {
    heading: 'macOS kurulumu',
    description: 'Node.js 22 veya üzeri ve npm gerekli. Resmî arşivden CLI kurulumu sonrası Nexowire bağlantı akışını başlat.',
    command: 'npm install -g ' + ARCHIVE + ' && nexowire connect',
    url: ARCHIVE,
    label: 'Resmî CLI arşivi ↗',
    checksum: RELEASE + 'SHA256SUMS',
    note: 'macOS için tek tıklamalı kurulum paketi henüz doğrulanmış değil. Terminal komutunu yalnızca kendi cihazında çalıştır.',
  },
  linux: {
    heading: 'Linux kurulumu',
    description: 'Node.js 22 veya üzeri ve npm gerekli. Resmî arşivden CLI kurulumu sonrası Nexowire bağlantı akışını başlat.',
    command: 'npm install -g ' + ARCHIVE + ' && nexowire connect',
    url: ARCHIVE,
    label: 'Resmî CLI arşivi ↗',
    checksum: RELEASE + 'SHA256SUMS',
    note: 'Linux için tek tıklamalı kurulum paketi henüz doğrulanmış değil. Terminal komutunu yalnızca kendi cihazında çalıştır.',
  },
};

function selectInstallOS(os) {
  const selected = installers[os] ? os : 'windows';
  const setup = installers[selected];
  for (const tab of document.querySelectorAll('.os-tabs [role="tab"]')) {
    const active = tab.dataset.os === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $('install-heading').textContent = setup.heading;
  $('install-description').textContent = setup.description;
  $('install-command').value = setup.command;
  $('download-installer').href = setup.url;
  $('download-installer').textContent = setup.label;
  $('verify-installer').href = setup.checksum;
  $('install-note').textContent = setup.note;
  $('copy-status').textContent = '';
}
for (const tab of document.querySelectorAll('.os-tabs [role="tab"]')) {
  tab.addEventListener('click', () => selectInstallOS(tab.dataset.os));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const names = Object.keys(installers);
    const index = names.indexOf(tab.dataset.os);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
    selectInstallOS(names[next]);
    document.getElementById('tab-' + names[next]).focus();
  });
}
$('copy-command').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('install-command').value);
    $('copy-status').textContent = 'Komut kopyalandı.';
  } catch {
    $('install-command').focus();
    $('install-command').select();
    $('copy-status').textContent = 'Kopyalama engellendi. Komutu seçip Ctrl+C veya Cmd+C ile kopyala.';
  }
});
selectInstallOS(detectedOS());

function setPill(text, stateClass) {
  const pill = $('connect-pill');
  pill.textContent = text;
  pill.className = 'pill ' + stateClass;
}

function showError(message, retryable = false) {
  setPill('Hata', 'bad');
  $('error-message').textContent = message;
  $('error-panel').classList.remove('hidden');
  const approve = $('approve');
  approve.disabled = !retryable;
  approve.textContent = retryable ? 'TEKRAR DENE' : 'BAĞLA';
  approve.dataset.busy = 'false';
}

function validatedLoopbackCallback() {
  if (!callbackRaw || !state || !deviceId || !deviceName) {
    return null;
  }

  let url;
  try {
    url = new URL(callbackRaw);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/nexowire-connect' ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return url;
}

async function loadAccount() {
  const callback = validatedLoopbackCallback();
  if (!callback) {
    $('install-panel').classList.remove('hidden');
    $('pair-panel').classList.add('hidden');
    setPill('Kurulum', 'muted');
    return;
  }
  $('install-panel').classList.add('hidden');
  $('pair-panel').classList.remove('hidden');

  $('device-name').textContent = deviceName;
  $('platform').textContent = platform || 'Cihaz';

  const response = await fetch('/api/v1/me/dashboard', {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  if (response.status === 401) {
    const next =
      window.location.pathname + window.location.search;
    window.location.replace(
      '/auth/github/start?next=' + encodeURIComponent(next),
    );
    return;
  }

  if (!response.ok) {
    throw new Error('Hesap doğrulanamadı. Lütfen tekrar dene.');
  }

  $('status-title').textContent = 'Hazır';
  $('status-text').textContent =
    'Ekstra erişim ayarı gerekmez. BAĞLA dediğinde cihaz hesabına eklenir ve bağlantı otomatik hazırlanır.';
  $('approve').disabled = false;
  setPill('Hazır', 'good');

  $('approve').addEventListener('click', async () => {
    const approve = $('approve');
    if (approve.dataset.busy === 'true') return;

    approve.dataset.busy = 'true';
    approve.disabled = true;
    approve.textContent = 'BAĞLANIYOR…';
    $('error-panel').classList.add('hidden');
    setPill('Bağlanıyor', 'muted');
    $('status-title').textContent = 'Bağlanıyor';
    $('status-text').textContent =
      'Başka bir ayar yapmana gerek yok.';

    try {
      const pairing = await fetch('/api/v1/pairing', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ deviceName, deviceId }),
      });

      if (!pairing.ok) {
        const body = await pairing.json().catch(() => ({}));
        if (pairing.status === 403) {
          throw new Error(
            body.error === 'DEVICE_LIMIT_REACHED'
              ? 'Bu hesap için cihaz limiti dolu.'
              : 'Bu cihaz bu hesaba bağlanamadı.',
          );
        }
        throw new Error('Bağlantı hazırlanamadı.');
      }

      const body = await pairing.json();
      if (
        typeof body.pairingId !== 'string' ||
        typeof body.token !== 'string'
      ) {
        throw new Error('Bağlantı cevabı geçersiz.');
      }

      callback.searchParams.set('state', state);
      callback.searchParams.set('pairing_id', body.pairingId);
      callback.searchParams.set('token', body.token);
      window.location.replace(callback.toString());
    } catch (error) {
      showError(
        error instanceof Error ? error.message : String(error),
        true,
      );
      $('status-title').textContent = 'Tekrar deneyebilirsin';
      $('status-text').textContent =
        'Ayarları değiştirmen gerekmez.';
    }
  });
}

loadAccount().catch((error) => {
  showError(
    error instanceof Error ? error.message : String(error),
    false,
  );
});
