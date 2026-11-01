import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../../web/app.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, enabled) {
    if (enabled ?? !this.values.has(name)) this.values.add(name);
    else this.values.delete(name);
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this._text = '';
    this.listeners = new Map();
    this.elements = new Map();
  }
  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }
  get className() { return this._className ?? ''; }
  set innerHTML(value) { this.template = value; }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(element) { this.children.push(element); return element; }
  replaceChildren(...elements) { this._text = ''; this.children = elements; }
  add(option) { this.children.push(option); }
  append(...elements) { this.children.push(...elements); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  querySelector(selector) {
    if (selector === '.filter-count') return this.filterCount;
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

function createApp() {
  const ids = new Map();
  const byId = (id) => {
    if (!ids.has(id)) ids.set(id, new FakeElement(id));
    return ids.get(id);
  };
  const filters = ['all', 'safe', 'full', 'root', 'persistent'].map((filter) => {
    const el = new FakeElement();
    el.dataset.filter = filter;
    el.filterCount = new FakeElement();
    return el;
  });
  const layouts = ['grid', 'list'].map((layout) => {
    const el = new FakeElement();
    el.dataset.layout = layout;
    return el;
  });
  let fetchResult = () => new Promise(() => {});
  const context = vm.createContext({
    document: {
      getElementById: byId,
      createElement: () => new FakeElement(),
      querySelectorAll: (selector) => ({
        '[data-filter]': filters,
        '[data-layout]': layouts,
        '.root-clock[data-expires-at]': [],
        '.utility-panel': [],
      })[selector] ?? [],
      querySelector: (selector) => {
        if (selector === '.device-layout') return byId('device-layout');
        throw new Error('Unexpected fake document querySelector: ' + selector);
      },
    },
    Option: class extends FakeElement {
      constructor(text, value) { super(); this.textContent = text; this.value = value; }
    },
    fetch: (...args) => fetchResult(...args),
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { location: { pathname: '/' } },
    setInterval: () => 1,
    Date,
    Intl,
    Set,
  });
  vm.runInContext(app, context, { filename: 'web/app.js' });
  return {
    el: byId,
    filters,
    layouts,
    eval: (expression) => vm.runInContext(expression, context),
    setFetch: (fn) => { fetchResult = fn; },
  };
}

const snapshot = {
  displayName: 'Test', planId: 'free', billingMode: 'free',
  usage: { monthlyCredits: null, usedCredits: 0 },
  devices: [], folders: [], autoSelectDevices: false,
};

test('initial HTML exposes one concise live status outside the device list', () => {
  assert.match(html, /id="device-list-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="devices"[^>]*aria-label="Cihazlar"[^>]*aria-busy="true"/);
  assert.doesNotMatch(html, /id="devices"[^>]*aria-live=/);
  assert.match(html, /id="connect-device"[^>]*disabled/);
});

test('empty list render marks loading complete and enables connection', () => {
  const ui = createApp();
  ui.setFetch(() => new Promise(() => {}));
  // The fixture is passed through VM context without hitting any API.
  ui.eval('globalThis.fixture = ' + JSON.stringify(snapshot));
  ui.eval('render(fixture)');
  assert.equal(ui.el('devices-count').textContent, '0');
  assert.equal(ui.el('devices').getAttribute('aria-busy'), 'false');
  assert.match(ui.el('devices').textContent, /Henüz bağlı cihaz yok/);
  assert.equal(ui.el('device-list-status').textContent, ui.el('devices').textContent);
  assert.equal(ui.el('connect-device').disabled, false);
});

test('empty folder filtering is described accurately, never as an empty account', () => {
  const ui = createApp();
  const data = { ...snapshot, devices: [{ id: 'offline-1', online: false, folderId: null }],
    folders: [{ id: 'chosen', name: 'Başka klasör' }] };
  ui.eval('globalThis.fixture = ' + JSON.stringify(data));
  ui.eval("selectedFolder = 'chosen'; render(fixture)");
  assert.equal(ui.el('devices-count').textContent, '1');
  assert.equal(ui.el('devices-detail').textContent, '0 çevrimiçi');
  assert.match(ui.el('devices').textContent, /Seçilen klasör ve erişim filtresine uyan/);
});

test('unverified CORE filter never claims active CORE access', () => {
  const ui = createApp();
  const data = { ...snapshot, devices: [{ id: 'one', online: true,
    persistentMaintenance: { active: true }, accessMode: 'full' }] };
  ui.eval('globalThis.fixture = ' + JSON.stringify(data));
  ui.eval("selectedDeviceFilter = 'persistent'; render(fixture)");
  assert.match(ui.el('devices').textContent, /CORE durumu doğrulanmış cihaz bulunmuyor/);
  assert.equal(ui.el('devices').getAttribute('aria-busy'), 'false');
});

test('a retry invalidates previously loaded counters before an API response', async () => {
  const ui = createApp();
  ui.eval('globalThis.fixture = ' + JSON.stringify(snapshot));
  ui.eval('render(fixture)');
  ui.setFetch(() => new Promise(() => {}));
  void ui.eval('load()');
  assert.equal(ui.el('devices-count').textContent, '—');
  assert.equal(ui.el('connect-device').disabled, true);
  assert.equal(ui.el('devices').getAttribute('aria-busy'), 'true');
  assert.match(ui.el('device-list-status').textContent, /yükleniyor/);
  assert.ok(ui.filters.every((button) => button.disabled && button.filterCount.textContent === '—'));
  assert.ok(ui.layouts.every((button) => button.disabled));
  assert.equal(ui.el('folder-filter').disabled, true);
});

test('401 and server failures leave no stale success controls or counts', async () => {
  const ui = createApp();
  ui.eval('globalThis.fixture = ' + JSON.stringify(snapshot));
  ui.eval('render(fixture)');
  ui.setFetch(async () => ({ status: 401, ok: false }));
  await ui.eval('load()');
  assert.equal(ui.el('devices-count').textContent, '—');
  assert.equal(ui.el('connect-device').disabled, true);
  assert.equal(ui.el('login').classList.contains('hidden'), false);
  assert.match(ui.el('devices').textContent, /giriş yap/);
  assert.equal(ui.el('devices').getAttribute('aria-busy'), 'false');

  ui.setFetch(async () => ({ status: 503, ok: false }));
  await ui.eval('load()');
  assert.equal(ui.el('login').classList.contains('hidden'), true);
  assert.equal(ui.el('connection-pill').textContent, 'Bağlantı hatası');
  assert.match(ui.el('devices').textContent, /yeniden dene/);
  assert.equal(ui.el('devices-count').textContent, '—');
});

test('recovery after a failure renders only the new verified snapshot', async () => {
  const ui = createApp();
  ui.setFetch(async () => ({ status: 503, ok: false }));
  await ui.eval('load()');
  ui.setFetch(async () => ({ status: 200, ok: true, json: async () => snapshot }));
  await ui.eval('load()');
  assert.equal(ui.el('devices-count').textContent, '0');
  assert.equal(ui.el('devices').getAttribute('aria-busy'), 'false');
  assert.equal(ui.el('error-panel').classList.contains('hidden'), true);
  assert.equal(ui.el('connect-device').disabled, false);
  assert.ok(ui.filters.every((button) => !button.disabled));
  assert.ok(ui.layouts.every((button) => !button.disabled));
  assert.equal(ui.el('folder-filter').disabled, false);
});

test('long device names remain text, with per-device control names', () => {
  assert.match(app, /querySelector\('\.device-name'\)\.textContent = device\.name/);
  assert.match(app, /row\.setAttribute\('aria-label', deviceLabel\)/);
  assert.match(app, /pcButton\.setAttribute\('aria-label', deviceLabel \+ ' · PC ayarları'\)/);
  assert.match(app, /folderSelect\.setAttribute\('aria-label', deviceLabel \+ ' · klasör'\)/);
  assert.doesNotMatch(app, /innerHTML\s*=\s*device\.(?:name|platform)/);
});

const device = (overrides = {}) => ({
  id: 'device-a', name: 'Ofis PC', platform: 'win32', online: true,
  accessMode: 'safe', privilegeMode: 'direct', adminBridgeReady: false,
  agentVersion: null, lastSeenAt: null, folderId: null,
  rootMode: { active: false, expiresAt: null },
  persistentMaintenance: { enabled: false, active: false },
  bridgePreference: { desiredMode: 'auto' },
  ...overrides,
});

test('same-name devices have unique accessible card and action names', () => {
  const ui = createApp();
  const data = { ...snapshot, devices: [
    device({ id: 'desktop-a' }), device({ id: 'desktop-b' }),
  ] };
  ui.eval('globalThis.fixture = ' + JSON.stringify(data));
  ui.eval('render(fixture)');
  const cards = ui.el('devices').children;
  assert.deepEqual(cards.map((card) => card.dataset.deviceId), ['desktop-a', 'desktop-b']);
  for (const selector of [null, '.core-shortcut', '.bridge-quick-toggle', '.bridge-toggle',
    '.folder-assign', '.pc-settings-button']) {
    const labels = cards.map((card) => (selector ? card.querySelector(selector) : card).getAttribute('aria-label'));
    assert.ok(labels.every((label) => label && label.includes('Ofis PC')), `${selector} must name the device`);
    assert.notEqual(labels[0], labels[1], `${selector} must distinguish duplicate device names`);
    assert.match(labels[0], /cihaz 1/);
    assert.match(labels[1], /cihaz 2/);
  }
  assert.equal(cards[0].querySelector('.device-name').textContent, 'Ofis PC');
  assert.equal(cards[1].querySelector('.device-name').textContent, 'Ofis PC');
});

test('long Unicode and HTML-like device names are text only', () => {
  const ui = createApp();
  const name = '🖥️ İş-Özel-电脑 <img src=x onerror=alert(1)> ' + 'Ç'.repeat(160);
  const data = { ...snapshot, devices: [device({ name, platform: 'linux <svg/onload=alert(1)>' })] };
  ui.eval('globalThis.fixture = ' + JSON.stringify(data));
  ui.eval('render(fixture)');
  const card = ui.el('devices').children[0];
  assert.equal(card.querySelector('.device-name').textContent, name);
  assert.equal(card.querySelector('.platform').textContent, data.devices[0].platform);
  assert.equal(card.template.includes(name), false);
  assert.equal(card.template.includes(data.devices[0].platform), false);
  assert.match(card.getAttribute('aria-label'), /cihaz 1/);
});

test('a late, older success cannot overwrite a newer verified snapshot', async () => {
  const ui = createApp();
  const resolveRequests = [];
  ui.setFetch(() => new Promise((resolve) => resolveRequests.push(resolve)));
  const oldLoad = ui.eval('load()');
  const newLoad = ui.eval('load()');
  const newer = { ...snapshot, usage: { monthlyCredits: null, usedCredits: 9 } };
  resolveRequests[1]({ status: 200, ok: true, json: async () => newer });
  await newLoad;
  assert.equal(ui.el('usage').textContent, '9');
  resolveRequests[0]({ status: 200, ok: true, json: async () =>
    ({ ...snapshot, usage: { monthlyCredits: null, usedCredits: 800 } }) });
  await oldLoad;
  assert.equal(ui.el('usage').textContent, '9');
  assert.equal(ui.el('connection-pill').textContent, 'Bağlı');
});

test('late unauthorized and late JSON replies cannot hide a newer success', async () => {
  const ui = createApp();
  const resolves = [];
  ui.setFetch(() => new Promise((resolve) => resolves.push(resolve)));
  const oldLoad = ui.eval('load()');
  const newLoad = ui.eval('load()');
  resolves[1]({ status: 200, ok: true, json: async () => snapshot });
  await newLoad;
  resolves[0]({ status: 401, ok: false });
  await oldLoad;
  assert.equal(ui.el('login').classList.contains('hidden'), true);
  assert.equal(ui.el('devices-count').textContent, '0');

  let releaseOldJson;
  let notifyOldJsonStarted;
  const oldJsonStarted = new Promise((resolve) => { notifyOldJsonStarted = resolve; });
  ui.setFetch(async () => ({ status: 200, ok: true,
    json: async () => {
      notifyOldJsonStarted();
      return new Promise((resolve) => { releaseOldJson = resolve; });
    } }));
  const oldJsonLoad = ui.eval('load()');
  await oldJsonStarted;
  ui.setFetch(async () => ({ status: 200, ok: true, json: async () => snapshot }));
  await ui.eval('load()');
  releaseOldJson({ ...snapshot, usage: { monthlyCredits: null, usedCredits: 999 } });
  await oldJsonLoad;
  assert.equal(ui.el('usage').textContent, '0');
  assert.equal(ui.el('connection-pill').textContent, 'Bağlı');
});

test('401 clears prior account name, folder names, device list and usage', async () => {
  const ui = createApp();
  const privateName = 'KİŞİSEL-GİZLİ-ADI';
  const privateFolder = 'KİŞİSEL-ÖZEL-KLASÖR';
  const old = { ...snapshot, displayName: privateName,
    usage: { monthlyCredits: null, usedCredits: 571 },
    devices: [device({ name: 'Özel iş bilgisayarı' })],
    folders: [{ id: 'personal', name: privateFolder }] };
  ui.eval('globalThis.fixture = ' + JSON.stringify(old));
  ui.eval('render(fixture)');
  assert.match(ui.el('welcome').textContent, /KİŞİSEL/);
  ui.setFetch(async () => ({ status: 401, ok: false }));
  await ui.eval('load()');
  assert.equal(ui.el('welcome').textContent, 'Kontrol merkezi');
  assert.equal(ui.el('usage').textContent, '—');
  assert.equal(ui.el('plan').textContent, '—');
  assert.equal(ui.el('devices-count').textContent, '—');
  assert.doesNotMatch(ui.el('devices').textContent, /Özel iş bilgisayarı|KİŞİSEL/);
  assert.ok(ui.el('folder-filter').children.every((item) => item.textContent !== privateFolder));
  assert.match(ui.el('device-list-status').textContent, /giriş yap/);
});
