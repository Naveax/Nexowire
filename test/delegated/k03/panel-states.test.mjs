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
  }
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
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  querySelector(selector) {
    if (selector === '.filter-count') return this.filterCount;
    throw new Error('Unexpected fake querySelector: ' + selector);
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
  assert.match(app, /row\.setAttribute\('aria-label', 'Cihaz: ' \+ device\.name\)/);
  assert.match(app, /pcButton\.setAttribute\('aria-label', device\.name \+ ' PC ayarları'\)/);
  assert.match(app, /folderSelect\.setAttribute\('aria-label', device\.name \+ ' cihazının klasörü'\)/);
  assert.doesNotMatch(app, /innerHTML\s*=\s*device\.(?:name|platform)/);
});
