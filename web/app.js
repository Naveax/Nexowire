const $ = (id) => document.getElementById(id);
const formatNumber = (value) => new Intl.NumberFormat('tr-TR').format(value);
const FREE_ONLY_MODE = true;
const openPcSettings = new Set();

function nextUtcPeriodStart(now = new Date()) {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() + 1, 1,
  )).toISOString().slice(0, 10);
}

function setPill(label, tone) {
  const pill = $('connection-pill');
  pill.textContent = label;
  pill.className = 'pill ' + tone;
}

function explainApiError(code) {
  const labels = {
    ROOT_REQUIRES_FULL_ONLINE_DEVICE:
      'Önce cihazı FULL ACCESS moduna al ve çevrimiçi olduğundan emin ol.',
    ROOT_REQUIRES_FULL_ONLINE_BROKER:
      'Eski sunucu yapılandırması Broker istiyor. Sayfayı yenileyip tekrar dene.',
    ROOT_DANGER_CONFIRMATION_REQUIRED:
      'ROOT DANGER onay ifadesi doğrulanamadı.',
    ROOT_REQUIRES_OWNER_LOGIN:
      'Bu işlem için cihazın sahibi olan hesapla giriş yap.',
    DEVICE_NOT_FOUND: 'Cihaz bu hesaba bağlı değil.',
    UNAUTHENTICATED: 'Oturum süresi doldu. GitHub ile tekrar giriş yap.',
  };
  return labels[code] || code || 'İşlem gerçekleştirilemedi.';
}

async function postDeviceMode(endpoint, deviceId, body, confirmToken) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (confirmToken) headers['X-Nexowire-Confirm'] = confirmToken;
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ deviceId, ...body }),
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    throw new Error(explainApiError(result.error || ('HTTP ' + response.status)));
  }
  return result;
}

async function setDeviceAccessMode(deviceId, mode, row) {
  const button = row.querySelector('.access-toggle');
  const status = row.querySelector('.access-copy');
  button.disabled = true;
  status.textContent = mode === 'full'
    ? 'Full Access etkinleştiriliyor…' : 'SAFE moda dönülüyor…';
  try {
    await postDeviceMode(
      '/api/v1/me/devices/access-mode',
      deviceId, { mode }, mode === 'full' ? 'full-access-v1' : null,
    );
    await load();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function setDeviceRootMode(deviceId, enabled, row) {
  const action = row.querySelector('.root-toggle');
  const approve = row.querySelector('.root-approve');
  const panel = row.querySelector('.root-confirm-panel');
  const input = row.querySelector('.root-phrase');
  const status = row.querySelector('.root-copy');
  if (enabled && !panel.hidden && input.value.trim() !== 'ROOT DANGER') {
    status.textContent = 'Etkinleştirmek için tam olarak ROOT DANGER yaz.';
    input.focus();
    return;
  }
  action.disabled = true;
  approve.disabled = true;
  status.textContent = enabled ? 'ROOT bakım izni açılıyor…' : 'ROOT kapatılıyor…';
  try {
    await postDeviceMode(
      '/api/v1/me/devices/root-mode', deviceId,
      { enabled, ...(enabled ? { confirmation: 'ROOT DANGER' } : {}) },
      enabled ? 'root-danger-v1' : null,
    );
    await load();
  } catch (error) {
    status.textContent = error.message;
    action.disabled = false;
    approve.disabled = false;
  }
}

function render(snapshot) {
  $('welcome').textContent = snapshot.displayName
    ? 'Hoş geldin, ' + snapshot.displayName
    : 'Kontrol merkezi';
  $('plan').textContent = snapshot.planId.toUpperCase();
  $('plan-detail').textContent = snapshot.billingMode === 'free'
    ? 'Ücretsiz plan · ödeme gerekmez' : 'Hesap planın';

  const usage = snapshot.usage;
  if (usage.monthlyCredits !== null) {
    const usageLabel = formatNumber(usage.usedCredits) + ' / ' +
      formatNumber(usage.monthlyCredits);
    $('usage').textContent = FREE_ONLY_MODE && usage.usedCredits >= usage.monthlyCredits
      ? usageLabel + ' · Kota doldu. Yenilenme: ' + nextUtcPeriodStart() + ' 00:00 UTC'
      : usageLabel;
    $('usage-bar').style.width = Math.min(
      100, Math.round((usage.usedCredits / usage.monthlyCredits) * 100),
    ) + '%';
  } else if (snapshot.billingMode === 'free') {
    $('usage').textContent = 'Sınırsız · ' + formatNumber(usage.usedCredits) +
      ' birim kullanıldı';
    $('usage-bar').style.width = '0%';
  } else {
    $('usage').textContent = formatNumber(usage.prepaidCredits ?? 0) + ' kredi';
    $('usage-bar').style.width = '0%';
  }

  const devices = snapshot.devices ?? [];
  const onlineCount = devices.filter((device) => device.online).length;
  $('devices-count').textContent = String(devices.length);
  $('devices-detail').textContent = onlineCount + ' çevrimiçi';

  const root = $('devices');
  root.textContent = '';
  if (!devices.length) {
    root.innerHTML = '<div class="empty">Henüz bağlı cihaz yok. Yeni cihaz bağlayarak başlayabilirsin.</div>';
  } else {
    for (const device of devices) {
      const row = document.createElement('article');
      row.className = 'device' + (device.online ? '' : ' offline');
      row.innerHTML = [
        '<div class="device-header">',
        ' <div class="device-identity">',
        '  <span class="device-icon" aria-hidden="true">▣</span>',
        '  <div><div class="device-name"></div><small class="platform"></small></div>',
        ' </div>',
        ' <div class="status"><span class="dot"></span><span class="status-text"></span></div>',
        '</div>',
        '<div class="device-meta">',
        ' <span class="meta-chip version-chip"></span><span class="meta-chip bridge-chip"></span>',
        '</div>',
        '<details class="pc-settings">',
        '<summary class="pc-settings-summary"><span class="pc-settings-title">PC Settings</span><span class="pc-settings-status"></span></summary>',
        '<div class="device-access">',
        ' <div class="access-heading"><span class="access-title">Erişim düzeyi</span><span class="access-mode"></span></div>',
        ' <button type="button" class="secondary access-toggle"></button>',
        ' <small class="access-copy"></small>',
        ' <div class="root-access">',
        '  <div class="root-head"><span class="root-label">ROOT MODE</span><span class="danger-chip">DANGER</span></div>',
        '  <small class="root-copy"></small>',
        '  <button type="button" class="danger-button root-toggle"></button>',
        '  <div class="root-confirm-panel" hidden>',
        '   <span class="root-alert">15 dakikalık bakım izni. Bu izin tek başına SYSTEM erişimi vermez.</span>',
        '   <label>Onaylamak için ROOT DANGER yaz',
        '    <input class="root-phrase" maxlength="32" autocomplete="off" placeholder="ROOT DANGER"></label>',
        '   <button type="button" class="danger-button root-approve">15 dakikalık izni aç</button>',
        '  </div>',
        ' </div>',
        '</div>',
        '</details>',
        '<div class="device-foot"><small class="last-seen"></small><small class="device-security">Kimlik korumalı</small></div>',
      ].join('');
      row.querySelector('.device-name').textContent = device.name;
      row.querySelector('.platform').textContent = device.platform;
      row.querySelector('.version-chip').textContent = device.agentVersion
        ? 'Agent v' + device.agentVersion : 'Agent sürümü bilinmiyor';
      const ready = device.privilegeMode === 'broker' &&
        device.adminBridgeReady === true;
      const bridge = row.querySelector('.bridge-chip');
      bridge.textContent = ready ? 'Admin Bridge hazır' : 'Admin Bridge gerekli';
      bridge.classList.add(ready ? 'healthy' : 'needs-bridge');
      row.querySelector('.dot').classList.toggle('online', device.online);
      row.querySelector('.status-text').textContent =
        device.online ? 'Çevrimiçi' : 'Çevrimdışı';

      const mode = device.accessMode === 'full' ? 'full' : 'safe';
      const badge = row.querySelector('.access-mode');
      badge.textContent = mode === 'full' ? 'FULL ACCESS' : 'SAFE';
      badge.classList.add(mode);
      const pcSettings = row.querySelector('.pc-settings');
      const pcSettingsStatus = row.querySelector('.pc-settings-status');
      pcSettings.open = openPcSettings.has(device.id);
      pcSettingsStatus.textContent = mode === 'full' ? 'FULL ACCESS' : 'SAFE';
      pcSettings.addEventListener('toggle', () => {
        if (pcSettings.open) openPcSettings.add(device.id);
        else openPcSettings.delete(device.id);
      });
      const toggle = row.querySelector('.access-toggle');
      toggle.textContent = mode === 'full' ? 'SAFE moda dön' : 'Full Access aç';
      toggle.addEventListener('click', () => {
        void setDeviceAccessMode(device.id, mode === 'full' ? 'safe' : 'full', row);
      });
      row.querySelector('.access-copy').textContent =
        mode === 'full'
          ? 'Kalıcı Full Access etkin. Desteklenen işlemler için gereksiz Nexowire onayları tekrarlanmaz.'
          : 'Varsayılan güvenli erişim. ROOT bakım izni için önce FULL aç.';

      const expiresAt = device.rootMode?.expiresAt;
      const pending = Boolean(expiresAt && Date.parse(expiresAt) > Date.now());
      const active = pending && device.rootMode?.active === true;
      const rootPanel = row.querySelector('.root-confirm-panel');
      const rootButton = row.querySelector('.root-toggle');
      const rootApprove = row.querySelector('.root-approve');
      const rootCopy = row.querySelector('.root-copy');
      const rootContainer = row.querySelector('.root-access');
      rootContainer.classList.toggle('active', active);
      rootButton.textContent = pending ? 'ROOT kapat' : 'ROOT MODE aç';
      if (pending) {
        rootCopy.textContent = '15 dakikalık bakım izni ' +
          (device.online ? 'aktif' : 'askıda') + ' · ' +
          new Date(expiresAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) +
          ' bitiş. ' + (ready ? 'Admin Bridge hazır.' : 'Yönetici işlemleri için Admin Bridge gerekli.');
        const delay = Date.parse(expiresAt) - Date.now();
        if (delay > 0) setTimeout(() => { void load(); }, Math.min(delay + 300, 900_000));
      } else if (!device.online) {
        rootCopy.textContent = 'Cihaz çevrimdışı. Bağlantı gelince bakım izni açılabilir.';
      } else if (mode !== 'full') {
        rootCopy.textContent = 'Önce Full Access açmalısın.';
      } else {
        rootCopy.textContent = ready
          ? '15 dakikalık bakım izni hazır. İstediğin zaman iptal edilebilir.'
          : 'Bakım izni açılabilir. Yükseltilmiş işlemler için Admin Bridge henüz hazır değil.';
      }
      rootPanel.hidden = true;
      rootButton.addEventListener('click', () => {
        if (pending) {
          void setDeviceRootMode(device.id, false, row);
        } else if (mode !== 'full') {
          rootCopy.textContent = 'Önce yukarıdaki Full Access aç düğmesine bas.';
          toggle.focus();
        } else if (!device.online) {
          rootCopy.textContent = 'Cihaz çevrimdışı olduğu için ROOT izni açılamıyor.';
        } else {
          rootPanel.hidden = !rootPanel.hidden;
          if (!rootPanel.hidden) row.querySelector('.root-phrase').focus();
        }
      });
      rootApprove.addEventListener('click', () => {
        void setDeviceRootMode(device.id, true, row);
      });

      row.querySelector('.last-seen').textContent =
        device.lastSeenAt ? 'Son bağlantı: ' +
          new Date(device.lastSeenAt).toLocaleString('tr-TR', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          }) : 'Henüz görülmedi';
      root.appendChild(row);
    }
  }

  $('connect-device').disabled = false;
  setPill('Bağlı', 'good');
}

async function load() {
  $('error-panel').classList.add('hidden');
  $('login').classList.add('hidden');
  setPill('Kontrol ediliyor', 'muted');
  try {
    const response = await fetch('/api/v1/me/dashboard', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401) {
      setPill('Oturum gerekli', 'muted');
      $('error-message').textContent = 'Kontrol paneli için GitHub hesabınla giriş yap.';
      $('login').classList.remove('hidden');
      $('error-panel').classList.remove('hidden');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    setPill('Bağlantı hatası', 'bad');
    $('error-message').textContent =
      error instanceof Error ? error.message : String(error);
    $('error-panel').classList.remove('hidden');
  }
}

$('retry').addEventListener('click', load);
$('login').addEventListener('click', () => {
  window.location.href = '/auth/github/start?next=' +
    encodeURIComponent(window.location.pathname);
});
$('connect-device').addEventListener('click', () => {
  window.location.href = '/connect.html';
});
load();