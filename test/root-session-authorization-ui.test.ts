import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/product/control-plane-service.ts', import.meta.url), 'utf8');

test('ROOT stored lease never implies effective access without logout-bound session proof', () => {
  assert.match(service,/const active = false;\/\/|const active = false;/);
  assert.match(service,/rootMode:\s*\{\s*\/\/ Persisted owner request is not a session-bound authorization grant.[\s\S]*?active: false/);
  assert.match(app,/const rootLeaseActive = device\.rootMode\?\.active === true/);
  assert.match(app,/ROOT BEKLEMEDE \(oturum doğrulanmadı\)/);
  assert.match(app,/if \(!active\)\s*\{\s*rootCopy\.textContent/);
  assert.match(app,/ROOT yetkisi ETKİN DEĞİL/);
  assert.match(app,/Bu istek işletim sistemi yönetici izni veya UAC onayı değildir/);
  assert.doesNotMatch(app,/rootLeaseActive\s*=\s*Boolean\(device\.rootMode\?\.expiresAt/);
});
