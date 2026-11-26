import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only copy QA of other owners' UI paths. Never exercise auth, Hub or Agent.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const source = Object.fromEntries(['web/app.js', 'web/connect.js', 'web/admin.js']
  .map((file) => [file, read(file)]));
const audit = read('test/delegated/k08/issue539-ui-status-audit.md');

function evidenceGates(input) {
  assert.match(input['web/app.js'], /Broker hazır bildirimi/);
  assert.match(input['web/app.js'], /Bu, ON\/OFF komutunun uygulandığına dair kanıt değildir/);
  assert.match(input['web/app.js'], /ON seçildi\. Broker hazır bildirimi var; bu düğmenin başlattığı doğrulanmadı/);
  assert.match(input['web/app.js'], /OFF seçildi ancak Broker hâlâ hazır bildiriliyor\. Gerçek kapatma yapılmadı/);
  assert.match(input['web/connect.js'], /setPill\('Hazır', 'good'\)/);
  assert.match(input['web/connect.js'], /BAĞLA dediğinde cihaz hesabına eklenir/);
  assert.match(input['web/admin.js'], /data\.usage\.successRate === null/);
  assert.match(input['web/admin.js'], /Başarı oranı yok/);
}

test('#539 R18 UI readiness labels retain source-level no-command-proof disclaimers', () => {
  evidenceGates(source);
});

test('negative: removing a Broker evidence caveat or readiness context must fail', () => {
  const withoutCaveat = { ...source,
    'web/app.js': source['web/app.js'].replace('Bu, ON/OFF komutunun uygulandığına dair kanıt değildir.', 'İşlem başarıyla tamamlandı.'),
  };
  assert.throws(() => evidenceGates(withoutCaveat));
  const withoutContext = { ...source,
    'web/connect.js': source['web/connect.js'].replace('BAĞLA dediğinde cihaz hesabına eklenir', 'Cihaz bağlandı'),
  };
  assert.throws(() => evidenceGates(withoutContext));
});

test('read-only audit lists provenance and does not claim verified UI or OS action', () => {
  for (const path of Object.keys(source)) assert.ok(audit.includes('`' + path + '`'));
  assert.match(audit, /source-only/i);
  assert.match(audit, /NOT_RUN/);
  assert.match(audit, /#1068/);
  assert.match(audit, /#539/);
});
