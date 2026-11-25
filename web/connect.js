const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const callbackRaw = params.get('callback') ?? '';
const state = params.get('state') ?? '';
const deviceId = params.get('deviceId') ?? '';
const deviceName = params.get('deviceName') ?? '';
const platform = params.get('platform') ?? '';
// Pin the verified published stable installer assets, not an archived source-tree bootstrap.
// Update this alongside the release asset snapshot and installation contracts.
const INSTALLER_RELEASE_ASSETS = 'https://github.com/Naveax/Nexowire/releases/download/v1.0.8/';
const RELEASE_PAGE = 'https://github.com/Naveax/Nexowire/releases/latest';
let chatgptAddress = '';

/*
 * CORE is not equivalent to account pairing, a running Broker or a dashboard
 * toggle. The deployed independent OS verifier must be separately reviewed
 * before this interface may advertise READY_VERIFIED.
 */
const CORE_INDEPENDENT_VERIFIER_INSTALLED = false;
const CORE_STATUS_MESSAGES = Object.freeze({
  NOT_INSTALLED: [
    'CORE bileşeninin kurulu olmadığı doğrulandı. Önce resmî kurucuyu kullan.',
    'CORE is confirmed not installed. Use the official installer first.',
  ],
  PERMISSION_REQUIRED: [
    'Bu bilgisayardaki cihaz sahibinin Windows yönetici/UAC onayı gerekiyor. Uzaktan onay verilemez.',
    'The device owner must approve the Windows administrator/UAC prompt locally. Remote approval does not count.',
  ],
  AWAITING_PHYSICAL_ACCEPTANCE: [
    'CORE onay isteği kaydedildi, ancak cihaza ulaştığı veya yerel Windows onayı henüz doğrulanmadı. Aynı isteği yeniden gönderme.',
    'A CORE consent request is recorded, but delivery to the PC and local Windows approval are unverified. Do not resend it.'
  ],
  REVOKED_LOCALLY: [
    'CORE erişimi bu cihazda yerel olarak iptal edildi. Yeni bir açık yerel onay gerekir.',
    'CORE access was revoked locally on this PC. Fresh local consent is required.',
  ],
  BROKER_RUNNING_BUT_UNVERIFIED: [
    'Broker çalışıyor görünebilir; bağımsız Windows yetki ve gerçek işlem doğrulaması yok. CORE hazır değil.',
    'The Broker may appear to be running, but independent Windows authority and real effect are unverified. CORE is not ready.',
  ],
  READY_VERIFIED: [
    'Bağımsız yerel Windows onayı ve güncel fiziksel CORE durumu doğrulandı. Yetkili işlemlerde Broker denetimi sürer.',
    'Independent local Windows consent and fresh physical CORE status are verified. Broker checks still apply to privileged actions.',
  ],
  UNKNOWN: [
    'CORE durumu doğrulanamadı. Eşleştirme, yönetici yetkisi veya CORE erişimi kanıtlamaz.',
    'CORE status could not be verified. Pairing does not prove administrator rights or CORE access.',
  ],
});

function coreStatusFromDashboard(dashboard) {
  const devices = Array.isArray(dashboard?.devices) ? dashboard.devices : [];
  // Duplicate or unmatched IDs cannot identify one trustworthy target.
  const matched = devices.filter((entry) => entry && entry.id === deviceId);
  if (matched.length !== 1) return 'UNKNOWN';
  const device = matched[0];
  const physical = device.physicalConsole;
  // Only explicit source-of-truth negatives produce specific negative statuses.
  if (device.installationStatus === 'NOT_INSTALLED') return 'NOT_INSTALLED';
  if (physical?.state === 'REVOKED_LOCALLY') return 'REVOKED_LOCALLY';
  if (physical?.permissionRequired === true) return 'PERMISSION_REQUIRED';
  if (physical?.enrollmentRequested === true && physical?.localEnrolled !== true) {
    return 'AWAITING_PHYSICAL_ACCEPTANCE';
  }

  const age = Date.now() - physical?.observedAtMs;
  if (CORE_INDEPENDENT_VERIFIER_INSTALLED &&
      dashboard?.corePhysicalStatusVerifierInstalled === true &&
      device.platform === 'win32' && device.online === true &&
      device.accessMode === 'full' && device.privilegeMode === 'broker' &&
      device.adminBridgeReady === true && device.persistentMaintenance?.enabled === true &&
      physical?.deviceReady === true && physical?.localEnrolled === true &&
      physical?.active === true && Number.isFinite(age) && age >= 0 && age < 15000) {
    return 'READY_VERIFIED';
  }
  // A stored broker configuration on an offline device does not prove a running broker.
  if (device.platform === 'win32' && device.online === true &&
      (device.privilegeMode === 'broker' || device.adminBridgeReady === true)) {
    return 'BROKER_RUNNING_BUT_UNVERIFIED';
  }
  return 'UNKNOWN';
}

function renderCoreStatus(code) {
  const status = Object.hasOwn(CORE_STATUS_MESSAGES, code) ? code : 'UNKNOWN';
  const [tr, en] = CORE_STATUS_MESSAGES[status];
  $('core-status-code').textContent = status;
  $('core-status-code').className =
    'pill ' + (status === 'READY_VERIFIED' ? 'good'
      : status === 'REVOKED_LOCALLY' ? 'bad' : 'muted');
  $('core-status-tr').textContent = tr;
  $('core-status-en').textContent = en;
}


function detectedOS(ua = navigator.userAgent) {
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os|iphone|ipad/i.test(ua)) return 'macos';
  return 'linux';
}

const installers = {
  windows: {
    heading: 'Windows kurulumu',
    description: 'Windows 10/11 x64: resmî GitHub Release kurucusunu indir ve dosyaya çift tıkla. Node.js, npm, Git veya PowerShell 7 gerekmez. Tarayıcıda giriş yapıp BAĞLA’ya bas.',
    command: "Invoke-WebRequest -Uri '" + INSTALLER_RELEASE_ASSETS + "Nexowire-Setup.cmd' -OutFile \"$env:USERPROFILE\\Downloads\\Nexowire-Setup.cmd\"",
    url: INSTALLER_RELEASE_ASSETS + 'Nexowire-Setup.cmd',
    label: 'Windows kurucusunu aç ↗',
    checksum: INSTALLER_RELEASE_ASSETS + 'SHA256SUMS-Windows',
    note: 'Resmî v1.0.8 GitHub Release kurucusu ve aynı yayının SHA256SUMS-Windows dosyası kullanılır. SHA-256 bütünlük kontrolüdür, yayıncı imzası değildir. İstersen kopyalama düğmesiyle yalnızca indirme komutunu alabilirsin.',
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
    : 'Önce Nexowire uygulamasından eşleştirme sonucunu kontrol et. Yeniden bağlamak gerekiyorsa yeni oturumu yerel uygulamadan başlat; bu isteği otomatik tekrarlama.';
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

// A local native pairing session has a fresh 256-bit random state. Derive the
// same opaque operation identity in every browser profile, without persisting
// the raw callback state, URL, pairing ID or token. The server must separately
// enforce this identity; the browser fence is only same-origin/profile.
async function pairingMutationIdentity(localState) {
  const digest=await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('nexowire-pairing-v1\u0000'+localState));
  return 'pairing-v1:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function pairingFenceKey(mutationId) {
  return 'nexowire-pairing-uncertain-v1:'+mutationId;
}

function pairingFenceAvailable() {
  return typeof navigator.locks?.request==='function'&&typeof crypto?.subtle?.digest==='function';
}

async function pairingMutationStatus(mutationId) {
  try {
    const response=await fetch('/api/v1/me/mutations/status?mutationId='+encodeURIComponent(mutationId),{
      credentials:'include',headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(response.redirected===true)return 'UNKNOWN';
    if(response.status===404){const body=await response.json();return body?.error==='MUTATION_NOT_FOUND'?'NOT_FOUND':'UNKNOWN'}
    if(response.status!==200)return 'UNKNOWN';
    const result=await response.json();
    if(result?.mutationId!==mutationId||result.deviceId!==deviceId||
       result.kind!=='pairing'||result.expectedRevision!==null||
       !['APPLIED','DENIED','PENDING'].includes(result.state))return 'UNKNOWN';
    return result.state;
  }catch{return 'UNKNOWN'}
}
function pairingReceiptCopy(result) {
  if(result==='APPLIED')return ' Sunucu D1 işlem kaydı: APPLIED. Yalnız eşleştirme isteği oluşturuldu; cihaz bağlantısı doğrulanmadı.';
  if(result==='DENIED')return ' Sunucu D1 işlem kaydı: DENIED. İstek kabul edilmedi.';
  if(result==='PENDING')return ' Sunucu D1 işlem kaydı: PENDING. Sonuç belirsiz.';
  return '';
}
function blockPairingReplay(result='UNKNOWN') {
  showError('Bu eşleştirme oturumunun sonucu belirsiz veya tarayıcı işlem koruması doğrulanamadı. Önce yerel uygulamadaki sonucu kontrol et; aynı oturumu tekrar gönderme.'+pairingReceiptCopy(result),false);
  $('status-title').textContent='Bağlantı durduruldu';
  $('status-text').textContent='Hata açıklamasını kontrol et.';
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
  setPill('Hesap kontrol ediliyor', 'muted');
  $('pair-panel').classList.remove('hidden');

  $('device-name').textContent = deviceName;
  $('platform').textContent = platform || 'Cihaz';

  const response = await fetch('/api/v1/me/dashboard', {
    credentials: 'include',
    headers: { accept: 'application/json' },
    cache:'no-store',
    signal: AbortSignal.timeout(8000),
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

  // A pairing dashboard is not evidence of local CORE approval.
  let dashboard = null;
  try {
    if (typeof response.json === 'function') dashboard = await response.json();
  } catch {
    // An unreadable or absent optional dashboard body must never invent CORE authority.
  }
  renderCoreStatus(coreStatusFromDashboard(dashboard));
  let mutationId;
  try {
    if(!pairingFenceAvailable())throw Error('Pairing guard unavailable');
    mutationId=await pairingMutationIdentity(state);
    const attempted=localStorage.getItem(pairingFenceKey(mutationId))!==null;
    const result=await pairingMutationStatus(mutationId);
    // A missing record is not permission to retry an attempted local session.
    // A new explicitly opened session can proceed to server atomic admission.
    if(attempted||result!=='NOT_FOUND'){blockPairingReplay(result);return}
  }catch{
    blockPairingReplay();return;
  }
  $('status-title').textContent = 'Eşleştirmeye hazır';
  $('status-text').textContent =
    'Hesap eşleştirmesi için ekstra erişim ayarı gerekmez. BAĞLA yalnızca cihazını hesabına ekler. CORE yetkisi için cihaz sahibinin yerel Windows onayı ayrıca gerekir.';
  $('approve').disabled = false;
  $('pair-panel').setAttribute('aria-busy', 'false');
  setPill('Eşleştirmeye hazır', 'muted');

  let pairingOutcomeUncertain = false;
  $('approve').addEventListener('click', async () => {
    const approve = $('approve');
    if (approve.dataset.busy === 'true' || approve.disabled || pairingOutcomeUncertain) return;

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

    let retryable = false;
    let visibleError = '';
    try {
      const key=pairingFenceKey(mutationId);
      // The durable marker is written under a shared exclusive lock BEFORE
      // the request. Neither a reload nor another tab may blindly repeat it.
      // A new locally initiated session uses a different mutation identity.
      const claimed=await navigator.locks.request(key,{mode:'exclusive',ifAvailable:true},lock=>{
        if(!lock||localStorage.getItem(key)!==null)return false;
        localStorage.setItem(key,'attempted');
        return localStorage.getItem(key)==='attempted';
      });
      if(!claimed){pairingOutcomeUncertain=true;blockPairingReplay(await pairingMutationStatus(mutationId));return}
      // Even a success response is not proof that the local callback consumed
      // the challenge. Never clear the marker or replay a token on reload.
      pairingOutcomeUncertain = true;
      const pairing = await fetch('/api/v1/pairing', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-Nexowire-Mutation-Id': mutationId,
        },
        body: JSON.stringify({ deviceName, deviceId }),
      });

      if (!pairing.ok) {
        const body = await pairing.json().catch(() => ({}));
        if (pairing.status === 409 && typeof body?.error === 'string' && body.error.startsWith('DASHBOARD_MUTATION_')) {
          visibleError='Sunucu eşleştirme işleminin tekrarını veya çakışmasını reddetti. Yerel uygulamadaki sonucu kontrol et.';
          throw new Error('Bağlantı hazırlanamadı.');
        }
        if (pairing.status === 401) {
          retryable = false;
          visibleError = 'Oturumun sona erdi. GitHub ile yeniden giriş yapıp bağlantıyı dene.';
          throw new Error('Oturum sona erdi.');
        }
        if (pairing.status === 429) {
          const retryAfter = pairing.headers.get('retry-after');
          const seconds = retryAfter !== null && /^[1-9][0-9]{0,3}$/.test(retryAfter)
            ? Number(retryAfter) : null;
          const wait = seconds !== null && seconds <= 3600
            ? `${seconds} saniye bekle.` : 'Biraz bekle.';
          visibleError = 'Çok fazla bağlantı isteği. ' + wait + ' Sonucu yerel uygulamada kontrol et; gerekiyorsa yeni yerel oturum başlat.';
          throw new Error('İstek sınırına ulaşıldı.');
        }
        if (pairing.status === 503) {
          // Do not echo upstream 503 payloads; preserve a safe retry path.
          visibleError = 'Bağlantı sonucu belirsiz (HTTP 503). Önce Nexowire uygulamasındaki eşleştirmeyi kontrol et; aynı isteği körlemesine yineleme.';
          throw new Error('Servis geçici olarak kullanılamıyor.');
        }
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
        typeof body.pairingId !== 'string' || !body.pairingId.trim() ||
        typeof body.token !== 'string' || !body.token.trim()
      ) {
        throw new Error('Bağlantı cevabı geçersiz.');
      }

      callback.searchParams.set('state', state);
      callback.searchParams.set('pairing_id', body.pairingId);
      callback.searchParams.set('token', body.token);
      window.location.replace(callback.toString());
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      const known = new Set([
        'Bağlantı hazırlanamadı.', 'Bağlantı cevabı geçersiz.',
        'Bu hesap için cihaz limiti dolu.', 'Bu cihaz bu hesaba bağlanamadı.',
      ]);
      const receipt=pairingOutcomeUncertain?await pairingMutationStatus(mutationId):'UNKNOWN';
      showError((visibleError || (known.has(rawMessage) ? rawMessage : 'Beklenmeyen bağlantı hatası. Bağlantı sonucu belirsiz. Önce yerel uygulamadaki sonucu kontrol et; tekrar istek gönderme.'))+pairingReceiptCopy(receipt), retryable);
      $('status-title').textContent = retryable ? 'Tekrar deneyebilirsin' : 'Bağlantı durduruldu';
      $('status-text').textContent =
        retryable ? 'Ayarları değiştirmen gerekmez.' : 'Hata açıklamasını kontrol et.';
    }
  });
}

renderCoreStatus('UNKNOWN');
const accountLoad = loadAccount().catch(() => {
  $('status-title').textContent = 'Hesap doğrulanamadı';
  $('status-text').textContent = 'Sayfayı yenilemeden önce bağlantını kontrol et.';
  showError('Hesap doğrulanamadı. Bağlantıyı kontrol edip yeniden dene.', false);
});
