const $ = (id) => document.getElementById(id);
const formatNumber = (value) => new Intl.NumberFormat('tr-TR').format(value);
const formatCompact = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    .format(value).replace(/K\b/g, 'k').replace(/M\b/g, 'm').replace(/B\b/g, 'b')
  : '—';
const FREE_ONLY_MODE = true;
const openPcSettings = new Set();
const bridgeCommandsInFlight = new Set();
// Per-device operation fence survives card rerenders; only a fresh server GET reconciles it.
const coreOperations = new Map();
// CORE is a revocable owner preference; Broker remains authoritative for elevated actions.
let currentSnapshot = null;
let selectedDeviceFilter = 'all';
let selectedDeviceLayout = 'grid';
let selectedFolder = 'all';
let latestDashboardLoadId = 0;

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
  select.disabled = false;
  for (const folder of folders) select.add(new Option(folder.name, folder.id));
  if (selectedFolder !== 'all' && selectedFolder !== 'unassigned' &&
      !folders.some(folder => folder.id === selectedFolder)) selectedFolder = 'all';
  select.value = selectedFolder;
  $('folder-delete').disabled = selectedFolder === 'all' || selectedFolder === 'unassigned';
}

// Fail-closed release latch: client snapshots or synthetic local receipts
// cannot verify a signed installed HIGH Broker plus independent native CAS.
// Only a separately reviewed server-authenticated verifier may replace this.
const physicalCoreStatusVerifierInstalled = false;
// ROOT is currently a stored maintenance request, not a session-bound,
// authenticated HIGH token. No browser JSON field can promote it to active.
const physicalRootStatusVerifierInstalled = false;
function getDeviceTier(device) {
  if (physicalCoreStatusVerifierInstalled && device.persistentMaintenance?.active === true) return 'persistent';
  if (physicalRootStatusVerifierInstalled && device.rootMode?.active === true &&
      Date.parse(device.rootMode.expiresAt ?? '') > Date.now()) return 'root';
  return device.accessMode === 'full' ? 'full' : 'safe';
}

function syncDeviceToolbar(devices) {
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.disabled = false;
    const tier = button.dataset.filter;
    const selected = tier === selectedDeviceFilter;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('.filter-count').textContent = String(
      tier === 'all' ? devices.length : devices.filter((device) => getDeviceTier(device) === tier).length,
    );
  }
  for (const button of document.querySelectorAll('[data-layout]')) {
    button.disabled = false;
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

// Announce one concise list update without making screen readers repeat every
// device card and its controls when the list is refreshed.
function setDeviceListMessage(message, loading = false) {
  const root = $('devices');
  root.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  root.appendChild(empty);
  root.setAttribute('aria-busy', String(loading));
  $('device-list-status').textContent = message;
}

function resetDashboardPresentation() {
  currentSnapshot = null;
  $('welcome').textContent = 'Kontrol merkezi';
  $('connect-device').disabled = true;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.disabled = true;
    button.querySelector('.filter-count').textContent = '—';
  }
  for (const button of document.querySelectorAll('[data-layout]')) button.disabled = true;
  const folderSelect = $('folder-filter');
  folderSelect.replaceChildren(new Option('Tüm klasörler', 'all'), new Option('Klasörsüz', 'unassigned'));
  folderSelect.value = 'all';
  folderSelect.disabled = true;
  // A previous account's editor state must not survive a pending or denied load.
  $('folder-delete').disabled = true;
  $('folder-create-form').querySelector('button[type="submit"]').disabled = true;
  $('folder-name').disabled = true;
  $('folder-name').value = '';
  $('folder-status').textContent = '';
  $('auto-confirm-panel').hidden = true;
  $('auto-phrase').value = '';
  $('devices-count').textContent = '—';
  $('devices-count').removeAttribute('title');
  $('devices-detail').textContent = 'Cihaz durumu doğrulanmadı';
  $('plan').textContent = '—';
  $('plan-detail').textContent = 'Hesap bilgisi bekleniyor';
  $('usage').textContent = '—';
  $('usage').removeAttribute('title');
  $('usage-detail').textContent = 'Kullanım bilgisi bekleniyor';
  $('usage-bar').style.width = '0%';
  $('auto-toggle').disabled = true;
  $('auto-toggle').textContent = 'Kontrol ediliyor…';
  $('auto-status').textContent = '';
  setDeviceListMessage('Cihaz listesi yükleniyor…', true);
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
    CORE_REQUIRES_OWNER_LOGIN: 'CORE için cihazın sahibi olan hesapla giriş yap.',
    BRIDGE_REQUIRES_OWNER_LOGIN: 'Admin Bridge ayarları için cihazın sahibi olmalısın.',
    BRIDGE_CONFIRMATION_REQUIRED: 'Admin Bridge onayı doğrulanamadı.',
    BRIDGE_COMMAND_CONFIRMATION_REQUIRED: 'Uygulama için APPLY BRIDGE MODE onayı gerekli.',
    BRIDGE_COMMAND_TRANSPORT_DISABLED: 'Cihaz komut kanalı henüz etkin değil. Tercih kaydedilir; Broker değiştirilmez.',
    BRIDGE_COMMAND_DEVICE_NOT_READY: 'Cihaz çevrimiçi, FULL ve Broker modunda olmalı.',
    BRIDGE_COMMAND_PREFERENCE_MISMATCH: 'Kayıtlı tercih değişti. Modu yeniden seçip tekrar onayla.',
    BRIDGE_COMMAND_QUEUE_REJECTED: 'Broker komutu kuyruğa alınamadı.',
    CORE_CONFIRMATION_REQUIRED: 'Onay ifadesi CORE UNLIMITED olmalı.',
    CORE_REQUIRES_FULL_ONLINE_BROKER: 'CORE için Full Access, çevrimiçi cihaz ve hazır Admin Bridge gerekli.',
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

function coreEnrollmentEligible(device) {
  const physical = device?.physicalConsole;
  return device?.platform === 'win32' && device.online === true &&
    device.accessMode === 'full' && device.privilegeMode === 'broker' &&
    device.adminBridgeReady === true && ['auto','on'].includes(device.bridgePreference?.desiredMode) &&
    device.persistentMaintenance?.enabled === true &&
    physical?.deviceReady === true && physical.localEnrolled === false &&
    physical.enrollmentRequested === false && physical.active === false;
}

function coreActionDevice(deviceId) {
  if(typeof currentSnapshot?.accountId !== 'string' || !currentSnapshot.accountId.trim())return null;
  const matches = (Array.isArray(currentSnapshot?.devices) ? currentSnapshot.devices : [])
    .filter(device => device?.id === deviceId);
  return matches.length === 1 ? matches[0] : null;
}

// Same-origin tabs share a durable *uncertainty* marker, not an authority receipt.
// Web Locks serializes check/write/POST; localStorage survives reload or tab loss.
// Never fall back to an in-memory-only mutation when these facilities are unavailable.
const CORE_FENCE_PREFIX = 'nexowire-core-uncertain-v1:';
function coreFenceKey(accountId,deviceId) {
  return CORE_FENCE_PREFIX + JSON.stringify([accountId,deviceId]);
}
function coreLockAvailable() {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function' &&
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
}
function readCoreFence(accountId,deviceId) {
  const key=coreFenceKey(accountId,deviceId);
  try {
    const raw=localStorage.getItem(key);
    if(raw===null)return {key,raw,operation:null};
    const value=JSON.parse(raw);
    if(value?.accountId!==accountId||value.deviceId!==deviceId||
       !['enable','consent','disable'].includes(value.kind)||
       typeof value.id!=='string'||!value.id||typeof value.acknowledged!=='boolean'||
       !['in-flight','settled'].includes(value.phase))
      throw Error('Invalid local uncertainty marker');
    return {key,raw,operation:{kind:value.kind,id:value.id,accountId,deviceId,
      acknowledged:value.acknowledged,inFlight:false}};
  } catch {
    return {key,raw:null,operation:{kind:'blocked',inFlight:false,
      feedback:'Tarayıcı işlem koruması doğrulanamadı.'}};
  }
}
function storeCoreFence(key,operation) {
  // No response bodies, tokens, approval proofs or OS/session IDs in storage.
  const raw=JSON.stringify({id:operation.id,accountId:operation.accountId,
    deviceId:operation.deviceId,kind:operation.kind,acknowledged:operation.acknowledged,
    phase:operation.inFlight?'in-flight':'settled'});
  localStorage.setItem(key,raw);
  if(localStorage.getItem(key)!==raw)throw Error('Local uncertainty marker not retained');
}
function captureCoreFences() {
  const result=new Map();
  try {
    for(let index=0;index<localStorage.length;index++){
      const key=localStorage.key(index);
      if(key?.startsWith(CORE_FENCE_PREFIX))result.set(key,localStorage.getItem(key));
    }
  } catch { /* no captured marker means no reconciliation */ }
  return result;
}
function coreOperationFor(deviceId) {
  const accountId=currentSnapshot?.accountId;
  if(typeof accountId!=='string'||!accountId.trim())return {kind:'blocked',inFlight:false};
  if(!coreLockAvailable())return {kind:'blocked',inFlight:false,
    feedback:'Tarayıcı sekmeler arası işlem korumasını desteklemiyor.'};
  const local=coreOperations.get(deviceId);
  if(local?.accountId===accountId&&local.inFlight)return local;
  const persisted=readCoreFence(accountId,deviceId).operation;
  return persisted&&local&&local.id===persisted.id?{...persisted,feedback:local.feedback}:persisted;
}
function coreOperationAllows(deviceId, kind) {
  const previous = coreOperationFor(deviceId);
  // A deliberate OFF is a separate safety action, never an automatic retry of
  // consent/enable. A blocked/corrupt marker does not authorize any POST.
  return !previous || (!previous.inFlight && ['enable','consent'].includes(previous.kind) && kind === 'disable');
}

async function reconcileCoreReadback(snapshot, captured) {
  if(!coreLockAvailable()||typeof snapshot?.accountId!=='string'||!snapshot.accountId.trim())return;
  const devices=Array.isArray(snapshot.devices)?snapshot.devices:[];
  for(const device of devices){
    if(typeof device?.id!=='string'||devices.filter(candidate=>candidate?.id===device.id).length!==1)continue;
    const key=coreFenceKey(snapshot.accountId,device.id);
    const expected=captured.get(key);
    if(typeof expected!=='string')continue;
    try {
      await navigator.locks.request(key,{mode:'exclusive',ifAvailable:true},lock=>{
        if(!lock)return; // Another tab is executing, so its marker is not terminal.
        const current=readCoreFence(snapshot.accountId,device.id);
        const operation=current.operation;
        if(current.raw!==expected||!operation||operation.kind==='blocked')return;
        const core=device.persistentMaintenance;
        const physical=device.physicalConsole;
        const recorded=physical?.enrollmentRequested===true||physical?.localEnrolled===true;
        const confirmed=operation.kind==='disable'?core?.enabled===false:
          core?.enabled===true&&(recorded||(operation.kind==='enable'&&operation.acknowledged));
        // This only reconciles the observed preference/request. It never proves
        // a native effect, STOP/drain or durable backend mutation identity.
        if(confirmed){
          localStorage.removeItem(key);
          if(coreOperations.get(device.id)?.id===operation.id)coreOperations.delete(device.id);
        }
      });
    } catch { /* leave uncertainty intact when the lock/storage is unavailable */ }
  }
}

function coreKindEligible(device,kind) {
  if(kind==='consent')return coreEnrollmentEligible(device);
  if(kind==='disable')return device?.persistentMaintenance?.enabled===true;
  return kind==='enable'&&device?.persistentMaintenance?.enabled===false&&
    device.platform==='win32'&&device.online===true&&device.accessMode==='full'&&
    device.privilegeMode==='broker'&&device.adminBridgeReady===true&&
    ['auto','on'].includes(device.bridgePreference?.desiredMode);
}

// AI-03 #1330 v1: the authenticated dashboard's D1 row is informational.
// It is not a native STOP/drain witness, an admission credential or a lease.
function coreRemoteReadback(device,snapshot,now=Date.now()) {
  const unknown={text:' Uzaktan yetki kaydı: UNKNOWN. Yerel STOP, pendingRevoke ve drain doğrulanmadı.',expiresAtMs:null};
  if(typeof snapshot?.accountId!=='string'||!snapshot.accountId.trim()||
     typeof device?.id!=='string'||!Array.isArray(snapshot.devices))return unknown;
  const matches=snapshot.devices.filter(candidate=>candidate?.id===device.id);
  if(matches.length!==1||matches[0]!==device)return unknown;
  const readback=device.coreRevocation;
  const remote=readback?.remoteAuthorization;
  if(readback?.version!==1||readback.source!=='D1_REMOTE_AUTHORIZATION'||
     readback.localStop!=='UNKNOWN'||readback.pendingRevoke!=='UNKNOWN'||
     readback.nativeDrain!=='UNKNOWN'||readback.effectReadback!=='UNKNOWN'||
     readback.nativeEvidence!=='NOT_AVAILABLE'||
     !['ACTIVE','REVOKED'].includes(remote?.state)||
     !Number.isSafeInteger(remote.authorizationEpoch)||remote.authorizationEpoch<1||
     !Number.isSafeInteger(remote.observedAtMs)||remote.observedAtMs<1||
     !Number.isFinite(now)||now<remote.observedAtMs||now-remote.observedAtMs>=15000)return unknown;
  return {text:' Sunucu D1 uzaktan yetki kaydı: '+remote.state+' (epoch '+remote.authorizationEpoch+
    '). Bu, yürütme izni, fiziksel CORE, yerel STOP veya drain kanıtı değildir.',
    expiresAtMs:remote.observedAtMs+15000};
}

function renderCoreReadbackCopy(element,device,snapshot,operation) {
  const base=coreReadbackMessage(device,operation);
  const remote=coreRemoteReadback(device,snapshot);
  const message=base+remote.text;
  element.textContent=message;
  if(remote.expiresAtMs!==null&&typeof setTimeout==='function'){
    // Do not overwrite an ongoing action's feedback or a new account/card.
    setTimeout(()=>{
      if(currentSnapshot===snapshot&&element.isConnected&&element.textContent===message)
        element.textContent=base+coreRemoteReadback(device,snapshot,Math.max(Date.now(),remote.expiresAtMs)).text;
    },Math.max(0,remote.expiresAtMs-Date.now()));
  }
}

function coreReadbackMessage(device, operation) {
  const core = device.persistentMaintenance;
  const physical = device.physicalConsole;
  const stop = ' Fiziksel STOP için cihazdaki Nexowire CORE → KAPAT seçeneğini kullan; yerel iptal ve işlem durması burada doğrulanmadı.';
  if (operation?.inFlight) return 'CORE isteği işleniyor; yeni istek gönderme.' + stop;
  if (operation) return 'CORE isteğinin sonucu belirsiz veya sunucu durumunun yeniden doğrulanması bekleniyor. ' +
    (operation.feedback ? operation.feedback + ' ' : '') + 'Durumu yenile; aynı isteği yineleme.' + stop;
  if (core?.enabled === false) return 'Sunucu CORE hesap tercihini kapalı bildiriyor. Bu, yerel STOP veya yürüyen işlemlerin durduğunun kanıtı değildir.' + stop;
  if (core?.enabled !== true) return 'CORE tercih durumu doğrulanamadı.' + stop;
  if (physical?.localEnrolled === true)
    return 'Yerel CORE kaydı bildirildi; güncel fiziksel erişim doğrulanamadı.' + stop;
  if (physical?.enrollmentRequested === true)
    return 'CORE onay isteği sunucuda kayıtlı; cihaza teslimi ve ilk yerel onay doğrulanmadı. Aynı isteği yeniden gönderme.' + stop;
  if (coreEnrollmentEligible(device))
    return 'CORE tercihi kayıtlı; ilk yerel onay henüz yok. Yalnızca yerel onay isteği yeniden kaydedilebilir.' + stop;
  return 'CORE tercihi kayıtlı; onay kanalı veya cihaz hazır durumu doğrulanamadı. Yeni istek gönderilmedi.' + stop;
}

async function performCoreAction(deviceId, kind, row) {
  if (!coreOperationAllows(deviceId, kind)) return;
  const device = coreActionDevice(deviceId);
  if (!device || !coreKindEligible(device,kind)) return;
  const accountId=currentSnapshot.accountId;
  const enabled = kind === 'enable';
  const input = row.querySelector('.core-phrase');
  const status = row.querySelector('.core-copy');
  if (enabled && input.value.trim() !== 'CORE UNLIMITED') {
    status.textContent = 'Onaylamak için CORE UNLIMITED yaz.';
    input.focus();
    return;
  }
  const key=coreFenceKey(accountId,deviceId);
  let refresh=false;
  try {
    await navigator.locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock){status.textContent='CORE isteği başka bir sekmede işleniyor; aynı isteği gönderme.';return}
      if(currentSnapshot?.accountId!==accountId||!coreOperationAllows(deviceId,kind))return;
      // A tab can have an old card even after another tab reconciled its
      // marker. Read the backend again under the same lock before any POST.
      const response=await fetch('/api/v1/me/dashboard',{credentials:'include',
        headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(8000)});
      if(!response.ok){refresh=true;return}
      const fresh=await response.json();
      const matches=Array.isArray(fresh?.devices)?fresh.devices.filter(d=>d?.id===deviceId):[];
      if(fresh?.accountId!==accountId||currentSnapshot?.accountId!==accountId||
         matches.length!==1||!coreKindEligible(matches[0],kind)){refresh=true;return}
      // The marker must be persisted and read back before crossing the POST
      // boundary. A tab/browser crash leaves an unresolved marker on disk.
      const operation={kind,accountId,deviceId,id:crypto.randomUUID(),inFlight:true,acknowledged:false,feedback:''};
      storeCoreFence(key,operation);
      coreOperations.set(deviceId,operation);
      for(const selector of ['.core-toggle','.core-approve','.core-enrollment-retry'])
        row.querySelector(selector).disabled=true;
      status.textContent=coreReadbackMessage(matches[0],operation);
      refresh=true;
      try {
        const consent = kind === 'consent';
        // Correlation identity for the coordinated backend contract; legacy servers
        // ignoring this header do not provide cross-profile idempotency.
        const headers = {Accept:'application/json','Content-Type':'application/json',
          'X-Nexowire-Mutation-Id':'core-v1:'+operation.id};
        if (consent) headers['X-Nexowire-Confirm'] = 'core-enrollment-request-v1';
        if (enabled) headers['X-Nexowire-Confirm'] = 'core-preference-v1';
        const response = await fetch(consent ? '/api/v1/me/devices/core-enrollment-request' :
          '/api/v1/me/devices/core-preference', {
            method:'POST',credentials:'include',headers,signal:AbortSignal.timeout(15000),
            body:JSON.stringify({deviceId,...(consent ? {} : {enabled,
              ...(enabled ? {confirmation:'CORE UNLIMITED'} : {})})}),
          });
        if (response.ok) {
          const result = await response.json();
          // The backend ACK is only a preference/request receipt, never local consent.
          operation.acknowledged = result?.deviceId === deviceId && (consent
            ? result.enrollmentRequested === true && result.active === false
            : result.persistentMaintenance?.enabled === enabled &&
              result.persistentMaintenance?.active === false);
          if(!operation.acknowledged)operation.feedback='Sunucu yanıtı doğrulanamadı.';
        } else {
          const body=await response.json().catch(()=>null);
          const errors={
            CORE_AUTHORITY_UNAVAILABLE:'CORE onay servisi kullanılamıyor.',
            CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE:'Bağımsız yerel onay sağlayıcısı kullanılamıyor.',
            CORE_ALREADY_ENROLLED:'Sunucu yerel CORE kaydının mevcut olduğunu bildiriyor.',
            CORE_DEVICE_NOT_READY:'Sunucu cihazın CORE için hazır olmadığını bildiriyor.',
            CORE_REQUIRES_FULL_ONLINE_BROKER:'FULL, çevrimiçi cihaz ve hazır Broker gerekli.',
            CORE_NOT_ENABLED:'Sunucu CORE tercihinin açık olmadığını bildiriyor.',
            CORE_REQUIRES_OWNER_LOGIN:'Cihaz sahibi hesabı gerekli.',
            DEVICE_NOT_FOUND:'Sunucu cihazı bu hesap için bulamadı.',
            UNAUTHENTICATED:'Oturum doğrulanamadı.',
          };
          const reason=typeof body?.error==='string'&&Object.hasOwn(errors,body.error)?errors[body.error]:'';
          const status=Number.isInteger(response.status)&&response.status>=400&&response.status<=599?response.status:null;
          operation.feedback=(status?'HTTP '+status+'. ':'')+(reason||'Sunucu isteği doğrulayamadı.');
        }
      } catch {
        // A transport failure or malformed response may follow a durable write.
        // Do not echo upstream data or repeat the mutation.
        operation.feedback='Bağlantı veya sunucu yanıtı doğrulanamadı.';
      } finally {
        operation.inFlight=false;
        // Retain the original unresolved marker if the ACK write fails.
        try{storeCoreFence(key,operation)}catch{/* fail closed on subsequent reads */}
      }
    });
  }catch{
    status.textContent='Tarayıcı işlem koruması veya sunucu durumu doğrulanamadı. Yeni istek gönderme.';
  }
  // Do not hold the lock while load attempts reconciliation.
  if(refresh)await load();
}

async function setDeviceCorePreference(deviceId, enabled, row) {
  return performCoreAction(deviceId, enabled ? 'enable' : 'disable', row);
}

async function retryCoreEnrollmentRequest(deviceId, row) {
  return performCoreAction(deviceId, 'consent', row);
}

async function setDeviceBridgePreference(deviceId, mode, row, focusSelector = '.bridge-toggle') {
  const buttons = [...row.querySelectorAll('.bridge-quick-toggle, .bridge-toggle, .bridge-mode')];
  const feedback = row.querySelector('.bridge-mode-feedback');
  for (const button of buttons) button.disabled = true;
  feedback.textContent = 'Admin Bridge ' + (mode === 'on' ? 'ON' : mode === 'off' ? 'OFF' : 'AUTO') + ' tercihi kaydediliyor… Broker durumu henüz değiştirilmez.';
  try {
    await postDeviceMode('/api/v1/me/devices/bridge-preference', deviceId,
      { mode }, 'bridge-preference-v1');
    await load();
    // Device cards rerender after saving. Keep keyboard focus on the same
    // control instead of silently returning it to the document body.
    const updated = [...document.querySelectorAll('.device')].find(
      (candidate) => candidate.dataset.deviceId === deviceId,
    );
    updated?.querySelector(focusSelector)?.focus({ preventScroll: true });
  } catch (error) {
    feedback.textContent = error.message;
    for (const button of buttons) button.disabled = false;
  }
}

async function applyDeviceBridgeMode(deviceId,mode,row){
  const panel=row.querySelector('.bridge-apply-panel');
  const phrase=row.querySelector('.bridge-apply-phrase');
  const apply=row.querySelector('.bridge-apply-toggle');
  const approve=row.querySelector('.bridge-apply-approve');
  const status=row.querySelector('.bridge-command-status');
  if(phrase.value.trim()!=='APPLY BRIDGE MODE'){
    status.textContent='Uygulamak için tam olarak APPLY BRIDGE MODE yaz.';
    phrase.focus();
    return;
  }
  if(bridgeCommandsInFlight.has(deviceId))return;
  bridgeCommandsInFlight.add(deviceId);
  apply.disabled=true;
  approve.disabled=true;
  status.textContent='Onaylı Broker komutu cihaza gönderilmek üzere kuyruğa alınıyor…';
  try{
    const command=await postDeviceMode(
      '/api/v1/me/devices/bridge-command',deviceId,
      {mode,confirmation:'APPLY BRIDGE MODE'},'bridge-command-issue-v1',
    );
    if(command.status!=='queued'||typeof command.requestId!=='string'||
       !command.requestId.trim()||command.requestId!==command.requestId.trim()){
      throw new Error('Sunucu doğrulanmış bir komut kimliği döndürmedi.');
    }
    panel.hidden=true;
    status.textContent=mode.toUpperCase()+' isteği kuyruğa alındı. Windows Broker henüz değişti sayılmaz.';
    const expiry=Date.parse(command.expiresAt);
    if(!Number.isFinite(expiry))throw new Error('Komut sona erme zamanı geçersiz.');
    let claimedObserved=false;
    while(Date.now()<expiry){
      await new Promise(resolve=>setTimeout(resolve,2500));
      const response=await fetch(
        '/api/v1/me/devices/bridge-command/status?requestId='+encodeURIComponent(command.requestId),
        {credentials:'include',headers:{Accept:'application/json'}},
      );
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(explainApiError(data.error||('HTTP '+response.status)));
      if(data.requestId!==command.requestId||data.deviceId!==deviceId){
        throw new Error('Cihaz komut yanıtı eşleşmiyor.');
      }
      if(data.status==='queued'||data.status==='claimed'){
        // Delayed queue observations must not erase a newer claimed result.
        if(data.status==='queued'&&claimedObserved)continue;
        if(data.status==='claimed')claimedObserved=true;
        status.textContent='Broker komutu '+(data.status==='queued'?'kuyrukta':'cihazda işleniyor')+
          '. Yerel imzalı doğrulama bekleniyor.';
        continue;
      }
      if(data.status==='applied'){
        status.textContent='İmzalı cihaz onayı alındı: '+mode.toUpperCase()+' uygulandı. Güncel durum yenileniyor…';
        await load();
        return;
      }
      if(data.status==='failed'||data.status==='expired'){
        status.textContent=data.status==='expired'?'İstek süresi doldu, uygulanmış sayılmaz.':
          'Cihaz komutu doğrulayamadı: '+(data.failureCode||'Neden belirtilmedi.');
        return;
      }
      throw new Error('Beklenmeyen cihaz komut durumu.');
    }
    status.textContent='Komutun süresi doldu; gerçek Broker durumu yeniden doğrulanmalı.';
  }catch(error){
    status.textContent=error instanceof Error?error.message:String(error);
  }finally{
    bridgeCommandsInFlight.delete(deviceId);
    apply.disabled=false;
    approve.disabled=false;
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
  $('folder-name').disabled = false;
  $('folder-create-form').querySelector('button[type="submit"]').disabled = false;
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
  const onlineCount = devices.filter((device) => device.online === true).length;
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
  root.setAttribute('aria-busy', 'false');
  if (!visibleDevices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = !devices.length
      ? 'Henüz bağlı cihaz yok. Yeni cihaz bağlayarak başlayabilirsin.'
      : selectedFolder !== 'all'
        ? 'Seçilen klasör ve erişim filtresine uyan cihaz bulunmuyor.'
        : selectedDeviceFilter === 'persistent'
          ? 'CORE durumu doğrulanmış cihaz bulunmuyor. Diğer cihazlar için Tümü filtresini seç.'
          : 'Seçilen erişim düzeyinde cihaz bulunmuyor.';
    root.appendChild(empty);
    $('device-list-status').textContent = empty.textContent;
  } else {
    $('device-list-status').textContent =
      visibleDevices.length + ' cihaz gösteriliyor; ' +
      visibleDevices.filter((device) => device.online === true).length + ' çevrimiçi.';
    for (const device of visibleDevices) {
      const row = document.createElement('article');
      row.className = 'device' + (device.online ? '' : ' offline');
      row.dataset.deviceId = device.id;
      // The ordinal distinguishes cards even when two devices share a name.
      // It is a presentation label, not an identifier for API/device actions.
      const deviceLabel = device.name + ' · cihaz ' + (devices.indexOf(device) + 1);
      row.setAttribute('aria-label', deviceLabel);
      row.innerHTML = [
        '<div class="device-header">',
        ' <div class="device-identity">',
        '  <span class="device-icon" aria-hidden="true">▣</span>',
        '  <div><div class="device-name"></div><small class="platform"></small></div>',
        ' </div>',
        ' <div class="device-header-actions"><button type="button" class="core-shortcut" aria-label="CORE ayarlarını aç">CORE</button><button type="button" class="bridge-quick-toggle" aria-label="Admin Bridge aç kapa tercihi"><span class="bridge-quick-caption">BRIDGE</span><span class="bridge-quick-state">AUTO</span></button><div class="status"><span class="dot"></span><span class="status-text"></span></div></div>',
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
        '<div class="device-folder-manage"><label>Klasör <select class="folder-assign" aria-label="Cihaz klasörünü değiştir"></select></label><small class="folder-assign-status" role="status" aria-live="polite"></small></div>',
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
        ' <div class="core-access">',
        '  <div class="core-head"><strong>CORE ACCESS</strong><span class="core-duration">SÜRESİZ</span></div>',
        '  <small class="core-copy" role="status" aria-live="polite"></small>',
        '  <button type="button" class="secondary core-toggle">CORE aç</button>',
        '  <button type="button" class="secondary core-enrollment-retry" hidden>Yerel CORE kaydını yeniden iste</button>',
        '  <button type="button" class="secondary core-readback">CORE durumunu yenile (salt okunur)</button>',
        '  <div class="core-confirm-panel" hidden>',
        '   <small>CORE süresiz bir tercih kaydıdır. Yönetici yetkisi için ayrıca Broker, Windows UAC ve işlem denetimi gerekir. Hesap tercihini kapatmak yerel STOP onayı değildir.</small>',
        '   <label>Onaylamak için CORE UNLIMITED yaz<input class="core-phrase" maxlength="32" autocomplete="off" placeholder="CORE UNLIMITED"></label>',
        '   <button type="button" class="primary core-approve">CORE etkinleştir</button>',
        '  </div>',
        ' </div>',
        ' <div class="bridge-access">',
        '  <div class="bridge-head"><strong>ADMIN BRIDGE</strong><span class="bridge-live-status"></span></div>',
        '  <small class="bridge-copy"></small>',
        '  <div class="bridge-switch-row"><div class="bridge-switch-description"><strong>ON / OFF</strong><small>Tercihi tek tıkla değiştir</small></div><button type="button" class="bridge-toggle" role="switch" aria-checked="false" aria-label="Admin Bridge aç kapa tercihi"><span class="bridge-toggle-track" aria-hidden="true"><span class="bridge-toggle-thumb"></span></span><span class="bridge-toggle-label">OFF</span></button></div>',
        '  <div class="bridge-mode-options" role="group" aria-label="Admin Bridge otomatik tercihi"><button type="button" class="secondary bridge-mode" data-bridge="auto" aria-pressed="false">AUTO MOD</button><small>İstersen AUTO tercihini ayrıca seçebilirsin.</small></div>',
        '  <small class="bridge-mode-feedback" role="status" aria-live="polite"></small>',
        '  <button type="button" class="secondary bridge-apply-toggle">Seçilen modu cihazda uygula</button>',
        '  <div class="bridge-apply-panel" hidden>',
        '    <small>Bu ayrı bir gerçek cihaz komutudur. Yalnızca açık onaydan sonra kuyruğa girer. Broker durumu imzalı cihaz sonucu gelmeden başarılı gösterilmez.</small>',
        '    <label>Onaylamak için APPLY BRIDGE MODE yaz<input class="bridge-apply-phrase" maxlength="32" autocomplete="off" placeholder="APPLY BRIDGE MODE"></label>',
        '    <button type="button" class="primary bridge-apply-approve">Onayla ve cihaza uygula</button>',
        '  </div>',
        '  <small class="bridge-command-status" role="status" aria-live="polite"></small>',
        ' </div>',
        '</div>',
        '</div></div></section>',
        '<div class="device-foot"><small class="last-seen"></small><small class="device-security">Kimlik korumalı</small></div>',
      ].join('');
      row.querySelector('.device-name').textContent = device.name;
      row.querySelector('.platform').textContent = device.platform;
      row.querySelector('.core-shortcut').setAttribute('aria-label', deviceLabel + ' · CORE ayarlarını aç');
      row.querySelector('.bridge-quick-toggle').setAttribute('aria-label', deviceLabel + ' · Admin Bridge tercihini değiştir');
      const folderSelect = row.querySelector('.folder-assign');
      folderSelect.setAttribute('aria-label', deviceLabel + ' · klasör');
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
      // Last-seen telemetry from an offline device is NOT live Broker evidence.
      const ready = device.online === true &&
        device.privilegeMode === 'broker' && device.adminBridgeReady === true;
      const bridge = row.querySelector('.bridge-chip');
      bridge.textContent = ready ? 'Broker hazır bildirimi' :
        device.online ? 'Broker doğrulanmadı' : 'Broker durumu bilinmiyor';
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
      pcButton.setAttribute('aria-label', deviceLabel + ' · PC ayarları');
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
      const rootLeaseActive = physicalRootStatusVerifierInstalled &&
        device.rootMode?.active === true &&
        Date.parse(device.rootMode?.expiresAt ?? '') > Date.now();
      rootStateChip.textContent = rootLeaseActive ? 'ROOT izni açık' : 'ROOT kapalı';
      if (!rootLeaseActive && device.rootMode?.expiresAt &&
          Date.parse(device.rootMode.expiresAt) > Date.now()) {
        // The stored 15-minute owner request is not a session-bound grant.
        rootStateChip.textContent = 'ROOT BEKLEMEDE (oturum doğrulanmadı)';
      }
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
      const active = physicalRootStatusVerifierInstalled &&
        pending && device.rootMode?.active === true;
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
        if (!active) {
          rootCopy.textContent =
            'ROOT isteği kaydedildi; ancak oturum kapanışında iptal ' +
            'doğrulanamadığından ROOT yetkisi ETKİN DEĞİL. ' +
            'Bu istek işletim sistemi yönetici izni veya UAC onayı değildir.';
        }
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

      const core = device.persistentMaintenance ?? {};
      const corePanel = row.querySelector('.core-confirm-panel');
      const coreButton = row.querySelector('.core-toggle');
      const coreText = row.querySelector('.core-copy');
      const coreShortcut = row.querySelector('.core-shortcut');
      const coreContainer = row.querySelector('.core-access');
      // A preference or browser-provided active flag is not physical CORE.
      const coreEffective = physicalCoreStatusVerifierInstalled && core.active === true;
      coreContainer.classList.toggle('active', coreEffective);
      coreShortcut.classList.toggle('active', coreEffective);
      coreShortcut.setAttribute('aria-pressed', String(coreEffective));
      coreShortcut.textContent = coreEffective ? 'CORE AÇIK' : core.enabled ? 'CORE BEKLEMEDE' : 'CORE';
      coreButton.textContent = core.enabled ? 'CORE kapat' : 'CORE aç';
      coreText.textContent = coreEffective
        ? 'CORE tercihi süresiz etkin. Her yönetici işlemi ayrıca Broker ve Windows denetiminden geçer.'
        : core.enabled
          ? 'CORE tercih kaydı duruyor, ancak cihaz veya Admin Bridge hazır olmadığı için etkin değil.'
          : 'CORE kapalı. Full Access ve çalışan Admin Bridge varsa açılabilir.';
      const physical=device.physicalConsole;
      const coreRetry=row.querySelector('.core-enrollment-retry');
      const coreOperation=coreOperationFor(device.id);
      coreRetry.hidden=!(coreEnrollmentEligible(device) && coreActionDevice(device.id) && coreOperationAllows(device.id,'consent'));
      coreRetry.disabled=coreRetry.hidden;
      const coreReadback=row.querySelector('.core-readback');
      coreReadback.disabled=coreOperation?.inFlight===true;
      coreReadback.addEventListener('click',async()=>{
        if(coreOperationFor(device.id)?.inFlight)return;
        await load();
        const refreshed=[...document.querySelectorAll('.device')].filter(card=>card.dataset.deviceId===device.id);
        if(refreshed.length===1)refreshed[0].querySelector('.core-readback')?.focus({preventScroll:true});
      });
      coreButton.disabled=!coreActionDevice(device.id) || (core.enabled === true
        ? !coreOperationAllows(device.id,'disable') : core.enabled !== false || !coreOperationAllows(device.id,'enable'));
      row.querySelector('.core-approve').disabled=!coreActionDevice(device.id) || !coreOperationAllows(device.id,'enable');
      const physicalFresh=physicalCoreStatusVerifierInstalled&&
        physical?.localEnrolled===true&&physical.active===true&&
        Number.isFinite(physical.observedAtMs)&&Date.now()-physical.observedAtMs>=0&&
        Date.now()-physical.observedAtMs<15000&&core.enabled&&mode==='full'&&device.online&&ready;
      if(physicalFresh){
        coreShortcut.textContent='CORE FİZİKSEL AÇIK';
        coreText.textContent='Yerel onaylı fiziksel kontrol süresiz etkin. PC tepsisindeki Nexowire CORE → KAPAT ile iptal edilir. Yönetici ve UAC izinleri ayrıdır.';
      }else{
        renderCoreReadbackCopy(coreText,device,snapshot,coreOperation);
      }
      corePanel.hidden = true;
      coreShortcut.addEventListener('click', () => {
        setSettingsOpen(true);
        coreContainer.scrollIntoView({behavior: 'smooth', block: 'nearest'});
        coreButton.focus();
      });
      coreButton.addEventListener('click', () => {
        if (core.enabled) {
          void setDeviceCorePreference(device.id, false, row);
        } else if (device.platform !== 'win32' || mode !== 'full' || !device.online || !ready || device.bridgePreference?.desiredMode === 'off') {
          coreText.textContent = 'Önce Full Access aç; cihaz çevrimiçi ve Admin Bridge hazır olmalı.';
          coreShortcut.focus();
        } else {
          corePanel.hidden = !corePanel.hidden;
          if (!corePanel.hidden) row.querySelector('.core-phrase').focus();
        }
      });
      row.querySelector('.core-approve').addEventListener('click', () => {
        void setDeviceCorePreference(device.id, true, row);
      });
      row.querySelector('.core-enrollment-retry').addEventListener('click', () => {
        void retryCoreEnrollmentRequest(device.id, row);
      });
      const bridgeLabel = row.querySelector('.bridge-live-status');
      bridgeLabel.textContent = ready ? 'HAZIR BİLDİRİMİ' :
        device.online ? 'DOĞRULANMADI' : 'ÇEVRİMDIŞI';
      bridgeLabel.classList.toggle('ready', ready);
      row.querySelector('.bridge-copy').textContent = ready
        ? 'Cihaz Broker hazır durumunu bildiriyor. Bu, ON/OFF komutunun uygulandığına dair kanıt değildir.'
        : device.online
          ? 'Broker hazır bildirimi yok. CORE yalnızca doğrulanan Broker ile etkin olabilir.'
          : 'Cihaz çevrimdışı. Son Broker bilgisi güncel kabul edilemez.';
      const bridgeDesired = device.bridgePreference?.desiredMode ?? 'auto';
      const bridgeIsOn = bridgeDesired === 'on';
      const bridgeCard = row.querySelector('.bridge-access');
      const bridgeQuickToggle = row.querySelector('.bridge-quick-toggle');
      const bridgeToggle = row.querySelector('.bridge-toggle');
      const bridgeNextMode = bridgeIsOn ? 'off' : 'on';
      bridgeCard.dataset.desiredMode = bridgeDesired;
      bridgeCard.classList.toggle('preference-on', bridgeIsOn);
      bridgeQuickToggle.dataset.mode = bridgeDesired;
      bridgeQuickToggle.classList.toggle('active', bridgeIsOn);
      bridgeQuickToggle.setAttribute('aria-pressed', String(bridgeIsOn));
      bridgeQuickToggle.querySelector('.bridge-quick-state').textContent = bridgeDesired.toUpperCase();
      bridgeQuickToggle.setAttribute('aria-label', deviceLabel + ' · Admin Bridge tercihi ' + bridgeDesired.toUpperCase() + '. ' + bridgeNextMode.toUpperCase() + ' tercihine geç');
      bridgeQuickToggle.title = 'Yalnızca tercih kaydı; Windows Broker işlemi değil. OFF, CORE tercihini iptal eder.';
      bridgeQuickToggle.addEventListener('click', () => {
        void setDeviceBridgePreference(device.id, bridgeNextMode, row, '.bridge-quick-toggle');
      });
      bridgeToggle.setAttribute('aria-checked', String(bridgeIsOn));
      bridgeToggle.setAttribute('aria-label', deviceLabel + ' · Admin Bridge ' + bridgeNextMode.toUpperCase() + ' tercihine geç (Windows görevini henüz değiştirmez)');
      bridgeToggle.classList.toggle('active', bridgeIsOn);
      bridgeToggle.querySelector('.bridge-toggle-label').textContent = bridgeIsOn ? 'ON' : bridgeDesired === 'auto' ? 'AUTO' : 'OFF';
      bridgeToggle.addEventListener('click', () => {
        void setDeviceBridgePreference(device.id, bridgeNextMode, row);
      });
      for (const bridgeMode of row.querySelectorAll('.bridge-mode')) {
        const selected = bridgeMode.dataset.bridge === bridgeDesired;
        bridgeMode.classList.toggle('selected', selected);
        bridgeMode.setAttribute('aria-pressed', String(selected));
        bridgeMode.addEventListener('click', () => {
          if (!selected) void setDeviceBridgePreference(device.id, bridgeMode.dataset.bridge, row, '.bridge-mode[data-bridge="auto"]');
        });
      }
      const bridgeApply=row.querySelector('.bridge-apply-toggle');
      const bridgeApplyPanel=row.querySelector('.bridge-apply-panel');
      const bridgeEligible=device.online===true&&mode==='full'&&
        device.platform==='win32'&&device.privilegeMode==='broker';
      bridgeApply.disabled=!bridgeEligible||bridgeCommandsInFlight.has(device.id);
      bridgeApply.title=bridgeEligible
        ?'Ayrı onay gerektirir; tercih kaydı Broker görevini tek başına değiştirmez.'
        :'Cihaz Windows, çevrimiçi, FULL ve Broker modunda olmalı.';
      bridgeApply.addEventListener('click',()=>{
        bridgeApplyPanel.hidden=!bridgeApplyPanel.hidden;
        if(!bridgeApplyPanel.hidden)row.querySelector('.bridge-apply-phrase').focus();
      });
      row.querySelector('.bridge-apply-approve').addEventListener('click',()=>{
        void applyDeviceBridgeMode(device.id,bridgeDesired,row);
      });
      const bridgeFeedback = row.querySelector('.bridge-mode-feedback');
      const bridgeObservation = bridgeDesired === 'off'
        ? ready
          ? 'OFF seçildi ancak Broker hâlâ hazır bildiriliyor. Gerçek kapatma yapılmadı.'
          : device.online
            ? 'OFF seçildi. Broker durumu doğrulanamadı; kapatıldığı kanıtlanmadı.'
            : 'OFF seçildi. Cihaz çevrimdışı; kapatma durumu bilinmiyor.'
        : bridgeDesired === 'on'
          ? ready
            ? 'ON seçildi. Broker hazır bildirimi var; bu düğmenin başlattığı doğrulanmadı.'
            : device.online
              ? 'ON seçildi. Broker henüz hazır değil; başlatma komutu gönderilmedi.'
              : 'ON seçildi. Cihaz çevrimdışı; başlatma komutu gönderilmedi.'
          : ready
            ? 'AUTO seçildi. Broker hazır bildirimi var; otomatik yönetim etkin değil.'
            : 'AUTO seçildi. Otomatik yerel görev yönetimi henüz etkin değil.';
      bridgeFeedback.textContent = bridgeObservation +
        ' Bu anahtar şimdilik yalnızca tercihi kaydeder. OFF, CORE tercihini iptal eder.';
      bridgeFeedback.classList.toggle('bridge-warning',
        (bridgeDesired === 'off' && ready) ||
        (bridgeDesired === 'on' && !ready));

      row.querySelector('.last-seen').textContent =
        device.lastSeenAt ? 'Son bağlantı: ' +
          new Date(device.lastSeenAt).toLocaleString('tr-TR', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          }) : 'Henüz görülmedi';
      root.appendChild(row);
    }
  }

  $('connect-device').disabled = false;
  // Dashboard HTTP success is not evidence of an online connected device.
  setPill(onlineCount > 0 ? 'Cihaz çevrimiçi' : devices.length > 0
    ? 'Cihazlar çevrimdışı' : 'Cihaz yok', onlineCount > 0 ? 'good' : 'muted');
}

async function load() {
  const loadId = ++latestDashboardLoadId;
  const capturedCoreFences=captureCoreFences();
  $('error-panel').classList.add('hidden');
  $('login').classList.add('hidden');
  setPill('Kontrol ediliyor', 'muted');
  resetDashboardPresentation();
  try {
    const response = await fetch('/api/v1/me/dashboard', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (loadId !== latestDashboardLoadId) return;
    if (response.status === 401) {
      selectedFolder = 'all';
      setPill('Oturum gerekli', 'muted');
      $('error-message').textContent = 'Kontrol paneli için GitHub hesabınla giriş yap.';
      $('login').classList.remove('hidden');
      $('error-panel').classList.remove('hidden');
      setDeviceListMessage('Cihazları görüntülemek için GitHub hesabınla giriş yap.');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const snapshot = await response.json();
    if (loadId !== latestDashboardLoadId) return;
    await reconcileCoreReadback(snapshot,capturedCoreFences);
    if(loadId !== latestDashboardLoadId)return;
    render(snapshot);
  } catch (error) {
    if (loadId !== latestDashboardLoadId) return;
    setPill('Bağlantı hatası', 'bad');
    $('error-message').textContent = 'Kontrol paneli doğrulanamadı. Bağlantıyı kontrol edip durumu yeniden yükle.';
    $('error-panel').classList.remove('hidden');
    setDeviceListMessage('Cihaz listesi yüklenemedi. Bağlantını kontrol edip yeniden dene.');
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
