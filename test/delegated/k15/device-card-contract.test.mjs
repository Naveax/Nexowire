import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the real web/app.js renderer, not a duplicate implementation.
// A tiny purpose-built DOM surface is sufficient for deterministic card/text
// contracts; it is NOT an accessibility-tree or real-browser acceptance test.
// Optional explicit candidate path lets a UI owner's unmerged branch be
// checked without merging it into this test-only branch.
const appSource = readFileSync(
  process.env.K15_APP_SOURCE ?? new URL('../../../web/app.js', import.meta.url), 'utf8',
);
const hasDeviceLabelFix = /const deviceLabel = device\.name \+ ' · cihaz '/.test(appSource);
const hasLoadingReset = /function resetDashboardPresentation\(/.test(appSource);
const mcpSource = readFileSync(new URL('../../../src/mcp/create-server.ts', import.meta.url), 'utf8');
const bootstrapStart = appSource.indexOf("$('folder-filter').addEventListener('change'");
assert.ok(bootstrapStart > 0, 'UI bootstrap boundary must remain identifiable');

class FakeClassList {
  #classes = new Set();
  add(value) { this.#classes.add(value); }
  remove(value) { this.#classes.delete(value); }
  contains(value) { return this.#classes.has(value); }
  toggle(value, force) {
    const enabled = force ?? !this.contains(value);
    if (enabled) this.add(value);
    else this.#classes.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(selector = '') {
    this.selector = selector;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.elements = new Map();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this._text = '';
  }
  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }
  get className() { return this._className ?? ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(value) { this.template = value; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  add(item) { this.children.push(item); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new FakeElement(selector));
    return this.elements.get(selector);
  }
  querySelectorAll(selector) {
    if (selector === '.bridge-mode') {
      const mode = this.querySelector('.bridge-mode[data-bridge="auto"]');
      mode.dataset.bridge = 'auto';
      return [mode];
    }
    return [];
  }
}

function device(overrides = {}) {
  return {
    id: 'device-1', name: 'Cihaz 1', platform: 'win32', online: true,
    accessMode: 'safe', privilegeMode: 'direct', adminBridgeReady: false,
    agentVersion: null, lastSeenAt: null, folderId: null,
    rootMode: {active: false, expiresAt: null},
    persistentMaintenance: {enabled: false, active: false},
    bridgePreference: {desiredMode: 'auto'},
    ...overrides,
  };
}

function snapshot(devices, overrides = {}) {
  return {
    displayName: null, planId: 'free', billingMode: 'free',
    usage: {usedCredits: 0, monthlyCredits: 100},
    devices, folders: [], autoSelectDevices: false,
    ...overrides,
  };
}

function harness() {
  const ids = new Map();
  const filterButtons = ['all', 'safe', 'full', 'root', 'persistent'].map(filter => {
    const button = new FakeElement('button[data-filter]');
    button.dataset.filter = filter;
    return button;
  });
  const layoutButtons = ['grid', 'list'].map(layout => {
    const button = new FakeElement('button[data-layout]');
    button.dataset.layout = layout;
    return button;
  });
  const requests = [];
  let fetchHandler = async () => ({ok: true, status: 200, json: async () => ({})});
  const document = {
    getElementById(id) {
      if (!ids.has(id)) {
        const element = new FakeElement('#' + id);
        if (id === 'auto-confirm-panel') element.hidden = true;
        ids.set(id, element);
      }
      return ids.get(id);
    },
    querySelectorAll(selector) {
      if (selector === '[data-filter]') return filterButtons;
      if (selector === '[data-layout]') return layoutButtons;
      return [];
    },
    createElement(tag) { return new FakeElement(tag); },
  };
  const context = vm.createContext({
    document, Intl, Date, Number, Math, Set, Promise,
    Option: function Option(text, value) { this.text = text; this.value = value; },
    fetch: (url, options) => {
      requests.push({url, options});
      return fetchHandler(url, options);
    },
    setTimeout: () => 1,
  });
  vm.runInContext(appSource.slice(0, bootstrapStart), context, {filename: 'web/app.js'});
  return {
    document, requests, context, filterButtons,
    render(data) { context.__snapshot = data; vm.runInContext('render(__snapshot)', context); },
    load() { return vm.runInContext('load()', context); },
    setFetch(handler) { fetchHandler = handler; },
    setFilter(mode) { context.__filter = mode; vm.runInContext('selectedDeviceFilter = __filter', context); },
    setFolder(id) { context.__folder = id; vm.runInContext('selectedFolder = __folder', context); },
    cards() { return document.getElementById('devices').children; },
    id(id) { return document.getElementById(id); },
  };
}

test('zero registered devices show a genuine empty state and zero online', () => {
  const h = harness();
  h.render(snapshot([]));
  assert.equal(h.id('devices-count').textContent, '0');
  assert.equal(h.id('devices-detail').textContent, '0 çevrimiçi');
  assert.equal(h.cards().length, 1);
  assert.match(h.cards()[0].textContent, /Henüz bağlı cihaz yok/);
});

test('nonmatching mode filter never claims that the account has no registered devices', () => {
  const h = harness();
  const data = snapshot([device({accessMode: 'full'})]);
  h.setFilter('safe');
  h.render(data);
  assert.equal(h.id('devices-count').textContent, '1');
  assert.match(h.cards()[0].textContent, /(?:Bu|Seçilen) erişim düzeyinde cihaz bulunmuyor/);
  assert.doesNotMatch(h.cards()[0].textContent, /Henüz bağlı cihaz yok/);
  h.setFilter('all');
  h.render(data);
  assert.equal(h.cards().length, 1);
  assert.equal(h.cards()[0].dataset.deviceId, 'device-1');
});

test('each card preserves its exact stable ID even when names are identical', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'desktop-a', name: 'Ofis PC'}),
    device({id: 'desktop-b', name: 'Ofis PC'}),
  ]));
  assert.deepEqual(h.cards().map(card => card.dataset.deviceId), ['desktop-a', 'desktop-b']);
  assert.deepEqual(h.cards().map(card => card.querySelector('.device-name').textContent), ['Ofis PC', 'Ofis PC']);
  h.cards()[1].querySelector('.access-toggle').listeners.get('click')();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/v1/me/devices/access-mode');
  assert.equal(JSON.parse(h.requests[0].options.body).deviceId, 'desktop-b');
});

test('per-device quick controls expose distinguishable accessible names', {
  todo: !hasDeviceLabelFix && 'web/app.js UI owner must distinguish repeated action labels by device identity',
}, () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'desktop-a', name: 'Ofis PC'}),
    device({id: 'desktop-b', name: 'Ofis PC'}),
  ]));
  for (const selector of ['.core-shortcut', '.bridge-quick-toggle', '.pc-settings-button', '.folder-assign']) {
    const labels = h.cards().map(card => card.querySelector(selector).getAttribute('aria-label')
      ?? card.template.match(new RegExp('class="' + selector.slice(1) + '" aria-label="([^"]+)"'))?.[1]);
    assert.ok(labels.every(Boolean), selector + ' controls must have accessible names');
    assert.equal(new Set(labels).size, labels.length, selector + ' must distinguish same-named devices');
  }
});

test('duplicate names with identical platforms cannot mix per-card folder assignment IDs', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'id-a', name: 'Aynı PC', folderId: 'old'}),
    device({id: 'id-b', name: 'Aynı PC', folderId: 'old'}),
  ], {folders: [{id: 'old', name: 'Eski'}, {id: 'new', name: 'Yeni'}]}));
  const second = h.cards()[1].querySelector('.folder-assign');
  second.value = 'new';
  second.listeners.get('change')();
  assert.equal(h.requests[0].url, '/api/v1/me/device-folders/assign');
  assert.equal(JSON.parse(h.requests[0].options.body).deviceId, 'id-b');
  assert.equal(JSON.parse(h.requests[0].options.body).folderId, 'new');
});

test('same-named device cards retain exact target IDs when their order changes', () => {
  const h = harness();
  const a = device({id: 'stable-a', name: 'Aynı PC'});
  const b = device({id: 'stable-b', name: 'Aynı PC'});
  h.render(snapshot([a, b]));
  h.cards()[1].querySelector('.access-toggle').listeners.get('click')();
  h.render(snapshot([b, a]));
  h.cards()[0].querySelector('.access-toggle').listeners.get('click')();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map(item => JSON.parse(item.options.body).deviceId),
    ['stable-b', 'stable-b']);
});

test('stale Broker-ready telemetry on offline device does not render online/ready', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'desk-off', online: false, privilegeMode: 'broker', adminBridgeReady: true}),
    device({id: 'desk-on', online: true, privilegeMode: 'direct', adminBridgeReady: false}),
  ]));
  assert.equal(h.id('devices-detail').textContent, '1 çevrimiçi');
  const [offline, online] = h.cards();
  assert.ok(offline.classList.contains('offline'));
  assert.equal(offline.querySelector('.status-text').textContent, 'Çevrimdışı');
  assert.equal(offline.querySelector('.bridge-chip').textContent, 'Broker durumu bilinmiyor');
  assert.equal(offline.querySelector('.bridge-live-status').textContent, 'ÇEVRİMDIŞI');
  assert.equal(online.querySelector('.status-text').textContent, 'Çevrimiçi');
  assert.equal(online.querySelector('.bridge-chip').textContent, 'Broker doğrulanmadı');
});

test('offline FULL device with stale CORE/ROOT flags stays unverified and cannot apply Broker', () => {
  const h = harness();
  h.render(snapshot([device({
    online: false, accessMode: 'full', privilegeMode: 'broker', adminBridgeReady: true,
    persistentMaintenance: {enabled: true, active: true},
    rootMode: {active: true, expiresAt: new Date(Date.now() + 60_000).toISOString()},
  })]));
  const card = h.cards()[0];
  assert.equal(card.querySelector('.status-text').textContent, 'Çevrimdışı');
  assert.match(card.querySelector('.root-state-chip').textContent, /BEKLEMEDE/);
  assert.equal(card.querySelector('.core-shortcut').textContent, 'CORE BEKLEMEDE');
  assert.equal(card.querySelector('.bridge-apply-toggle').disabled, true);
  assert.doesNotMatch(card.querySelector('.bridge-chip').textContent, /hazır/i);
});

test('an online Broker readiness notice is not labelled a verified command outcome', () => {
  const h = harness();
  h.render(snapshot([device({privilegeMode: 'broker', adminBridgeReady: true})]));
  const card = h.cards()[0];
  assert.equal(card.querySelector('.bridge-chip').textContent, 'Broker hazır bildirimi');
  assert.match(card.querySelector('.bridge-copy').textContent, /uygulandığına dair kanıt değildir/);
});

test('folder filtering keeps exact membership and handles no visible device', () => {
  const h = harness();
  const data = snapshot([
    device({id: 'a', folderId: 'folder-a'}),
    device({id: 'b', folderId: 'folder-b'}),
  ], {folders: [{id: 'folder-a', name: 'Ofis'}, {id: 'folder-b', name: 'Depo'}]});
  h.setFolder('folder-b');
  h.render(data);
  assert.deepEqual(h.cards().map(card => card.dataset.deviceId), ['b']);
  h.setFolder('unassigned');
  h.render(data);
  assert.equal(h.cards().length, 1);
  assert.ok(h.cards()[0].classList.contains('empty'));
});

test('long Unicode and HTML-like names are written into text sinks, not HTML templates', () => {
  const h = harness();
  const name = '🖥️ İŞ-Özel-电脑 <img src=x onerror=alert(1)> ' + 'Ç'.repeat(130);
  h.render(snapshot([device({name, platform: 'linux <svg/onload=alert(1)>'})]));
  const card = h.cards()[0];
  assert.equal(card.querySelector('.device-name').textContent, name);
  assert.equal(card.querySelector('.platform').textContent, 'linux <svg/onload=alert(1)>');
  assert.equal(card.template.includes(name), false);
  assert.match(appSource, /row\.querySelector\('\.device-name'\)\.textContent = device\.name/);
  assert.match(appSource, /row\.querySelector\('\.platform'\)\.textContent = device\.platform/);
});

test('AUTO off and multiple cards do not advertise implicit MCP target selection', () => {
  const h = harness();
  h.render(snapshot([device({id: 'a'}), device({id: 'b'})]));
  assert.equal(h.id('auto-status').textContent, 'Kapalı · cihaz belirtilmediyse seçim zorunlu.');
  assert.equal(h.id('auto-toggle').textContent, 'Otomatik seçimi aç');
  assert.equal(h.id('auto-confirm-panel').hidden, true);
  h.render(snapshot([device({id: 'a'}), device({id: 'b'})], {autoSelectDevices: true}));
  assert.match(h.id('auto-status').textContent, /yalnızca tek uygun cihaz seçilebilir/);
  assert.match(h.id('auto-status').textContent, /MCP entegrasyonu ayrıca doğrulanmalıdır/);
});

test('pending dashboard reload cannot retain a previously successful device count', {
  todo: !hasLoadingReset && 'K03 owns the pending/401/error presentation reset in web/app.js',
}, () => {
  const h = harness();
  h.render(snapshot([device({id: 'known'})]));
  h.setFetch(() => new Promise(() => {}));
  void h.load();
  assert.equal(h.id('devices-count').textContent, '—');
  assert.equal(h.id('devices').getAttribute('aria-busy'), 'true');
  assert.equal(h.id('connect-device').disabled, true);
  assert.match(h.id('device-list-status').textContent, /yükleniyor/);
});

test('dashboard 401 and 503 cannot appear as successful empty device inventory', {
  todo: !hasLoadingReset && 'K03 owns the distinct unauthenticated/error list states',
}, async () => {
  const h = harness();
  h.render(snapshot([device({id: 'known'})]));
  h.setFetch(async () => ({status: 401, ok: false}));
  await h.load();
  assert.equal(h.id('devices-count').textContent, '—');
  assert.match(h.id('device-list-status').textContent, /giriş yap/);
  assert.equal(h.id('devices').getAttribute('aria-busy'), 'false');
  h.setFetch(async () => ({status: 503, ok: false}));
  await h.load();
  assert.equal(h.id('devices-count').textContent, '—');
  assert.match(h.id('device-list-status').textContent, /yüklenemedi/);
  assert.equal(h.id('connection-pill').textContent, 'Bağlantı hatası');
});

test('rendering an AUTO preference is not an MCP permission or implicit target grant', () => {
  assert.match(appSource, /snapshot\.autoSelectDevices === true/);
  assert.match(mcpSource, /ownerAuto && ownerIds\.length === 1 && onlineIds\.has\(ownerIds\[0\]!\)/);
  assert.match(mcpSource, /DEVICE_SELECTION_REQUIRED: Call devices_list/);
  assert.match(mcpSource, /hasMcpTargetRestrictions\(ctx\.toolAuthorization\)/);
});
