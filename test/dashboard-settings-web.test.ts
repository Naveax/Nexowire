import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('dashboard explains Full Access risk without removing security boundaries', () => {
  assert.match(html, /Kalıcı Full Access/);
  assert.match(html, /süre dolmaz/);
  assert.match(html, /GitHub OAuth/);
  assert.match(html, /cihaz credential/);
  assert.match(html, /Admin Bridge/);
  assert.match(html, /Windows UAC/);
  assert.match(html, /ilk kez kurulurken/);
  assert.match(html, /işlem başına UAC beklenmez/);
});

test('dashboard persists device Full Access through authenticated API without popup loops', () => {
  assert.match(app, /\/api\/v1\/me\/devices\/access-mode/);
  assert.match(app, /X-Nexowire-Confirm/);
  assert.match(app, /full-access-v1/);
  assert.match(app, /Süresiz · Nexowire onayı yok/);
  assert.match(app, /Admin Bridge hazır/);
  assert.match(app, /Admin Bridge ulaşılamıyor/);
  assert.match(app, /Admin Bridge kurulum bekliyor/);
  assert.match(app, /ilk kurulumda Windows UAC/);
  assert.match(app, /SAFE moda dön/);
  assert.doesNotMatch(app, /window\.confirm|window\.prompt/);
});

test('dashboard advertises checksum-verified side-by-side live update', () => {
  assert.match(html, /Canlı güncelleme/);
  assert.match(html, /SHA-256/);
  assert.match(html, /side-by-side/);
  assert.match(html, /rollback/);
});

test('dashboard exposes session-local view settings without privileged API mutations', () => {
  assert.match(html, /setting-compact/);
  assert.match(html, /setting-reduce-motion/);
  assert.match(html, /setting-advanced/);
  assert.match(css, /#setting-compact:checked/);
  assert.match(css, /#setting-reduce-motion:checked/);
  assert.match(css, /#setting-advanced:not\(:checked\)/);
  assert.doesNotMatch(html, /disable authentication|kimlik doğrulamayı kapat/i);
});
