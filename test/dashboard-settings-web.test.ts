import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

test('dashboard explains Full Access risk without removing security boundaries', () => {
  assert.match(html, /Full Access hakkında/);
  assert.match(html, /Geri alma veya\s+veri kurtarma garantisi yoktur/);
  assert.match(html, /GitHub OAuth/);
  assert.match(html, /Agent credential/);
  assert.match(html, /güvenlik katmanlarını kaldırmaz/);
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
