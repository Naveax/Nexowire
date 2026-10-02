const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const callbackRaw = params.get('callback') ?? '';
const state = params.get('state') ?? '';
const deviceName = params.get('deviceName') ?? '';
const platform = params.get('platform') ?? '';

function setPill(text, stateClass) {
  const pill = $('connect-pill');
  pill.textContent = text;
  pill.className = 'pill ' + stateClass;
}

function showError(message) {
  setPill('Hata', 'bad');
  $('error-message').textContent = message;
  $('error-panel').classList.remove('hidden');
  $('approve').disabled = true;
}

function validatedLoopbackCallback() {
  if (!callbackRaw || !state || !deviceName) {
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
    $('platform').textContent = 'Bu sayfayı doğrudan açmak yerine uygulamada BAĞLA seç.';
    $('status-title').textContent = 'Bağlantı isteği yok';
    $('status-text').textContent =
      'Nexowire uygulaması güvenli bir localhost callback oluşturduğunda bu sayfa otomatik açılır.';
    setPill('Bekleniyor', 'muted');
    return;
  }

  $('device-name').textContent = deviceName;
  $('platform').textContent = platform || 'unknown';

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
    throw new Error('Hesap bilgisi alınamadı (HTTP ' + response.status + ').');
  }

  const dashboard = await response.json();
  $('plan').textContent = String(dashboard.planId ?? '—').toUpperCase();

  const usage = dashboard.usage ?? {};
  if (typeof usage.monthlyCredits === 'number') {
    $('usage').textContent =
      String(usage.usedCredits ?? 0) +
      ' / ' +
      String(usage.monthlyCredits) +
      ' kredi';
  } else {
    $('usage').textContent =
      String(usage.prepaidCredits ?? 0) +
      ' prepaid kredi';
  }

  $('status-title').textContent = 'Bağlantıya hazır';
  $('status-text').textContent =
    'BAĞLA dediğinde bu bilgisayar hesabına eklenir. Free hesaplarda aynı cihaz anchor kullanan yeni hesaplar aynı kotayı paylaşır.';
  $('approve').disabled = false;
  setPill('Hazır', 'good');

  $('approve').addEventListener('click', async () => {
    $('approve').disabled = true;
    setPill('Bağlanıyor', 'muted');
    $('status-title').textContent = 'Cihaz kaydı hazırlanıyor';

    try {
      const pairing = await fetch('/api/v1/pairing', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ deviceName }),
      });

      if (!pairing.ok) {
        const body = await pairing.json().catch(() => ({}));
        if (pairing.status === 403) {
          throw new Error(
            body.error === 'DEVICE_LIMIT_REACHED'
              ? 'Bu planın cihaz limiti dolmuş.'
              : 'Bu hesap bu cihazı bağlayamıyor.',
          );
        }
        throw new Error(
          'Pairing oluşturulamadı (HTTP ' +
            pairing.status +
            ').',
        );
      }

      const body = await pairing.json();
      if (
        typeof body.pairingId !== 'string' ||
        typeof body.token !== 'string'
      ) {
        throw new Error('Pairing cevabı geçersiz.');
      }

      callback.searchParams.set('state', state);
      callback.searchParams.set('pairing_id', body.pairingId);
      callback.searchParams.set('token', body.token);
      window.location.replace(callback.toString());
    } catch (error) {
      showError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, { once: true });
}

loadAccount().catch((error) => {
  showError(
    error instanceof Error ? error.message : String(error),
  );
});
