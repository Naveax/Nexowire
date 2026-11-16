const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const callbackRaw = params.get('callback') ?? '';
const state = params.get('state') ?? '';
const deviceId = params.get('deviceId') ?? '';
const deviceName = params.get('deviceName') ?? '';
const platform = params.get('platform') ?? '';
// Pin the already tested Unicode-safe bootstrap; branch cleanup must not break downloads.
const INSTALLER_REF = '96315d5dd4986fffbd24a96859309271d2a88ffe';
const INSTALLER_VIEW = 'https://github.com/Naveax/Nexowire/blob/' + INSTALLER_REF + '/installers/';
const INSTALLER_RAW = 'https://raw.githubusercontent.com/Naveax/Nexowire/' + INSTALLER_REF + '/installers/';
const RELEASE_PAGE = 'https://github.com/Naveax/Nexowire/releases/latest';
let chatgptAddress = '';

function detectedOS(ua = navigator.userAgent) {
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os|iphone|ipad/i.test(ua)) return 'macos';
  return 'linux';
}

const installers = {
  windows: {
    heading: 'Windows kurulumu',
    description: 'Windows 10/11 x64: açılan GitHub sayfasında Download raw ile indir ve dosyaya çift tıkla. Node.js, npm, Git veya PowerShell 7 gerekmez. Tarayıcıda giriş yapıp BAĞLA’ya bas.',
    command: "Invoke-WebRequest -Uri '" + INSTALLER_RAW + "Nexowire-Setup.cmd' -OutFile \"$env:USERPROFILE\\Downloads\\Nexowire-Setup.cmd\"",
    url: INSTALLER_VIEW + 'Nexowire-Setup.cmd',
    label: 'Windows kurucusunu aç ↗',
    checksum: INSTALLER_VIEW + 'SHA256SUMS-Windows',
    note: 'Depodaki düzeltilmiş kurucu, yayımlanmış v1.0.7 paketini doğrulayarak kullanır. Yönetici olarak çalıştırman gerekmez. İstersen kopyalama düğmesiyle yalnızca indirme komutunu alabilirsin.',
  },
  macos: {
    heading: 'macOS kurulumu',
    description: 'Bu kolay kurulum Windows x64 içindir. macOS için geliştirici ve kendi sunucunu kurma kılavuzunu kullan.',
    command: '',
    url: 'https://github.com/Naveax/Nexowire/blob/main/docs/SELF_HOST.md',
    label: 'macOS geliştirici kılavuzu ↗',
    checksum: RELEASE_PAGE,
    note: 'Windows kurucusunu macOS’ta çalıştırma. Windows bağlantı komutu burada otomatik eşleme sağlamaz.',
  },
  linux: {
    heading: 'Linux kurulumu',
    description: 'Bu kolay kurulum Windows x64 içindir. Linux için geliştirici ve kendi sunucunu kurma kılavuzunu kullan.',
    command: '',
    url: 'https://github.com/Naveax/Nexowire/blob/main/docs/SELF_HOST.md',
    label: 'Linux geliştirici kılavuzu ↗',
    checksum: RELEASE_PAGE,
    note: 'Windows kurucusunu Linux’ta çalıştırma. Windows bağlantı komutu burada otomatik eşleme sağlamaz.',
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
  $('install-command').closest('.install-command-row').classList.toggle('hidden', !setup.command);
  document.querySelector('label[for="install-command"]').classList.toggle('hidden', !setup.command);
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

async function loadChatGPTSetup() {
  chatgptAddress = '';
  let httpStatus = 0;
  $('chatgpt-address').value = '';
  $('copy-chatgpt-address').disabled = true;
  try {
    const response = await fetch('/.well-known/oauth-protected-resource', {
      credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    httpStatus = response.status;
    if (!response.ok || response.redirected ||
        !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error();
    const metadata = await response.json();
    if (typeof metadata.resource !== 'string' || metadata.resource.length > 2048 ||
        !Array.isArray(metadata.authorization_servers) ||
        !metadata.authorization_servers.includes(window.location.origin)) throw new Error();
    const url = new URL(metadata.resource);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    chatgptAddress = url.href;
    $('chatgpt-address').value = chatgptAddress;
    $('copy-chatgpt-address').disabled = false;
    $('chatgpt-status').textContent = 'Bu adresi ChatGPT’deki sunucu alanına yapıştır. Kimlik doğrulama: OAuth.';
  } catch (error) {
    $('chatgpt-status').textContent = error?.name === 'TimeoutError'
      ? 'Bağlantı adresi 5 saniye içinde alınamadı. Sayfayı yenile; sunucu adresini tahmin etme.'
      : error?.name === 'AbortError'
      ? 'Bağlantı adresi isteği durduruldu. Yeniden denemek için sayfayı yenile.'
      : httpStatus >= 400
      ? 'Bağlantı adresi alınamadı (HTTP ' + httpStatus + '). Hizmete erişimi kontrol et; Windows kurulumunu tekrarlama.'
      : 'Bağlantı adresi alınamadı. Sayfayı yenile veya bağlantı bilgisini aç. Rastgele adresle ilerleme.';
  }
}
$('copy-chatgpt-address').addEventListener('click', async () => {
  if (!chatgptAddress) return;
  try {
    await navigator.clipboard.writeText(chatgptAddress);
    $('chatgpt-status').textContent = 'Adres kopyalandı. ChatGPT’de OAuth seçerek devam et.';
  } catch {
    $('chatgpt-address').focus(); $('chatgpt-address').select();
    $('chatgpt-status').textContent = 'Adresi seçip Ctrl+C veya Cmd+C ile kopyala.';
  }
});

function setPill(text, stateClass) {
  const pill = $('connect-pill');
  pill.textContent = text;
  pill.className = 'pill ' + stateClass;
}

function showError(message, retryable = false) {
  setPill('Hata', 'bad');
  $('error-message').textContent = message;
  $('error-panel').classList.remove('hidden');
  $('pair-panel').setAttribute('aria-busy', 'false');
  const approve = $('approve');
  approve.disabled = !retryable;
  approve.textContent = retryable ? 'TEKRAR DENE' : 'BAĞLA';
  approve.dataset.busy = 'false';
  $('retry-hint').textContent = retryable
    ? 'Tekrar denemek için TEKRAR DENE düğmesine bas.'
    : 'Bağlantıyı kontrol ettikten sonra bu sayfayı yenile veya kontrol paneline dön.';
  if (retryable) {
    approve.setAttribute('aria-describedby', 'error-message retry-hint');
    approve.focus();
  } else {
    approve.removeAttribute('aria-describedby');
    $('error-panel').focus();
  }
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
    void loadChatGPTSetup();
    return;
  }
  $('chatgpt-panel').classList.add('hidden');
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
  $('pair-panel').setAttribute('aria-busy', 'false');
  setPill('Hazır', 'good');

  $('approve').addEventListener('click', async () => {
    const approve = $('approve');
    if (approve.dataset.busy === 'true') return;

    approve.dataset.busy = 'true';
    approve.disabled = true;
    approve.textContent = 'BAĞLANIYOR…';
    approve.removeAttribute('aria-describedby');
    $('error-panel').classList.add('hidden');
    $('pair-panel').setAttribute('aria-busy', 'true');
    setPill('Bağlanıyor', 'muted');
    $('status-title').textContent = 'Bağlanıyor';
    $('status-text').textContent =
      'Başka bir ayar yapmana gerek yok.';

    let retryable = true;
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
          retryable = false;
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
        retryable,
      );
      $('status-title').textContent = retryable ? 'Tekrar deneyebilirsin' : 'Bağlantı durduruldu';
      $('status-text').textContent =
        retryable ? 'Ayarları değiştirmen gerekmez.' : 'Hata açıklamasını kontrol et.';
    }
  });
}

loadAccount().catch((error) => {
  $('status-title').textContent = 'Hesap doğrulanamadı';
  $('status-text').textContent = 'Sayfayı yenilemeden önce bağlantını kontrol et.';
  showError(
    error instanceof Error ? error.message : String(error),
    false,
  );
});
