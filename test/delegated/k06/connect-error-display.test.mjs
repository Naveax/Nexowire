import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(path.join(root, 'web/connect.js'), 'utf8');

function element() {
  const callbacks = new Map();
  const classes = new Set(['hidden']);
  return {
    callbacks,
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener: (name, fn) => callbacks.set(name, fn),
    closest: () => ({ classList: { toggle: () => {} } }),
    setAttribute: () => {},
    focus: () => {},
    select: () => {},
    textContent: '',
    value: '',
    disabled: false,
  };
}

async function simulate({ dashboardStatus = 200, pairingStatus = 403, pairingBody = {}, fetchError = null, pairingError = null } = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const tabs = ['windows', 'macos', 'linux'].map((os) => Object.assign(element(), { dataset: { os } }));
  const calls = [];
  const location = {
    origin: 'https://example.invalid',
    pathname: '/connect.html',
    search: '?callback=' + encodeURIComponent('http://127.0.0.1:41234/nexowire-connect') +
      '&state=not-a-secret&deviceId=test-device&deviceName=Test-PC',
    replace: (url) => calls.push({ redirect: url }),
  };
  const fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET' });
    if (fetchError) throw fetchError;
    if (url === '/api/v1/me/dashboard') {
      return { ok: dashboardStatus === 200, status: dashboardStatus };
    }
    if (url === '/api/v1/pairing') {
      if (pairingError) throw pairingError;
      return { ok: pairingStatus >= 200 && pairingStatus < 300,
        status: pairingStatus, json: async () => pairingBody };
    }
    throw Error('Unexpected request in offline fixture');
  };
  const document = {
    getElementById: getElement,
    querySelectorAll: () => tabs,
    querySelector: () => element(),
  };
  runInNewContext(source, {
    document, window: { location }, navigator: { userAgent: 'Windows', clipboard: { writeText: async () => {} } },
    fetch, URL, URLSearchParams, AbortSignal, console,
  }, { filename: 'read-only-web-connect-fixture.js', timeout: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  const approve = getElement('approve');
  if (approve.callbacks.has('click')) {
    await approve.callbacks.get('click')();
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { getElement, calls };
}

test('T-378 #485: sunucu 403 hata gövdesindeki sahte URL/token kullanıcıya yankılanmıyor', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement, calls } = await simulate({
    pairingStatus: 403,
    pairingBody: { error: `https://invalid.example/?token=${sentinel}` },
  });
  assert.equal(getElement('error-message').textContent, 'Bu cihaz bu hesaba bağlanamadı.');
  assert.ok(!getElement('error-message').textContent.includes(sentinel));
  assert.equal(getElement('approve').textContent, 'TEKRAR DENE');
  assert.equal(getElement('approve').disabled, false);
  assert.equal(calls.some((call) => call.method === 'POST'), true);
});

test('T-378 #485: cihaz limiti hatası yalnız izin verilen sabit metni gösteriyor', async () => {
  const { getElement } = await simulate({pairingStatus: 403, pairingBody: {error: 'DEVICE_LIMIT_REACHED'}});
  assert.equal(getElement('error-message').textContent, 'Bu hesap için cihaz limiti dolu.');
});

test('T-378 #485: bozuk pairing yanıtındaki sır ve kimlik alanları ekrana dökülmüyor', async () => {
  const { getElement } = await simulate({
    pairingStatus: 200, pairingBody: { token: 'SECRET_SENTINEL_T378', pairingId: null },
  });
  assert.equal(getElement('error-message').textContent, 'Bağlantı cevabı geçersiz.');
});

test('T-378 #485: dashboard 500 cevabının gövdesi kullanılmıyor', async () => {
  const { getElement } = await simulate({ dashboardStatus: 500 });
  assert.equal(getElement('error-message').textContent, 'Hesap doğrulanamadı. Lütfen tekrar dene.');
  assert.equal(getElement('approve').disabled, true);
});

test('T-378 #485: 5xx pairing hatasındaki sunucu mesajı/sahte URL gösterilmiyor', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({
    pairingStatus: 503, pairingBody: { message: `https://invalid.example/?access_token=${sentinel}` },
  });
  assert.equal(getElement('error-message').textContent, 'Bağlantı hazırlanamadı.');
  assert.ok(!getElement('error-message').textContent.includes(sentinel));
});

test('T-378 bulgu: beklenmeyen fetch istisnasının message içeriği şu an aynen gösteriliyor', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({fetchError: new TypeError(`Fetch failed: https://invalid.example/?token=${sentinel}`)});
  // This assertion records a source defect; it is NOT a security PASS.
  assert.ok(getElement('error-message').textContent.includes(sentinel),
    'The known unsanitized exception path changed; review before claiming a fix');
});

test('T-378 bulgu: pairing POST istisnasındaki sahte URL de kullanıcıya yansıyor', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({
    pairingError: new TypeError(`Failed to fetch https://invalid.example/?access_token=${sentinel}`),
  });
  // Expected *observation* of the defect, not a successful secrecy guarantee.
  assert.ok(getElement('error-message').textContent.includes(sentinel));
  assert.equal(getElement('approve').disabled, false);
});

test('K01 bulgusu: connect Windows metni hâlâ v1.0.7, ana README v1.0.8 yayımlamış', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(source, /v1\.0\.7 paketini doğrulayarak kullanır/);
  assert.match(readme, /releases\/download\/v1\.0\.8\/Nexowire-Setup\.cmd/);
});

test.todo('K01/#1068 owner: unexpected fetch Error.message must be redacted to fixed user-safe text');
test.todo('K01/#1068 owner: reconcile pinned v1.0.7 connect installer and current v1.0.8 release');
