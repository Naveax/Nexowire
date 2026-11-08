import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// #539/R18 / K03 T-407 and T-408. Real web/app.js is executed with fake
// DOM/HTTP only. These are intentionally RED until the web owner resolves the
// display mismatch. No Windows, Hub, Agent or Broker is contacted.
// An optional pinned source lets the maintainer verify the exact unmerged
// owner candidate without copying that candidate into this PR.
const app = process.env.K03_APP_SOURCE_JSON
  ? JSON.parse(process.env.K03_APP_SOURCE_JSON)
  : readFileSync(process.env.K03_APP_SOURCE ?? new URL('../../../web/app.js', import.meta.url), 'utf8');
const boundary = app.indexOf("$('folder-filter').addEventListener('change'");
assert.ok(boundary > 0, 'web/app.js bootstrap boundary');

function emptyDashboard() {
  class Element {
    constructor() {
      this.textContent = '';
      this.children = [];
      this.style = {};
      this.classList = { toggle() {}, add() {} };
      this.elements = new Map();
    }
    replaceChildren(...children) { this.children = children; }
    appendChild(child) { this.children.push(child); }
    add(item) { this.children.push(item); }
    setAttribute(name, value) { (this.attributes ??= new Map()).set(name, value); }
    querySelector(selector) {
      if (!this.elements.has(selector)) this.elements.set(selector, new Element());
      return this.elements.get(selector);
    }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      createElement: () => new Element(),
    },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Date, Intl, Number, Math, Set,
  });
  vm.runInContext(app.slice(0, boundary), context);
  vm.runInContext(`render({
    displayName: null, planId: 'free', billingMode: 'free',
    usage: { monthlyCredits: 100, usedCredits: 0 },
    devices: [], folders: [], autoSelectDevices: false,
  })`, context);
  return {
    pill: get('connection-pill').textContent,
    count: get('devices-count').textContent,
    empty: get('devices').children[0]?.textContent,
  };
}

function bridgeSequence(statuses, { requestId = 'request-3' } = {}) {
  const history = [];
  const status = {
    set textContent(value) { history.push(String(value)); },
    get textContent() { return history.at(-1) ?? ''; },
  };
  const nodes = new Map([
    ['.bridge-command-status', status],
    ['.bridge-apply-panel', { hidden: false }],
    ['.bridge-apply-phrase', { value: 'APPLY BRIDGE MODE', focus() {} }],
    ['.bridge-apply-toggle', { disabled: false }],
    ['.bridge-apply-approve', { disabled: false }],
  ]);
  const row = { querySelector: (selector) => {
    assert.ok(nodes.has(selector), `Unknown selector: ${selector}`);
    return nodes.get(selector);
  } };
  const replies = [
    { status: 'queued', requestId, expiresAt: '2099-01-01T00:00:00.000Z' },
    ...statuses.map((state) => ({
      requestId, deviceId: 'device-3', status: state,
    })),
  ];
  let reloads = 0;
  let fetchCalls = 0;
  const context = vm.createContext({
    document: { getElementById: () => { throw Error('Unexpected DOM access'); } },
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => {
        fetchCalls += 1;
        assert.ok(replies.length, 'Exceeded bounded fixture response count');
        return replies.shift();
      },
    }),
    setTimeout: (resolve) => resolve(),
    Date, Intl, Number, Math, Set, encodeURIComponent,
  });
  vm.runInContext(app.slice(0, boundary), context);
  context.__row = row;
  vm.runInContext('load = async () => { globalThis.reloads = (globalThis.reloads || 0) + 1; }', context);
  return {
    history,
    get fetchCalls() { return fetchCalls; },
    run: async () => {
      await vm.runInContext("applyDeviceBridgeMode('device-3', 'on', __row)", context);
      reloads = context.reloads ?? 0;
      return reloads;
    },
  };
}

test('T-407: empty account must not announce a connected device', () => {
  const state = emptyDashboard();
  assert.equal(state.count, '0');
  assert.match(state.empty, /Henüz bağlı cihaz yok/);
  assert.notEqual(state.pill, 'Bağlı', 'Response loaded is not proof of a connected device');
});

test('T-408: delayed queued response must not regress claimed progress', async () => {
  const bridge = bridgeSequence(['claimed', 'queued', 'expired']);
  const reloads = await bridge.run();
  assert.equal(reloads, 0);
  const claimed = bridge.history.findIndex((line) => /cihazda işleniyor/.test(line));
  assert.ok(claimed >= 0, 'Claimed progress must be visible');
  assert.ok(
    !bridge.history.slice(claimed + 1).some((line) => /kuyrukta/.test(line)),
    'Older queued poll must not overwrite later claimed progress',
  );
});

test('T-408: unknown outcome after claimed cannot announce applied', async () => {
  const bridge = bridgeSequence(['claimed', 'UNKNOWN']);
  const reloads = await bridge.run();
  assert.equal(reloads, 0);
  assert.match(bridge.history.at(-1), /Beklenmeyen cihaz komut durumu/);
  assert.ok(bridge.history.every((line) => !/İmzalı cihaz onayı alındı/.test(line)));
});

test('T-408: empty command receipt must not poll into a false applied result', async () => {
  const bridge = bridgeSequence(['applied'], { requestId: '' });
  const reloads = await bridge.run();
  assert.equal(reloads, 0, 'An empty command identity cannot prove a device transition');
  assert.equal(bridge.fetchCalls, 1, 'Invalid issue receipt must not be polled');
  assert.ok(bridge.history.every((line) => !/İmzalı cihaz onayı alındı/.test(line)));
});
