import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  focusCount = 0;
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
  focus() { this.focused = true; this.focusCount++; }
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
  metadata?: () => Promise<Response>;
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
  const storage=new Map<string,string>();
  const context = createContext({
    URL, URLSearchParams, AbortSignal, TextEncoder,
    crypto:{subtle:{digest:async(_algorithm:string,input:Uint8Array)=>createHash('sha256').update(input).digest()}},
    localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},
    document: {
      getElementById: el,
      querySelectorAll: () => tabs,
      querySelector: () => label,
    },
    navigator: {
      locks:{request:async(_key:string,_options:unknown,callback:(lock:object)=>unknown)=>callback({})},
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
      if (options.metadata) return options.metadata();
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
  assert.equal(f.el('connect-pill').textContent, 'Eşleştirmeye hazır');
  assert.equal(f.el('status-title').textContent, 'Eşleştirmeye hazır');
  assert.match(f.el('status-text').textContent, /CORE yetkisi/);
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
  assert.match(f.el('retry-hint').textContent, /eşleştirme sonucunu kontrol et/);
});

test('T-002/T-003: uncertain pairing never replays after an in-flight duplicate click', async () => {
  const first = deferred<Response>();
  let calls = 0;
  const f = await boot({
    search: pairingSearch(),
    pairing: () => {
      calls++;
      return first.promise;
    },
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
  assert.equal(f.el('approve').disabled, true);
  assert.equal(f.el('approve').textContent, 'BAĞLA');
  assert.equal(f.el('error-panel').focused, true);
  assert.equal(f.el('approve').attributes.has('aria-describedby'), false);
  assert.match(f.el('error-message').textContent, /Bağlantı sonucu belirsiz/);
  assert.match(f.el('retry-hint').textContent, /otomatik tekrarlama/);
  await f.el('approve').dispatch('click');
  assert.equal(calls, 1);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.el('pair-panel').attributes.get('aria-busy'), 'false');

  // A separately initiated fresh pairing is still supported, unlike replay
  // of a request whose earlier server result is UNKNOWN.
  const fresh=await boot({search:pairingSearch(),
    pairing:async()=>Response.json({pairingId:'fixture-pair',token:'fixture-token'})});
  await fresh.el('approve').dispatch('click');
  assert.equal(fresh.navigations.length,1);
  const callback=new URL(fresh.navigations[0]!);
  assert.equal(callback.hostname,'127.0.0.1');
  assert.equal(callback.searchParams.get('pairing_id'),'fixture-pair');
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

test('T-138: malformed MCP metadata, HTTP denial and timeout do not offer a fabricated address', async () => {
  for (const response of [
    () => Promise.resolve(Response.json({ resource: 'https://elsewhere.fixture.invalid/mcp' })),
    () => Promise.resolve(new Response('<html>bad gateway</html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    })),
    () => Promise.reject(Object.assign(new Error('test request deadline'), { name: 'TimeoutError' })),
  ]) {
    const f = await boot({ metadata: response });
    assert.equal(f.el('chatgpt-address').value, '');
    assert.equal(f.el('copy-chatgpt-address').disabled, true);
    assert.equal(f.el('connect-pill').textContent, 'Kurulum');
    assert.equal(f.el('approve').disabled, true);
    assert.doesNotMatch(f.el('chatgpt-status').textContent, /Adres kopyalandı|Bu adresi ChatGPT/);
  }
  const timeout = await boot({
    metadata: () => Promise.reject(Object.assign(new Error('deadline'), { name: 'TimeoutError' })),
  });
  assert.match(timeout.el('chatgpt-status').textContent, /5 saniye/);
  assert.match(timeout.el('chatgpt-status').textContent, /tahmin etme/);
});

test('T-138: network error and malformed successful pairing both remain failures', async () => {
  for (const pairing of [
    () => Promise.reject(new Error('fixture network offline')),
    () => Promise.resolve(Response.json({ pairingId: 'fixture-only' })),
    () => Promise.resolve(new Response('unreadable', {
      status: 200, headers: { 'content-type': 'text/plain' },
    })),
  ]) {
    const f = await boot({ search: pairingSearch(), pairing });
    await f.el('approve').dispatch('click');
    assert.equal(f.el('connect-pill').textContent, 'Hata');
    assert.equal(f.el('error-panel').classes.has('hidden'), false);
    assert.equal(f.el('approve').textContent, 'BAĞLA');
    assert.equal(f.el('approve').disabled, true);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.el('pair-panel').attributes.get('aria-busy'), 'false');
  }
});

test('T-141: duplicate clicks never trigger repeat focus or mutation after 503 UNKNOWN', async () => {
  const pending=deferred<Response>();
  let attempts=0;
  const f=await boot({search:pairingSearch(),
    pairing:()=>{attempts++;return pending.promise;}});
  const first=f.el('approve').dispatch('click');
  await f.el('approve').dispatch('click');
  assert.equal(attempts,1);
  pending.resolve(Response.json({}, {status:503}));
  await first;
  assert.equal(attempts,1);
  assert.equal(f.el('approve').focusCount,0);
  assert.equal(f.el('error-panel').focusCount,1);
  assert.match(f.el('retry-hint').textContent,/eşleştirme sonucunu kontrol et/);
  await f.el('approve').dispatch('click');
  assert.equal(attempts,1);
  assert.equal(f.el('error-panel').focusCount,1);
  assert.equal(f.el('error-panel').classes.has('hidden'),false);
  assert.equal(f.navigations.length,0);
});

test('T-142/T-143: cancelled setup query and long untrusted display name cannot announce connected state', async () => {
  const cancelled = await boot({ search: '?error=access_denied' });
  assert.equal(cancelled.el('pair-panel').classes.has('hidden'), true);
  assert.equal(cancelled.el('connect-pill').textContent, 'Kurulum');
  assert.equal(cancelled.requests.some(({ path }) => path === '/api/v1/pairing'), false);
  // This does not exercise the real OAuth callback; that remains auth-owner acceptance.

  const deviceName = '<img src=x onerror=alert(1)>' + 'İşletme-ÇokUzunAdı'.repeat(40);
  const f = await boot({ search: pairingSearch({ deviceName }) });
  assert.equal(f.el('device-name').textContent, deviceName);
  assert.equal(f.el('status-title').textContent, 'Eşleştirmeye hazır');
  assert.notEqual(f.el('connect-pill').textContent, 'Bağlandı');
  assert.doesNotMatch(script, /\binnerHTML\s*=/);
  // Real 375px overflow depends on K02's stylesheet and requires a browser.
});

test('T-144: timeout and request abort have distinct, non-successful user feedback', async () => {
  const timeout = await boot({
    metadata: () => Promise.reject(Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' })),
  });
  const aborted = await boot({
    metadata: () => Promise.reject(Object.assign(new Error('fixture abort'), { name: 'AbortError' })),
  });
  assert.match(timeout.el('chatgpt-status').textContent, /5 saniye/);
  assert.match(aborted.el('chatgpt-status').textContent, /isteği durduruldu/);
  assert.doesNotMatch(aborted.el('chatgpt-status').textContent, /5 saniye|Adres kopyalandı/);
  assert.notEqual(aborted.el('chatgpt-status').textContent, timeout.el('chatgpt-status').textContent);
  assert.equal(timeout.el('copy-chatgpt-address').disabled, true);
  assert.equal(aborted.el('copy-chatgpt-address').disabled, true);
  // AbortError is not proof of a human OAuth cancellation; this is request-status UX only.
});

test('P008: empty or whitespace pairing fields never navigate, valid fields still do', async () => {
  const invalid = [
    {pairingId: '', token: 'valid-token'},
    {pairingId: '   ', token: 'valid-token'},
    {pairingId: 'valid-pair', token: ''},
    {pairingId: 'valid-pair', token: '   '},
    {pairingId: '', token: ''},
  ];
  for (const body of invalid) {
    const f = await boot({search:pairingSearch(), pairing:async()=>Response.json(body)});
    await f.el('approve').dispatch('click');
    assert.equal(f.navigations.length, 0);
    assert.equal(f.el('connect-pill').textContent, 'Hata');
    assert.match(f.el('error-message').textContent, /geçersiz/);
  }
  const valid = await boot({search:pairingSearch(),
    pairing:async()=>Response.json({pairingId:'valid-pair',token:'safe-token'})});
  await valid.el('approve').dispatch('click');
  assert.equal(valid.navigations.length,1);
  const callback = new URL(valid.navigations[0]!);
  assert.equal(callback.searchParams.get('pairing_id'),'valid-pair');
  assert.equal(callback.searchParams.get('token'),'safe-token');
});

test('P008: HTTP 429 Retry-After differs from HTTP 503, without navigating',async()=>{
  const rate = await boot({search:pairingSearch(),
    pairing:async()=>Response.json({error:'RATE_LIMITED'},
      {status:429,headers:{'Retry-After':'15'}})});
  await rate.el('approve').dispatch('click');
  const outage = await boot({search:pairingSearch(),
    pairing:async()=>Response.json({}, {status:503})});
  await outage.el('approve').dispatch('click');
  assert.equal(rate.navigations.length,0);
  assert.equal(outage.navigations.length,0);
  assert.match(rate.el('error-message').textContent,/15 saniye bekle/);
  assert.notEqual(rate.el('error-message').textContent,outage.el('error-message').textContent);
});

test('P008: malformed Retry-After never becomes a misleading wait duration',async()=>{
  for(const header of [null,'-30','0','1.5','99999999','1e3','1'.repeat(150)]){
    const options=header===null?{status:429}:{status:429,headers:{'Retry-After':header}};
    const f=await boot({search:pairingSearch(),pairing:async()=>Response.json(
      {error:'RATE_LIMITED'},options)});
    await f.el('approve').dispatch('click');
    assert.equal(f.navigations.length,0);
    assert.match(f.el('error-message').textContent,/Biraz bekle/);
    assert.doesNotMatch(f.el('error-message').textContent,/saniye bekle/);
    if(header!==null)assert.equal(f.el('error-message').textContent.includes(header),false);
  }
});

test('P008: expired HTTP 401 is terminal and distinct from unavailable HTTP 503',async()=>{
  const expired=await boot({search:pairingSearch(),
    pairing:async()=>Response.json({error:'SESSION_EXPIRED'},{status:401})});
  await expired.el('approve').dispatch('click');
  const outage=await boot({search:pairingSearch(),
    pairing:async()=>Response.json({error:'unavailable'},{status:503})});
  await outage.el('approve').dispatch('click');
  assert.equal(expired.navigations.length,0);
  assert.equal(expired.el('approve').disabled,true);
  assert.match(expired.el('error-message').textContent,/Oturumun sona erdi/);
  assert.notEqual(expired.el('error-message').textContent,outage.el('error-message').textContent);
  assert.equal(outage.el('approve').disabled,true);
});

test('P008: unexpected HTTP pairing failure cannot display raw credential diagnostics',async()=>{
  const secret='secret-fixture-'+ 'a'.repeat(100);
  const f=await boot({search:pairingSearch(),
    pairing:async()=>{throw new Error('upstream debug leaked '+secret);}});
  await f.el('approve').dispatch('click');
  assert.equal(f.navigations.length,0);
  assert.equal(f.el('connect-pill').textContent,'Hata');
  assert.equal(f.el('error-message').textContent.includes(secret),false);
  assert.match(f.el('error-message').textContent,/Beklenmeyen bağlantı hatası\. Bağlantı sonucu belirsiz/);
  assert.equal(f.el('approve').disabled,true);
});

test('P008: initial account-fetch failure cannot disclose raw upstream diagnostics',async()=>{
  const secret='sensitive-account-canary-'+ 'x'.repeat(80);
  const f=await boot({search:pairingSearch(),
    dashboard:async()=>{throw new Error('upstream diagnostics '+secret);}});
  assert.equal(f.navigations.length,0);
  assert.equal(f.el('approve').disabled,true);
  assert.equal(f.el('error-panel').classes.has('hidden'),false);
  assert.equal(f.el('error-message').textContent.includes(secret),false);
  assert.match(f.el('error-message').textContent,/Hesap doğrulanamadı/);
});