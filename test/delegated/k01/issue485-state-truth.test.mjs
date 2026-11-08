import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';

// Issue #485 / #539 (R01): source-level failure truth, not a live device test.
// Keep this fixture independent of #1068's existing K01 files until integration.
const script = process.env.K01_CONNECT_REF
  ? execFileSync('git', ['show', `${process.env.K01_CONNECT_REF}:web/connect.js`], { encoding: 'utf8' })
  : readFileSync('web/connect.js', 'utf8');

class Node {
  constructor() {
    this.textContent = '';
    this.value = '';
    this.href = '';
    this.disabled = true;
    this.tabIndex = 0;
    this.dataset = {};
    this.attributes = new Map();
    this.classes = new Set();
    this.handlers = new Map();
    this.classList = {
      add: (value) => this.classes.add(value),
      remove: (value) => this.classes.delete(value),
      toggle: (value, force) => force ? this.classes.add(value) : this.classes.delete(value),
    };
  }
  addEventListener(event, callback) { this.handlers.set(event, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest() { return this.row ?? this; }
  focus() { this.focusCount = (this.focusCount ?? 0) + 1; }
  select() { this.selected = true; }
  dispatch(event) {
    const handler = this.handlers.get(event);
    assert.ok(handler, `missing ${event} handler`);
    return handler();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const realCallback = 'http://127.0.0.1:49610/nexowire-connect';
function search(overrides = {}) {
  return '?' + new URLSearchParams({
    callback: realCallback,
    state: 'test-nonce',
    deviceId: 'test-device',
    deviceName: 'Offline test PC',
    platform: 'win32',
    ...overrides,
  });
}

async function flush() {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
}

async function boot({ query = '', dashboard, pairing, metadata } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  const tabs = ['windows', 'macos', 'linux'].map((os) => {
    const tab = new Node();
    tab.dataset.os = os;
    nodes.set(`tab-${os}`, tab);
    return tab;
  });
  get('install-command').row = new Node();
  get('pair-panel').classes.add('hidden');
  get('chatgpt-panel').classes.delete('hidden');
  get('error-panel').classes.add('hidden');
  get('approve').textContent = 'BAĞLA';
  const requests = [], navigations = [], copied = [];
  const origin = 'https://control.fixture.invalid';
  const ctx = createContext({
    URL, URLSearchParams, AbortSignal,
    window: { location: {
      origin, pathname: '/connect.html', search: query,
      replace: (url) => navigations.push(url),
    } },
    navigator: { userAgent: 'Windows NT 10.0', clipboard: {
      writeText: async (value) => copied.push(value),
    } },
    document: {
      getElementById: get,
      querySelectorAll: () => tabs,
      querySelector: () => new Node(),
    },
    fetch: async (path, options = {}) => {
      requests.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/v1/me/dashboard') return dashboard?.() ?? Response.json({});
      if (path === '/api/v1/pairing') return pairing?.() ?? Response.json({ pairingId: 'pair-1', token: 'fixture-value' });
      assert.equal(path, '/.well-known/oauth-protected-resource');
      return metadata?.() ?? Response.json({ resource: 'https://mcp.fixture.invalid/mcp', authorization_servers: [origin] });
    },
  });
  runInContext(script, ctx, { timeout: 1000 });
  await flush();
  return { get, tabs, requests, navigations, copied };
}

function assertNoConnectedClaim(f) {
  assert.notEqual(f.get('connect-pill').textContent, 'Bağlandı');
  assert.notEqual(f.get('status-title').textContent, 'Bağlandı');
}

test('T-255/256 #485: dashboard failure leaves approval blocked, and 401 only redirects to login', async () => {
  for (const status of [500, 503]) {
    const f = await boot({ query: search(), dashboard: async () => Response.json({}, { status }) });
    assert.equal(f.get('approve').disabled, true);
    assert.equal(f.get('connect-pill').textContent, 'Hata');
    assert.equal(f.get('error-panel').classes.has('hidden'), false);
    assert.equal(f.requests.filter(({ path }) => path === '/api/v1/pairing').length, 0);
    assertNoConnectedClaim(f);
  }
  const login = await boot({ query: search(), dashboard: async () => Response.json({}, { status: 401 }) });
  assert.equal(login.get('approve').disabled, true);
  assert.match(login.navigations[0], /^\/auth\/github\/start\?next=/);
  assert.equal(login.requests.filter(({ path }) => path === '/api/v1/pairing').length, 0);
});

test('T-256/259 #485/R11: ready means approval available, not remote device connected', async () => {
  const f = await boot({ query: search(), dashboard: async () => Response.json({ devices: [{ online: false }] }) });
  assert.equal(f.get('connect-pill').textContent, 'Hazır');
  assert.equal(f.get('approve').disabled, false);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.requests.filter(({ path }) => path === '/api/v1/pairing').length, 0);
  assertNoConnectedClaim(f);
  // This page does not subscribe to health/offline events: live disconnection is NOT_RUN.
});

test('T-258 #485: two clicks during a pending POST never issue two pairing requests', async () => {
  const response = deferred();
  const f = await boot({ query: search(), pairing: () => response.promise });
  const first = f.get('approve').dispatch('click');
  await f.get('approve').dispatch('click');
  assert.equal(f.requests.filter(({ path }) => path === '/api/v1/pairing').length, 1);
  assert.equal(f.get('approve').disabled, true);
  assert.equal(f.get('connect-pill').textContent, 'Bağlanıyor');
  assertNoConnectedClaim(f);
  response.resolve(Response.json({ error: 'fixture' }, { status: 503 }));
  await first;
  assert.equal(f.get('connect-pill').textContent, 'Hata');
  assert.equal(f.get('approve').textContent, 'TEKRAR DENE');
  assert.equal(f.navigations.length, 0);
});

test('T-258 #485: retry is serial; a failed response cannot overwrite a later success', async () => {
  const first = deferred(), second = deferred();
  let attempts = 0;
  const f = await boot({
    query: search(),
    pairing: () => ++attempts === 1 ? first.promise : second.promise,
  });
  const firstClick = f.get('approve').dispatch('click');
  await f.get('approve').dispatch('click');
  first.resolve(Response.json({}, { status: 500 }));
  await firstClick;
  assert.equal(f.get('connect-pill').textContent, 'Hata');
  const retry = f.get('approve').dispatch('click');
  await f.get('approve').dispatch('click');
  assert.equal(attempts, 2);
  assert.equal(f.get('connect-pill').textContent, 'Bağlanıyor');
  second.resolve(Response.json({ pairingId: 'pair-2', token: 'fixture-value-2' }));
  await retry;
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).hostname, '127.0.0.1');
  assert.equal(new URL(f.navigations[0]).searchParams.get('state'), 'test-nonce');
});

test('T-257/259 #539/R01: rejected/invalid/timeout discovery cannot claim a usable MCP address', async () => {
  const errors = [
    () => Response.json({}, { status: 503 }),
    () => Response.json({ resource: 'http://localhost/mcp', authorization_servers: ['https://control.fixture.invalid'] }),
    () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
    () => Promise.reject(Object.assign(new Error('request stopped'), { name: 'AbortError' })),
  ];
  for (const metadata of errors) {
    const f = await boot({ metadata });
    assert.equal(f.get('copy-chatgpt-address').disabled, true);
    assert.equal(f.get('chatgpt-address').value, '');
    assert.equal(f.get('connect-pill').textContent, 'Kurulum');
    assert.equal(f.copied.length, 0);
    assertNoConnectedClaim(f);
  }
});

test('T-257 #539/R01: invalid callback cannot trigger dashboard or device pairing', async () => {
  for (const callback of ['http://localhost:49000/nexowire-connect',
    'https://outside.fixture.invalid/nexowire-connect',
    'http://127.0.0.1:49000/wrong-path']) {
    const f = await boot({ query: search({ callback }) });
    assert.equal(f.get('pair-panel').classes.has('hidden'), true);
    assert.equal(f.get('connect-pill').textContent, 'Kurulum');
    assert.equal(f.requests.filter(({ path }) => path.startsWith('/api/v1/')).length, 0);
  }
});

test('T-259 #539/R11: malformed 200 pairing payload is UNKNOWN/error, never success', async () => {
  for (const body of [{}, { pairingId: 'pair-only' }, { token: 'value-only' }]) {
    const f = await boot({ query: search(), pairing: async () => Response.json(body) });
    await f.get('approve').dispatch('click');
    assert.equal(f.get('connect-pill').textContent, 'Hata');
    assert.match(f.get('error-message').textContent, /geçersiz/);
    assert.equal(f.navigations.length, 0);
    assertNoConnectedClaim(f);
  }
});

// These gates are opt-in because the owner integration has not landed on main.
// A skipped gate is never counted as PASS; the exact source ref is part of proof.
test('T-257 owner candidate: quota denial blocks ineffective retry', {
  skip: process.env.K01_EXPECT_OWNER_VERSION !== '1' && 'requires #1068 owner candidate',
}, async () => {
  const f = await boot({ query: search(), pairing: async () =>
    Response.json({ error: 'DEVICE_LIMIT_REACHED' }, { status: 403 }) });
  await f.get('approve').dispatch('click');
  assert.equal(f.get('approve').disabled, true);
  assert.equal(f.get('connect-pill').textContent, 'Hata');
  assert.equal(f.navigations.length, 0);
});

test('T-257 owner candidate: terminal account error receives focus', {
  skip: process.env.K01_EXPECT_OWNER_VERSION !== '1' && 'requires #1068 owner candidate',
}, async () => {
  const f = await boot({ query: search(), dashboard: async () => Response.json({}, { status: 503 }) });
  assert.equal(f.get('error-panel').focusCount, 1);
  assert.equal(f.get('approve').disabled, true);
});

test('T-259 OPEN NEGATIVE: empty success pairing fields must never navigate', {
  skip: process.env.K01_RUN_OPEN_NEGATIVES !== '1' && 'unfixed on main and owner #1068',
}, async () => {
  // Pair one valid control with the negative, so a blanket refusal to pair
  // cannot make the negative gate pass after the owner-side fix.
  const valid = await boot({ query: search(), pairing: async () =>
    Response.json({ pairingId: 'pair-395', token: 'value-395' }) });
  await valid.get('approve').dispatch('click');
  assert.equal(valid.navigations.length, 1);
  const callback = new URL(valid.navigations[0]);
  assert.equal(callback.searchParams.get('pairing_id'), 'pair-395');
  assert.equal(callback.searchParams.get('token'), 'value-395');
  assert.equal(callback.searchParams.get('state'), 'test-nonce');

  const violations = [];
  for (const body of [
    { pairingId: '', token: 'fixture-value' },
    { pairingId: 'fixture-pair', token: '' },
    { pairingId: '', token: '' },
    { pairingId: '   ', token: 'fixture-value' },
    { pairingId: 'fixture-pair', token: '   ' },
  ]) {
    const f = await boot({ query: search(), pairing: async () => Response.json(body) });
    await f.get('approve').dispatch('click');
    if (f.navigations.length !== 0 || f.get('connect-pill').textContent !== 'Hata') {
      violations.push({ blankPairingId: !body.pairingId.trim(), blankToken: !body.token.trim() });
    }
  }
  assert.deepEqual(violations, [], 'empty success fields must never navigate or present a non-error state');
});

test('T-396 #539: delayed dashboard 401 cannot race with a pairing POST', async () => {
  const account = deferred();
  const f = await boot({ query: search(), dashboard: () => account.promise });
  assert.equal(f.get('approve').disabled, true);
  assert.equal(f.requests.filter(({ path }) => path === '/api/v1/pairing').length, 0);
  assert.equal(f.navigations.length, 0);
  account.resolve(Response.json({}, { status: 401 }));
  await flush();
  assert.match(f.navigations[0], /^\/auth\/github\/start\?next=/);
  assert.equal(f.requests.filter(({ path }) => path === '/api/v1/pairing').length, 0);
  assert.equal(f.get('approve').handlers.has('click'), false);
  // One loadAccount() call awaits dashboard before registering the click handler.
  // It cannot start a later pairing on the same page after this 401.
});

test('T-397 #485: deceptive callback authority and missing context never reach pairing', async () => {
  const badQueries = [
    search({ callback: 'http://127.0.0.1.evil.invalid:49610/nexowire-connect' }),
    search({ callback: 'http://evil.invalid@127.0.0.1:49610/nexowire-connect' }),
    search({ callback: 'http://127.0.0.1:49610@evil.invalid/nexowire-connect' }),
    search({ callback: 'http://127.0.0.1:49610/nexowire-connect/wrong' }),
    search({ state: '' }),
    search({ deviceId: '' }),
    search({ deviceName: '' }),
  ];
  for (const query of badQueries) {
    const f = await boot({ query });
    assert.equal(f.get('pair-panel').classes.has('hidden'), true);
    assert.equal(f.requests.filter(({ path }) => path.startsWith('/api/v1/')).length, 0);
    assert.equal(f.navigations.length, 0);
    assertNoConnectedClaim(f);
  }
});

test('T-398 owner candidate: terminal 403 differs from transient 503', {
  skip: process.env.K01_EXPECT_OWNER_VERSION !== '1' && 'requires #1068 owner candidate',
}, async () => {
  const quota = await boot({ query: search(), pairing: async () =>
    Response.json({ error: 'DEVICE_LIMIT_REACHED' }, { status: 403 }) });
  await quota.get('approve').dispatch('click');
  const outage = await boot({ query: search(), pairing: async () =>
    Response.json({ error: 'fixture' }, { status: 503 }) });
  await outage.get('approve').dispatch('click');
  assert.equal(quota.get('approve').disabled, true);
  assert.equal(outage.get('approve').disabled, false);
  assert.notEqual(quota.get('error-message').textContent, outage.get('error-message').textContent);
});

test('T-398 OPEN NEGATIVE: 429 Retry-After should not be identical to 503 error', {
  skip: process.env.K01_RUN_OPEN_NEGATIVES !== '1' && 'unfixed on main and owner #1068',
}, async () => {
  const limited = await boot({ query: search(), pairing: async () =>
    Response.json({ error: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '15' } }) });
  await limited.get('approve').dispatch('click');
  const unavailable = await boot({ query: search(), pairing: async () =>
    Response.json({ error: 'unavailable' }, { status: 503 }) });
  await unavailable.get('approve').dispatch('click');
  assert.equal(limited.navigations.length, 0);
  assert.equal(unavailable.navigations.length, 0);
  assert.notEqual(limited.get('error-message').textContent,
    unavailable.get('error-message').textContent,
    '429 has Retry-After but currently shows the same generic error as HTTP 503');
});
