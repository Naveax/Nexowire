import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// T-246: detached read-only UI candidates may be supplied explicitly. This
// fixture never starts a Hub, opens a network listener or mutates a device.
const app = readFileSync(process.env.K15_APP_SOURCE ??
  new URL('../../../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(process.env.K15_HTML_SOURCE ??
  new URL('../../../web/index.html', import.meta.url), 'utf8');
const start = app.indexOf('function setDeviceListMessage(');
const end = app.indexOf('\nfunction resetDashboardPresentation(', start);
const candidateHasLiveMessage = start >= 0 && end > start;

function liveMessageFixture() {
  const nodes = new Map();
  const node = (name) => {
    if (!nodes.has(name)) {
      nodes.set(name, {
        textContent: '', children: [], attrs: {}, className: '',
        replaceChildren(...children) { this.children = children; },
        appendChild(child) { this.children.push(child); },
        setAttribute(key, value) { this.attrs[key] = String(value); },
        getAttribute(key) { return this.attrs[key] ?? null; },
      });
    }
    return nodes.get(name);
  };
  const context = vm.createContext({$: node, document: {
    getElementById: node,
    createElement: (tag) => node('temporary-' + tag + '-' + nodes.size),
  }});
  vm.runInContext(app.slice(start, end), context, {filename: 'web/app.js'});
  const send = (message, loading = false) => {
    context.fixtureMessage = message;
    context.fixtureLoading = loading;
    vm.runInContext('setDeviceListMessage(fixtureMessage, fixtureLoading)', context);
  };
  return {node, send};
}

if (!candidateHasLiveMessage) {
  test.todo('upstream main has no concise device-list aria-live helper; check UI owner candidate');
} else {
  test('one list status region announces errors without re-reading every card', () => {
    assert.match(html, /id="device-list-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
    assert.match(html, /id="devices"[^>]*aria-label="Cihazlar"[^>]*aria-busy="true"/);
    assert.doesNotMatch(html, /id="devices"[^>]*aria-live=/);
  });

  test('loading sets busy true while announcing exactly one concise loading message', () => {
    const h = liveMessageFixture();
    h.send('Cihaz listesi yükleniyor…', true);
    assert.equal(h.node('devices').getAttribute('aria-busy'), 'true');
    assert.equal(h.node('device-list-status').textContent, 'Cihaz listesi yükleniyor…');
    assert.equal(h.node('devices').children.length, 1);
    assert.equal(h.node('devices').children[0].textContent, 'Cihaz listesi yükleniyor…');
  });

  test('error replaces a loading message and clears busy without suggesting success', () => {
    const h = liveMessageFixture();
    h.send('Cihaz listesi yükleniyor…', true);
    h.send('Cihaz listesi yüklenemedi. Bağlantını kontrol edip yeniden dene.');
    assert.equal(h.node('devices').getAttribute('aria-busy'), 'false');
    assert.equal(h.node('devices').children.length, 1);
    assert.equal(h.node('device-list-status').textContent,
      'Cihaz listesi yüklenemedi. Bağlantını kontrol edip yeniden dene.');
    assert.doesNotMatch(h.node('device-list-status').textContent, /bağlı cihaz yok|0 çevrimiçi/i);
    assert.match(app, /setDeviceListMessage\('Cihaz listesi yüklenemedi\./);
    assert.match(app, /setDeviceListMessage\('Cihazları görüntülemek için GitHub hesabınla giriş yap\./);
  });

  test('HTML-like error detail is text, never an injected markup node', () => {
    const h = liveMessageFixture();
    const payload = '<svg onload=alert(1)>';
    h.send(payload);
    assert.equal(h.node('device-list-status').textContent, payload);
    assert.equal(h.node('devices').children[0].textContent, payload);
    assert.equal(h.node('devices').children.length, 1);
    assert.match(app.slice(start, end), /empty\.textContent = message/);
    assert.doesNotMatch(app.slice(start, end), /innerHTML/);
  });
}
