import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Issue #812: a local console-grant snapshot is not effective runtime input
// evidence. This is read-only UI contract coverage; it never calls Windows.
const source = readFileSync(new URL('../../../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../../web/index.html', import.meta.url), 'utf8');
const bootstrap = source.indexOf("$('folder-filter').addEventListener('change'");
assert.ok(bootstrap > 0);

class Classes {
  #values = new Set();
  add(value) { this.#values.add(value); }
  contains(value) { return this.#values.has(value); }
  toggle(value, force) {
    if (force ?? !this.contains(value)) this.add(value);
    else this.#values.delete(value);
  }
}

class Element {
  constructor() {
    this.children = [];
    this.elements = new Map();
    this.classList = new Classes();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this._text = '';
  }
  set className(value) {
    this._className = String(value);
    this.classList = new Classes();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }
  get className() { return this._className ?? ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(value) { this.template = value; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener() {}
  appendChild(value) { this.children.push(value); return value; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = [...values]; }
  add(value) { this.children.push(value); }
  focus() {}
  scrollIntoView() {}
  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new Element());
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

function card(fields) {
  const elements = new Map();
  const filters = ['all', 'safe', 'full', 'root', 'persistent'].map((filter) => {
    const button = new Element();
    button.dataset.filter = filter;
    return button;
  });
  const layouts = ['grid', 'list'].map((layout) => {
    const button = new Element();
    button.dataset.layout = layout;
    return button;
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: () => new Element(),
    querySelectorAll: (selector) => ({ '[data-filter]': filters, '[data-layout]': layouts })[selector] ?? [],
  };
  const context = vm.createContext({
    document, Date, Intl, Number, Math, Set,
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
  });
  vm.runInContext(source.slice(0, bootstrap), context);
  context.fixture = {
    displayName: null, planId: 'free', billingMode: 'free',
    usage: { usedCredits: 0, monthlyCredits: 100 }, folders: [],
    autoSelectDevices: false,
    devices: [{
      id: 'synthetic-device', name: 'Test bilgisayarı', platform: 'win32',
      online: true, accessMode: 'full', privilegeMode: 'direct',
      adminBridgeReady: false, rootMode: { active: false, expiresAt: null },
      persistentMaintenance: { enabled: false, active: false },
      bridgePreference: { desiredMode: 'auto' },
      agentVersion: null, lastSeenAt: null,
      ...fields,
    }],
  };
  vm.runInContext('render(fixture)', context);
  return elements.get('devices').children[0];
}

function presentation(device) {
  const selectors = ['.status-text', '.bridge-chip', '.bridge-live-status',
    '.access-mode', '.root-copy', '.core-copy', '.bridge-copy', '.bridge-mode-feedback'];
  return selectors.map((selector) => device.querySelector(selector).textContent).join(' | ');
}

test('local grant inactive does not force a false input-disabled label (#812)', () => {
  const observed = card({
    consoleControl: { active: false, grantId: null },
    inputObservation: { pointerOk: true, keyboardOk: true },
  });
  const unknown = card({
    consoleControl: { active: false, grantId: null },
    inputObservation: null,
  });
  const observedCopy = presentation(observed);
  assert.equal(observedCopy, presentation(unknown), 'unverified extra fields must not assert effective input');
  assert.match(observedCopy, /FULL ACCESS/);
  assert.match(observedCopy, /Broker doğrulanmadı/);
  assert.doesNotMatch(observedCopy, /(?:fare|klavye).*(?:kapalı|devre dışı)/i);
  assert.doesNotMatch(observedCopy, /(?:fare|klavye).*(?:etkin|onaylı)/i);
});

test('grant active alone does not invent verified Windows input or UAC authority', () => {
  const element = card({
    consoleControl: { active: true, grantId: 'fixture-only' },
    inputObservation: { pointerOk: false, keyboardOk: false },
  });
  const copy = presentation(element);
  assert.match(copy, /Broker doğrulanmadı/);
  assert.doesNotMatch(copy, /Windows (?:UAC|SYSTEM) (?:onaylandı|etkin)/i);
  assert.doesNotMatch(copy, /İmzalı cihaz onayı alındı/i);
});

test('offline telemetry does not turn into live broker or console authority', () => {
  const element = card({
    online: false, accessMode: 'full', privilegeMode: 'broker', adminBridgeReady: true,
    consoleControl: { active: true }, inputObservation: { pointerOk: true },
  });
  assert.equal(element.querySelector('.status-text').textContent, 'Çevrimdışı');
  assert.equal(element.querySelector('.bridge-chip').textContent, 'Broker durumu bilinmiyor');
  assert.match(element.querySelector('.bridge-copy').textContent, /Son Broker bilgisi güncel kabul edilemez/);
  assert.match(presentation(element), /çevrimdışı/i);
});

test('visible owner policy keeps ROOT, CORE, Broker and Windows consent distinct', () => {
  assert.match(html, /ROOT izni işletim sistemi yetkilerini artırmaz/);
  assert.match(html, /Windows UAC korunur/);
  assert.match(html, /Broker, UAC ve cihaz yetkileri ayrıca denetlenir/);
});
