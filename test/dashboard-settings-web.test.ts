import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('dashboard prioritizes devices, usage and safety without dead billing controls', () => {
  assert.match(html, /Kontrol Merkezi/);
  assert.match(html, /id="devices"/);
  assert.match(html, /id="devices-count"/);
  assert.match(html, /id="usage"/);
  assert.match(html, /id="owner-access-panel"/);
  assert.match(html, /Güvenlik ve yetkiler/);
  assert.match(html, /Windows UAC/);
  assert.doesNotMatch(html, /prepaid-packs|upgrade-plus|billing-portal/);
  assert.doesNotMatch(app, /startPrepaidCheckout|FREE_ONLY_MODE = false/);
});

test('dashboard persists FULL and supports SAFE without untrusted confirmation popups', () => {
  assert.match(app, /\/api\/v1\/me\/devices\/access-mode/);
  assert.match(app, /X-Nexowire-Confirm/);
  assert.match(app, /full-access-v1/);
  assert.match(app, /Full Access aç/);
  assert.match(app, /SAFE moda dön/);
  assert.doesNotMatch(app, /window\.confirm|window\.prompt/);
});

test('ROOT DANGER displays exact approval, 15 minute scope and bridge readiness separately', () => {
  assert.match(html, /ROOT MODE · DANGER/);
  assert.match(html, /15 dakikalık/);
  assert.match(html, /GitHub OAuth/);
  assert.match(app, /\/api\/v1\/me\/devices\/root-mode/);
  assert.match(app, /root-danger-v1/);
  assert.match(app, /confirmation: 'ROOT DANGER'/);
  assert.match(app, /Önce Full Access açmalısın/);
  assert.match(app, /Yükseltilmiş işlemler için Admin Bridge/);
  assert.match(app, /ROOT kapat/);
  assert.match(css, /\.root-access/);
  assert.match(css, /\.danger-button/);
  assert.doesNotMatch(app, /device\.adminBridgeReady !== true/);
});

test('dashboard filters real device access tiers and offers owner folder management', () => {
  for (const mode of ['all', 'safe', 'full', 'root', 'persistent']) {
    assert.match(html, new RegExp('data-filter="' + mode + '"'));
  }
  assert.match(html, /id="folder-filter"/);
  assert.match(html, /id="folder-create-form"/);
  assert.match(html, /id="folder-delete"/);
  assert.match(html, /data-layout="grid"/);
  assert.match(html, /data-layout="list"/);
  assert.match(app, /postFolderAction\('assign'/);
  assert.match(app, /X-Nexowire-Confirm':'device-folder-v1'/);
  assert.match(app, /formatCompact/);
  assert.match(app, /root-clock/);
  assert.doesNotMatch(app, /persistentMaintenance\.active = true/);
  assert.match(css, /\.device-list\.list-view/);
  assert.match(css, /\.folder-toolbar/);
});

test('dashboard keeps live-update details and optional appearance controls out of primary cards', () => {
  assert.match(html, /Canlı güncelleme/);
  assert.match(html, /SHA-256/);
  assert.match(html, /side-by-side/);
  assert.match(html, /rollback/);
  assert.match(html, /setting-compact/);
  assert.match(html, /setting-reduce-motion/);
  assert.match(css, /#setting-compact:checked/);
  assert.match(css, /#setting-reduce-motion:checked/);
  assert.match(css, /@media \(max-width:620px\)/);
  assert.doesNotMatch(html, /disable authentication|kimlik doğrulamayı kapat/i);
});
