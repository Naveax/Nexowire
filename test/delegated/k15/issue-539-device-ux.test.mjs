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


test('T-339/#539: identical device names never collapse stable target IDs', () => {
  const h = harness();
  const first = device({id: 'machine-a', name: 'Ortak PC'});
  const second = device({id: 'machine-b', name: 'Ortak PC'});
  h.render(snapshot([first, second]));
  assert.deepEqual(h.cards().map(card => card.dataset.deviceId), ['machine-a', 'machine-b']);
  h.cards()[1].querySelector('.access-toggle').listeners.get('click')();
  h.render(snapshot([second, first]));
  h.cards()[0].querySelector('.access-toggle').listeners.get('click')();
  assert.deepEqual(h.requests.map(req => JSON.parse(req.options.body).deviceId),
    ['machine-b', 'machine-b']);
});

test('T-339/T-343/#539: bridge preference and folder actions keep their device ID after reorder', () => {
  const h = harness();
  const first = device({id: 'machine-a', name: 'Ortak PC'});
  const second = device({id: 'machine-b', name: 'Ortak PC'});
  const folder = {id: 'warehouse', name: 'Depo'};
  // Keep writes unresolved: the test observes the actual generated POST,
  // not an imagined successful Broker operation or a later server response.
  h.setFetch(() => new Promise(() => {}));
  h.render(snapshot([first, second], {folders: [folder]}));
  const before = h.cards()[1];
  before.querySelector('.bridge-quick-toggle').listeners.get('click')();
  before.querySelector('.folder-assign').value = 'warehouse';
  before.querySelector('.folder-assign').listeners.get('change')();

  h.render(snapshot([second, first], {folders: [folder]}));
  const after = h.cards()[0];
  after.querySelector('.bridge-quick-toggle').listeners.get('click')();
  after.querySelector('.folder-assign').value = 'warehouse';
  after.querySelector('.folder-assign').listeners.get('change')();

  assert.deepEqual(h.requests.map(request => request.url), [
    '/api/v1/me/devices/bridge-preference',
    '/api/v1/me/device-folders/assign',
    '/api/v1/me/devices/bridge-preference',
    '/api/v1/me/device-folders/assign',
  ]);
  for (const request of h.requests) {
    assert.equal(JSON.parse(request.options.body).deviceId, 'machine-b');
    assert.equal(request.options.credentials, 'include');
  }
  assert.equal(JSON.parse(h.requests[1].options.body).folderId, 'warehouse');
  assert.equal(JSON.parse(h.requests[3].options.body).folderId, 'warehouse');
});

test('T-339/T-343/#539: same-named cards have distinct screen-reader action names', {
  todo: !hasDeviceLabelFix && '#1068 is unmerged; current main still repeats accessible action names',
}, () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'a', name: 'Ortak PC'}),
    device({id: 'b', name: 'Ortak PC'}),
  ]));
  for (const selector of ['.core-shortcut', '.bridge-quick-toggle', '.pc-settings-button', '.folder-assign']) {
    const names = h.cards().map(card => card.querySelector(selector).getAttribute('aria-label'));
    assert.ok(names.every(Boolean), selector + ' accessible names must exist');
    assert.equal(new Set(names).size, 2, selector + ' must disambiguate repeated names');
  }
});

test('T-340/#812: FULL and browser-provided CORE/ROOT flags are not effective authorization', () => {
  const h = harness();
  h.render(snapshot([device({
    id: 'permission-display', online: true, accessMode: 'full',
    privilegeMode: 'broker', adminBridgeReady: true,
    persistentMaintenance: {enabled: true, active: true},
    rootMode: {active: true, expiresAt: new Date(Date.now() + 60_000).toISOString()},
  })]));
  const row = h.cards()[0];
  assert.equal(row.querySelector('.access-mode').textContent, 'FULL ACCESS');
  assert.equal(row.querySelector('.core-shortcut').textContent, 'CORE BEKLEMEDE');
  assert.match(row.querySelector('.root-state-chip').textContent, /BEKLEMEDE/);
  assert.match(row.querySelector('.bridge-copy').textContent, /kanıt değildir/);
});

test('T-341/#539: offline and missing online telemetry never render a false positive', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'online', online: true}),
    device({id: 'offline', online: false, privilegeMode: 'broker', adminBridgeReady: true}),
    device({id: 'unknown', online: undefined, privilegeMode: 'broker', adminBridgeReady: true}),
  ]));
  assert.equal(h.id('devices-detail').textContent, '1 çevrimiçi');
  assert.deepEqual(h.cards().map(card => card.querySelector('.status-text').textContent),
    ['Çevrimiçi', 'Çevrimdışı', 'Çevrimdışı']);
  for (const row of h.cards().slice(1)) {
    assert.equal(row.querySelector('.bridge-chip').textContent, 'Broker durumu bilinmiyor');
    assert.equal(row.querySelector('.bridge-apply-toggle').disabled, true);
  }
});

test('T-340/T-341/#812: offline stale Broker flags cannot enable a real device command', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'offline-broker', online: false, accessMode: 'full',
      platform: 'win32', privilegeMode: 'broker', adminBridgeReady: true,
      bridgePreference: {desiredMode: 'on'}}),
    device({id: 'online-safe', online: true, accessMode: 'safe',
      platform: 'win32', privilegeMode: 'broker', adminBridgeReady: true}),
    device({id: 'online-other-os', online: true, accessMode: 'full',
      platform: 'darwin', privilegeMode: 'broker', adminBridgeReady: true}),
  ]));
  for (const card of h.cards()) {
    const action = card.querySelector('.bridge-apply-toggle');
    assert.equal(action.disabled, true, card.dataset.deviceId);
    assert.match(action.title, /Windows, çevrimiçi, FULL ve Broker/);
  }
  assert.equal(h.requests.length, 0, 'rendering stale flags never dispatches a command');
});

test('T-342/#485: no device selected cannot imply automatic MCP target or setup completion', () => {
  const h = harness();
  h.render(snapshot([]));
  assert.match(h.cards()[0].textContent, /Henüz bağlı cihaz yok/);
  assert.equal(h.id('auto-status').textContent, 'Kapalı · cihaz belirtilmediyse seçim zorunlu.');
  assert.equal(h.id('auto-toggle').textContent, 'Otomatik seçimi aç');
  assert.equal(h.id('auto-confirm-panel').hidden, true);
  assert.equal(h.id('connect-device').disabled, false);
  h.render(snapshot([device({id: 'single'})]));
  assert.equal(h.id('auto-status').textContent, 'Kapalı · cihaz belirtilmediyse seçim zorunlu.');
});

test('T-343/#539: device platform and Unicode name remain literal text, never HTML', () => {
  const h = harness();
  const name = '📟 Özel-电脑-İş <img src=x onerror=alert(1)> ' + 'Ş'.repeat(80);
  const platform = 'win32 <svg/onload=alert(1)>';
  h.render(snapshot([device({id: 'unicode', name, platform})]));
  const row = h.cards()[0];
  assert.equal(row.querySelector('.device-name').textContent, name);
  assert.equal(row.querySelector('.platform').textContent, platform);
  assert.equal(row.template.includes(name), false);
  assert.match(appSource, /row\.querySelector\('\.device-name'\)\.textContent = device\.name/);
});

test('T-344/#539: owner UI pending/401/error source clears stale counts', {
  todo: !hasLoadingReset && '#1068 UI reset has not landed in upstream main',
}, async () => {
  const h = harness();
  h.render(snapshot([device({id: 'loaded'})]));
  h.setFetch(() => new Promise(() => {}));
  void h.load();
  assert.equal(h.id('devices-count').textContent, '—');
  assert.equal(h.id('devices').getAttribute('aria-busy'), 'true');
  h.setFetch(async () => ({ok: false, status: 401}));
  await h.load();
  assert.match(h.id('device-list-status').textContent, /giriş yap/);
  h.setFetch(async () => ({ok: false, status: 503}));
  await h.load();
  assert.match(h.id('device-list-status').textContent, /yüklenemedi/);
  assert.equal(h.id('connection-pill').textContent, 'Bağlantı hatası');
  assert.equal(h.id('devices-count').textContent, '—');
});

test('T-344/#539: late success cannot resurrect private device cards after a newer 401', {
  todo: !hasLoadingReset && '#1068 unmerged; main lacks request generation fencing',
}, async () => {
  const h = harness();
  const pending = [];
  h.render(snapshot([device({id: 'prior-private-device'})]));
  h.setFetch(() => new Promise(resolve => pending.push(resolve)));
  const older = h.load();
  const newer = h.load();
  assert.equal(pending.length, 2);

  pending[1]({status: 401, ok: false});
  await newer;
  pending[0]({status: 200, ok: true,
    json: async () => snapshot([device({id: 'stale-private-device'})])});
  await older;

  assert.equal(h.id('devices-count').textContent, '—');
  assert.equal(h.cards().some(card => card.dataset.deviceId === 'stale-private-device'), false);
  assert.equal(h.id('login').classList.contains('hidden'), false);
  assert.match(h.id('device-list-status').textContent, /giriş yap/);
});

test('T-340/T-342: UI AUTO display never replaces server authorization', () => {
  const h = harness();
  h.render(snapshot([
    device({id: 'a', online: true}),
    device({id: 'b', online: false}),
  ], {autoSelectDevices: true}));
  assert.match(h.id('auto-status').textContent, /MCP entegrasyonu ayrıca doğrulanmalıdır/);
  assert.match(mcpSource, /ownerAuto && ownerIds\.length === 1 && onlineIds\.has\(ownerIds\[0\]!\)/);
  assert.match(mcpSource, /DEVICE_SELECTION_REQUIRED: Call devices_list/);
});
