import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// This is a deterministic DOM stub, not a browser or an auth/pairing integration test.
const script = readFileSync('web/connect.js', 'utf8');
const html = readFileSync('web/connect.html', 'utf8');

class FixtureElement {
  value = '';
  textContent = '';
  href = '';
  disabled = false;
  focused = false;
  selected = false;
  tabIndex = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  handlers = new Map<string, (event?: { key?: string; preventDefault?: () => void }) => Promise<void> | void>();
  row?: FixtureElement;
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, force: boolean) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
  addEventListener(name: string, handler: (event?: { key?: string; preventDefault?: () => void }) => Promise<void> | void) {
    this.handlers.set(name, handler);
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  closest(_selector: string) { return this.row ?? this; }
  dispatch(name: string, event?: { key?: string; preventDefault?: () => void }) {
    const handler = this.handlers.get(name);
    assert.ok(handler, `Expected ${name} handler`);
    return handler(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pairingSearch(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    callback: 'http://127.0.0.1:49700/nexowire-connect',
    state: 'fixture-state',
    deviceId: 'fixture-device',
    deviceName: 'Test PC',
    platform: 'win32',
    ...overrides,
  });
  return `?${params.toString()}`;
}

async function tick() {
  await new Promise<void>((done) => setImmediate(done));
  await new Promise<void>((done) => setImmediate(done));
}

async function boot(options: {
  search?: string;
  dashboard?: () => Promise<Response>;
  pairing?: () => Promise<Response>;
} = {}) {
  const elements = new Map<string, FixtureElement>();
  const el = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new FixtureElement();
      elements.set(id, element);
    }
    return element;
  };
  const tabs = ['windows', 'macos', 'linux'].map((os) => {
    const tab = new FixtureElement();
    tab.dataset.os = os;
    elements.set(`tab-${os}`, tab);
    return tab;
  });
  const label = new FixtureElement();
  el('install-command').row = new FixtureElement();
  el('approve').disabled = true;
  el('status-title').textContent = 'Hesap kontrol ediliyor';
  el('pair-panel').attributes.set('aria-busy', 'true');
  el('copy-chatgpt-address').disabled = true;
  el('pair-panel').classes.add('hidden');
  el('error-panel').classes.add('hidden');
  const requests: Array<{ path: string; method: string }> = [];
  const navigations: string[] = [];
  const origin = 'https://control.fixture.invalid';
  const context = createContext({
    URL, URLSearchParams, AbortSignal,
    document: {
      getElementById: el,
      querySelectorAll: () => tabs,
      querySelector: () => label,
    },
    navigator: {
      userAgent: 'Windows NT 10.0; Win64; x64',
      clipboard: { writeText: async () => {} },
    },
    window: {
      location: {
        search: options.search ?? '', pathname: '/connect.html', origin,
        replace: (url: string) => navigations.push(url),
      },
    },
    fetch: async (path: string, init?: RequestInit) => {
      requests.push({ path, method: init?.method ?? 'GET' });
      if (path === '/api/v1/me/dashboard') {
        return options.dashboard?.() ?? Response.json({ user: 'fixture' });
      }
      if (path === '/api/v1/pairing') {
        return options.pairing?.() ?? Response.json({ pairingId: 'fixture-pair', token: 'fixture-token' });
      }
      assert.equal(path, '/.well-known/oauth-protected-resource');
      return Response.json({
        resource: 'https://public-hub.fixture.invalid/mcp',
        authorization_servers: [origin],
      });
    },
  });
  runInContext(script, context, { timeout: 1000 });
  await tick();
  return { el, tabs, label, requests, navigations };
}

test('T-001: install state has no hidden pairing action, and OS tabs are single-select', async () => {
  const f = await boot();
  assert.equal(f.el('pair-panel').classes.has('hidden'), true);
  assert.equal(f.el('error-panel').classes.has('hidden'), true);
  assert.equal(f.el('connect-pill').textContent, 'Kurulum');
  assert.deepEqual(f.requests.map(({ path }) => path), ['/.well-known/oauth-protected-resource']);
  assert.deepEqual(f.tabs.map((tab) => tab.attributes.get('aria-selected')), ['true', 'false', 'false']);

  let prevented = false;
  await f.tabs[0]!.dispatch('keydown', { key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.tabs.map((tab) => tab.attributes.get('aria-selected')), ['false', 'true', 'false']);
  assert.equal(f.tabs[1]!.focused, true);
  assert.equal(f.el('install-command').row!.classes.has('hidden'), true);
  assert.equal(f.el('copy-chatgpt-address').disabled, false);
});

test('T-001: pairing state progresses from account check to ready without premature approval', async () => {
  const dashboard = deferred<Response>();
  const f = await boot({ search: pairingSearch(), dashboard: () => dashboard.promise });
  assert.equal(f.el('pair-panel').classes.has('hidden'), false);
  assert.equal(f.el('chatgpt-panel').classes.has('hidden'), true);
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.el('status-title').textContent, 'Hesap kontrol ediliyor'); // HTML initial state
  dashboard.resolve(Response.json({ user: 'fixture' }));
  await tick();
  assert.equal(f.el('approve').disabled, false);
  assert.equal(f.el('connect-pill').textContent, 'Hazır');
  assert.equal(f.el('pair-panel').attributes.get('aria-busy'), 'false');
  assert.equal(f.el('error-panel').classes.has('hidden'), true);
});

test('T-001: 401 redirects to login, without invoking device pairing', async () => {
  const f = await boot({
    search: pairingSearch(),
    dashboard: async () => Response.json({}, { status: 401 }),
  });
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.navigations.length, 1);
  assert.match(f.navigations[0]!, /^\/auth\/github\/start\?next=/);
  assert.equal(f.requests.some(({ path }) => path === '/api/v1/pairing'), false);
});

test('T-002: failed account verification shows an actionable, focused terminal error', async () => {
  const f = await boot({
    search: pairingSearch(),
    dashboard: async () => Response.json({}, { status: 503 }),
  });
  assert.equal(f.el('connect-pill').textContent, 'Hata');
  assert.equal(f.el('error-panel').classes.has('hidden'), false);
  assert.equal(f.el('error-panel').focused, true);
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.el('pair-panel').attributes.get('aria-busy'), 'false');
  assert.match(f.el('retry-hint').textContent, /sayfayı yenile/);
});

test('T-002/T-003: failed pairing is retryable, but pending double clicks send only one request', async () => {
  const first = deferred<Response>();
  let calls = 0;
  const f = await boot({
    search: pairingSearch(),
    pairing: () => ++calls === 1
      ? first.promise
      : Promise.resolve(Response.json({ pairingId: 'fixture-pair', token: 'fixture-token' })),
  });
  const pending = f.el('approve').dispatch('click');
  await f.el('approve').dispatch('click');
  assert.equal(calls, 1);
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.el('approve').textContent, 'BAĞLANIYOR…');
  assert.equal(f.el('pair-panel').attributes.get('aria-busy'), 'true');

  first.resolve(Response.json({}, { status: 503 }));
  await pending;
  assert.equal(f.el('error-panel').classes.has('hidden'), false);
  assert.equal(f.el('approve').disabled, false);
  assert.equal(f.el('approve').textContent, 'TEKRAR DENE');
  assert.equal(f.el('approve').focused, true);
  assert.equal(f.el('approve').attributes.get('aria-describedby'), 'error-message retry-hint');

  await f.el('approve').dispatch('click');
  assert.equal(calls, 2);
  assert.equal(f.el('error-panel').classes.has('hidden'), true);
  assert.equal(f.el('approve').attributes.has('aria-describedby'), false);
  assert.equal(f.navigations.length, 1);
  const callback = new URL(f.navigations[0]!);
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  assert.equal(callback.searchParams.get('pairing_id'), 'fixture-pair');
});

test('T-002: device quota 403 does not present an ineffective retry action', async () => {
  const f = await boot({
    search: pairingSearch(),
    pairing: async () => Response.json({ error: 'DEVICE_LIMIT_REACHED' }, { status: 403 }),
  });
  await f.el('approve').dispatch('click');
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.el('error-panel').focused, true);
  assert.match(f.el('error-message').textContent, /cihaz limiti dolu/);
  assert.equal(f.el('status-title').textContent, 'Bağlantı durduruldu');
  assert.equal(f.navigations.length, 0);
});

test('T-001: untrusted external callbacks never reveal the pairing action', async () => {
  for (const callback of ['https://other.fixture.invalid/nexowire-connect',
    'http://localhost:49700/nexowire-connect',
    'http://127.0.0.1:49700/other']) {
    const f = await boot({ search: pairingSearch({ callback }) });
    assert.equal(f.el('pair-panel').classes.has('hidden'), true);
    assert.equal(f.requests.some(({ path }) => path === '/api/v1/me/dashboard'), false);
  }
});

test('T-004/T-005: source contracts cover announcements, focus and mobile wrapping only', () => {
  assert.match(html, /id="pair-panel"[^>]*aria-busy="true"/);
  assert.match(html, /class="connect-copy"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="error-panel"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(html, /id="retry-hint"/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  const css = readFileSync('web/styles.css', 'utf8'); // K02-owned, read only.
  assert.match(css, /@media\s*\(max-width:\s*620px\)/);
  assert.match(css, /\.install-command-row\s*\{\s*flex-wrap:\s*wrap/);
  assert.match(css, /\.install-command-row input\s*\{\s*flex-basis:\s*100%/);
  assert.match(css, /\.install-command-row button\s*\{\s*width:\s*100%/);
  // No claim about rendering, focus order in a real browser or actual mobile overflow.
});
