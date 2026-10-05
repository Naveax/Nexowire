const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const callbackRaw = params.get('callback') ?? '';
const state = params.get('state') ?? '';
const deviceId = params.get('deviceId') ?? '';
const deviceName = params.get('deviceName') ?? '';
const platform = params.get('platform') ?? '';

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
    $('device-name').textContent = 'Nexowire uygulaması gerekli';
    $('platform').textContent = 'Bu sayfayı uygulamadaki BAĞLA düğmesi açar.';
    $('status-title').textContent = 'Bağlantı isteği yok';
    $('status-text').textContent =
      'Nexowire uygulamasını açıp BAĞLA düğmesine bas.';
    setPill('Bekleniyor', 'muted');
    return;
  }

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
