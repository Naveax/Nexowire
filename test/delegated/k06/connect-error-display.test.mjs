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
    removeAttribute: () => {},
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
  assert.equal(getElement('approve').textContent, 'BAĞLA');
  assert.equal(getElement('approve').disabled, true);
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
  assert.equal(getElement('error-message').textContent, 'Hesap doğrulanamadı. Bağlantıyı kontrol edip yeniden dene.');
  assert.equal(getElement('approve').disabled, true);
});

test('AI-06 T-378 #485: uncertain 5xx pairing never echoes response secrets or permits blind retry', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({
    pairingStatus: 503, pairingBody: { message: `https://invalid.example/?access_token=${sentinel}` },
  });
  assert.equal(getElement('error-message').textContent,
    'Bağlantı sonucu belirsiz (HTTP 503). Önce Nexowire uygulamasındaki eşleştirmeyi kontrol et; aynı isteği körlemesine yineleme.');
  assert.equal(getElement('approve').disabled, true,
    'HTTP 503 is an uncertain postcondition; blindly replaying POST is forbidden');
  const badGateway = await simulate({
    pairingStatus: 502, pairingBody: { message: 'SECRET_SENTINEL_502' },
  });
  assert.equal(badGateway.getElement('error-message').textContent, 'Bağlantı hazırlanamadı.');
  assert.ok(!getElement('error-message').textContent.includes(sentinel));
});

test('T-378 #485: beklenmeyen hesap-fetch hatasının ham metni kullanıcıya gösterilmiyor', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({fetchError: new TypeError(`Fetch failed: https://invalid.example/?token=${sentinel}`)});
  assert.equal(getElement('error-message').textContent.includes(sentinel), false);
  assert.equal(getElement('error-message').textContent, 'Hesap doğrulanamadı. Bağlantıyı kontrol edip yeniden dene.');
});

test('AI-06 T-378 #485: lost POST ACK is bounded UNKNOWN and never enables automatic replay', async () => {
  const sentinel = 'SECRET_SENTINEL_T378';
  const { getElement } = await simulate({
    pairingError: new TypeError(`Failed to fetch https://invalid.example/?access_token=${sentinel}`),
  });
  assert.equal(getElement('error-message').textContent.includes(sentinel), false);
  assert.equal(getElement('error-message').textContent,
    'Beklenmeyen bağlantı hatası. Bağlantı sonucu belirsiz. Önce yerel uygulamadaki sonucu kontrol et; tekrar istek gönderme.');
  assert.equal(getElement('approve').disabled, true);
});

test('K01 #485: connect Windows indirmesi README ile aynı resmî v1.0.8 yayınına bağlı', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(source, /INSTALLER_RELEASE_ASSETS = 'https:\/\/github\.com\/Naveax\/Nexowire\/releases\/download\/v1\.0\.8\//);
  assert.match(readme, /releases\/download\/v1\.0\.8\/Nexowire-Setup\.cmd/);
});

// Both formerly open source gaps are now asserted by the executed tests above.
