const $ = (id) => document.getElementById(id);
const formatNumber = (value) => new Intl.NumberFormat('tr-TR').format(value);
const formatCompact = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    .format(value).replace(/K\b/g, 'k').replace(/M\b/g, 'm').replace(/B\b/g, 'b')
  : '—';
const FREE_ONLY_MODE = true;
const openPcSettings = new Set();
// Core Access remains display-only until server-side owner approval and Broker enforcement exist.
let currentSnapshot = null;
let selectedDeviceFilter = 'all';
let selectedDeviceLayout = 'grid';
let selectedFolder = 'all';

async function postFolderAction(action, body) {
  const response = await fetch('/api/v1/me/device-folders/' + action, {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json', 'Accept':'application/json', 'X-Nexowire-Confirm':'device-folder-v1'},
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Klasör işlemi başarısız.');
  return result;
}

function syncFolders(folders) {
  const select = $('folder-filter');
  select.replaceChildren(new Option('Tüm klasörler', 'all'), new Option('Klasörsüz', 'unassigned'));
  for (const folder of folders) select.add(new Option(folder.name, folder.id));
  if (selectedFolder !== 'all' && selectedFolder !== 'unassigned' &&
      !folders.some(folder => folder.id === selectedFolder)) selectedFolder = 'all';
  select.value = selectedFolder;
  $('folder-delete').disabled = selectedFolder === 'all' || selectedFolder === 'unassigned';
}

function getDeviceTier(device) {
  if (device.persistentMaintenance?.active === true) return 'persistent';
  if (device.rootMode?.active === true &&
      Date.parse(device.rootMode.expiresAt ?? '') > Date.now()) return 'root';
  return device.accessMode === 'full' ? 'full' : 'safe';
}

function syncDeviceToolbar(devices) {
  for (const button of document.querySelectorAll('[data-filter]')) {
    const tier = button.dataset.filter;
    const selected = tier === selectedDeviceFilter;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('.filter-count').textContent = String(
      tier === 'all' ? devices.length : devices.filter((device) => getDeviceTier(device) === tier).length,
    );
  }
  for (const button of document.querySelectorAll('[data-layout]')) {
    const selected = button.dataset.layout === selectedDeviceLayout;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  $('devices').classList.toggle('list-view', selectedDeviceLayout === 'list');
}

function updateRootCountdowns() {
  for (const clock of document.querySelectorAll('.root-clock[data-expires-at]')) {
    const remaining = Math.max(0, Date.parse(clock.dataset.expiresAt) - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, '0');
    clock.textContent = remaining ? `${mm}:${ss}` : 'Süre doldu';
  }
}

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

async function updateAutoSelection(enabled) {
  const status = $('auto-status');
  const button = enabled ? $('auto-approve') : $('auto-toggle');
  button.disabled = true;
  status.textContent = enabled ? 'Otomatik cihaz seçimi açılıyor…' : 'Otomatik cihaz seçimi kapatılıyor…';
  try {
    const response = await fetch('/api/v1/me/device-selection/auto', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json', 'Accept':'application/json',
        ...(enabled ? {'X-Nexowire-Confirm':'auto-device-selection-v1'} : {})},
      body: JSON.stringify({enabled, ...(enabled ? {confirmation:'AUTO DEVICE ACCESS'} : {})}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(explainApiError(data.error || 'HTTP ' + response.status));
    $('auto-confirm-panel').hidden = true;
    $('auto-phrase').value = '';
    await load();
  } catch(error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
}

function render(snapshot) {
  currentSnapshot = snapshot;
  $('welcome').textContent = snapshot.displayName
    ? 'Hoş geldin, ' + snapshot.displayName
    : 'Kontrol merkezi';
  $('plan').textContent = snapshot.planId.toUpperCase();
  $('plan-detail').textContent = snapshot.billingMode === 'free'
    ? 'Ücretsiz plan · ödeme gerekmez' : 'Hesap planın';

  const usage = snapshot.usage;
  if (usage.monthlyCredits !== null) {
    $('usage').textContent = formatCompact(usage.usedCredits) + ' / ' +
      formatCompact(usage.monthlyCredits);
    $('usage').title = formatNumber(usage.usedCredits) + ' / ' + formatNumber(usage.monthlyCredits);
    $('usage-detail').textContent = FREE_ONLY_MODE && usage.usedCredits >= usage.monthlyCredits
      ? 'Kota doldu · Yenilenme: ' + nextUtcPeriodStart() + ' 00:00 UTC'
      : 'Bu ay kullanılan / toplam kredi';
    $('usage-bar').style.width = Math.min(
      100, Math.round((usage.usedCredits / usage.monthlyCredits) * 100),
    ) + '%';
  } else if (snapshot.billingMode === 'free') {
    $('usage').textContent = formatCompact(usage.usedCredits);
    $('usage').title = formatNumber(usage.usedCredits);
    $('usage-detail').textContent = 'Sınırsız kullanım · kullanılan birim';
    $('usage-bar').style.width = '0%';
  } else {
    $('usage').textContent = formatCompact(usage.prepaidCredits ?? 0);
    $('usage').title = formatNumber(usage.prepaidCredits ?? 0);
    $('usage-detail').textContent = 'Kalan kredi';
    $('usage-bar').style.width = '0%';
  }

  const devices = snapshot.devices ?? [];
  const onlineCount = devices.filter((device) => device.online).length;
  $('devices-count').textContent = formatCompact(devices.length);
  $('devices-count').title = formatNumber(devices.length);
  $('devices-detail').textContent = formatCompact(onlineCount) + ' çevrimiçi';
  syncDeviceToolbar(devices);
  syncFolders(snapshot.folders ?? []);
  const autoEnabled = snapshot.autoSelectDevices === true;
  $('auto-toggle').disabled = false;
  $('auto-toggle').textContent = autoEnabled ? 'Otomatik seçimi kapat' : 'Otomatik seçimi aç';
  $('auto-status').textContent = autoEnabled
    ? 'Açık · kontrol panelinde yalnızca tek uygun cihaz seçilebilir. MCP entegrasyonu ayrıca doğrulanmalıdır.'
    : 'Kapalı · cihaz belirtilmediyse seçim zorunlu.';
  if (autoEnabled) $('auto-confirm-panel').hidden = true;
  const filteredByMode = selectedDeviceFilter === 'all'
    ? devices : devices.filter((device) => getDeviceTier(device) === selectedDeviceFilter);
  const visibleDevices = filteredByMode.filter(device => selectedFolder === 'all' ||
    (selectedFolder === 'unassigned' ? !device.folderId : device.folderId === selectedFolder));

  const root = $('devices');
  root.textContent = '';
  if (!visibleDevices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = !devices.length
      ? 'Henüz bağlı cihaz yok. Yeni cihaz bağlayarak başlayabilirsin.'
      : selectedDeviceFilter === 'persistent'
        ? 'Core Access henüz etkinleştirilebilir değil. Sunucu, özel onay ve Broker kontrolleri tamamlanmalı.'
        : 'Bu erişim düzeyinde cihaz bulunmuyor.';
    root.appendChild(empty);
  } else {
    for (const device of visibleDevices) {
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
        '<section class="pc-settings">',
        '<div class="device-meta">',
        ' <span class="meta-chip version-chip"></span><span class="meta-chip bridge-chip"></span><span class="meta-chip mode-chip"></span><span class="meta-chip root-state-chip"></span>',
        '</div>',
        ' <button type="button" class="pc-settings-button" aria-expanded="false">',
        '  <span class="pc-settings-icon" aria-hidden="true">⚙</span>',
        '  <span class="pc-settings-label"><strong>PC Settings</strong><small>Ayarları yönet</small></span>',
        '  <span class="pc-settings-arrow" aria-hidden="true">⌄</span>',
        ' </button>',
        '<div class="pc-settings-panel"><div class="pc-settings-inner">',
        '<div class="device-folder-manage"><label>Klasör <select class="folder-assign" aria-label="Cihaz klasörünü değiştir"></select></label><small class="folder-assign-status"></small></div>',
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
        '</div></div></section>',
        '<div class="device-foot"><small class="last-seen"></small><small class="device-security">Kimlik korumalı</small></div>',
      ].join('');
      row.querySelector('.device-name').textContent = device.name;
      row.querySelector('.platform').textContent = device.platform;
      const folderSelect = row.querySelector('.folder-assign');
      folderSelect.add(new Option('Klasörsüz', ''));
      for (const folder of snapshot.folders ?? []) folderSelect.add(new Option(folder.name, folder.id));
      folderSelect.value = device.folderId ?? '';
      folderSelect.addEventListener('change', async () => {
        folderSelect.disabled = true;
        const feedback = row.querySelector('.folder-assign-status');
        feedback.textContent = 'Kaydediliyor…';
        try {
          await postFolderAction('assign', {deviceId: device.id, folderId: folderSelect.value || null});
          await load();
        } catch (error) {
          folderSelect.value = device.folderId ?? '';
          feedback.textContent = error.message;
          folderSelect.disabled = false;
        }
      });
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
      const pcButton = row.querySelector('.pc-settings-button');
      const pcPanel = row.querySelector('.pc-settings-panel');
      pcPanel.id = 'pc-settings-' + devices.indexOf(device);
      pcButton.setAttribute('aria-controls', pcPanel.id);
      const setSettingsOpen = (open) => {
        pcSettings.classList.toggle('is-open', open);
        pcButton.setAttribute('aria-expanded', String(open));
        pcPanel.inert = !open;
        if (open) openPcSettings.add(device.id);
        else openPcSettings.delete(device.id);
      };
      setSettingsOpen(openPcSettings.has(device.id));
      pcButton.addEventListener('click', () => setSettingsOpen(!pcSettings.classList.contains('is-open')));
      const modeChip = row.querySelector('.mode-chip');
      modeChip.textContent = mode === 'full' ? 'Full Access açık' : 'SAFE açık';
      modeChip.classList.add(mode);
      const rootStateChip = row.querySelector('.root-state-chip');
      const rootLeaseActive = device.rootMode?.active === true &&
        Date.parse(device.rootMode?.expiresAt ?? '') > Date.now();
      rootStateChip.textContent = rootLeaseActive ? 'ROOT izni açık' : 'ROOT kapalı';
      if (rootLeaseActive) rootStateChip.classList.add('elevated');
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
          (active ? 'aktif' : 'beklemede') + ' · ' +
          new Date(expiresAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) +
          ' bitiş. ' + (ready ? 'Admin Bridge hazır.' : 'Yönetici işlemleri için Admin Bridge gerekli.');
        const clock = document.createElement('strong');
        clock.className = 'root-clock';
        clock.dataset.expiresAt = expiresAt;
        rootCopy.append(' · Kalan süre: ', clock);
        updateRootCountdowns();
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

$('folder-filter').addEventListener('change', () => {
  selectedFolder = $('folder-filter').value;
  if (currentSnapshot) render(currentSnapshot);
});
$('folder-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('folder-name');
  const status = $('folder-status');
  const name = input.value.trim();
  if (!name) return;
  status.textContent = 'Oluşturuluyor…';
  try {
    const folder = await postFolderAction('create', {name});
    selectedFolder = folder.id;
    input.value = '';
    await load();
    status.textContent = 'Klasör oluşturuldu.';
  } catch (error) { status.textContent = error.message; }
});
$('folder-delete').addEventListener('click', async () => {
  if (selectedFolder === 'all' || selectedFolder === 'unassigned') return;
  const status = $('folder-status');
  $('folder-delete').disabled = true;
  try {
    await postFolderAction('delete', {folderId: selectedFolder});
    selectedFolder = 'all';
    await load();
    status.textContent = 'Klasör silindi. Cihazlar klasörsüz kaldı.';
  } catch (error) { status.textContent = error.message; $('folder-delete').disabled = false; }
});
$('device-filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button || !currentSnapshot) return;
  selectedDeviceFilter = button.dataset.filter;
  render(currentSnapshot);
});
document.querySelector('.device-layout').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-layout]');
  if (!button || !currentSnapshot) return;
  selectedDeviceLayout = button.dataset.layout;
  render(currentSnapshot);
});
for (const panel of document.querySelectorAll('.utility-panel')) {
  panel.addEventListener('toggle', () => {
    if (panel.open) for (const other of document.querySelectorAll('.utility-panel')) {
      if (other !== panel) other.open = false;
    }
  });
}
for (const key of ['compact', 'reduce-motion']) {
  const checkbox = $('setting-' + key);
  try { checkbox.checked = localStorage.getItem('nexowire-view-' + key) === 'true'; } catch { /* Storage may be blocked */ }
  checkbox.addEventListener('change', () => {
    try { localStorage.setItem('nexowire-view-' + key, String(checkbox.checked)); } catch { /* Prefer functional UI */ }
  });
}
setInterval(updateRootCountdowns, 1000);
$('auto-toggle').addEventListener('click', () => {
  if (currentSnapshot?.autoSelectDevices === true) {
    void updateAutoSelection(false);
    return;
  }
  $('auto-confirm-panel').hidden = false;
  $('auto-phrase').focus();
});
$('auto-cancel').addEventListener('click', () => {
  $('auto-confirm-panel').hidden = true;
  $('auto-phrase').value = '';
});
$('auto-approve').addEventListener('click', () => {
  if ($('auto-phrase').value.trim() !== 'AUTO DEVICE ACCESS') {
    $('auto-status').textContent = 'Tam olarak AUTO DEVICE ACCESS yazmalısın.';
    $('auto-phrase').focus();
    return;
  }
  void updateAutoSelection(true);
});
$('retry').addEventListener('click', load);
$('login').addEventListener('click', () => {
  window.location.href = '/auth/github/start?next=' +
    encodeURIComponent(window.location.pathname);
});
$('connect-device').addEventListener('click', () => {
  window.location.href = '/connect.html';
});
load();