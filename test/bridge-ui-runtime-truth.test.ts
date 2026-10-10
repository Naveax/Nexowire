import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/styles.css',import.meta.url),'utf8');

test('Broker readiness cannot be inferred from stale offline device telemetry',()=>{
  assert.match(app,/const ready = device\.online === true &&/);
  assert.match(app,/device\.privilegeMode === 'broker' && device\.adminBridgeReady === true/);
  assert.match(app,/Son Broker bilgisi güncel kabul edilemez/);
  assert.match(app,/Broker durumu bilinmiyor/);
});

test('OFF preference never represents successful Broker stop if telemetry still shows ready',()=>{
  assert.match(app,/OFF seçildi ancak Broker hâlâ hazır bildiriliyor\. Gerçek kapatma yapılmadı/);
  assert.match(app,/OFF seçildi\. Broker durumu doğrulanamadı; kapatıldığı kanıtlanmadı/);
  assert.match(app,/OFF seçildi\. Cihaz çevrimdışı; kapatma durumu bilinmiyor/);
  assert.match(app,/OFF, CORE tercihini iptal eder/);
  assert.match(css,/\.bridge-mode-feedback\.bridge-warning/);
});

test('ON and AUTO choices are distinct from command execution and measured device evidence',()=>{
  assert.match(app,/ON seçildi\. Broker henüz hazır değil; başlatma komutu gönderilmedi/);
  assert.match(app,/ON seçildi\. Broker hazır bildirimi var; bu düğmenin başlattığı doğrulanmadı/);
  assert.match(app,/AUTO seçildi\. Otomatik yerel görev yönetimi henüz etkin değil/);
  assert.match(app,/Bu anahtar şimdilik yalnızca tercihi kaydeder/);
  assert.match(app,/bridgeFeedback\.classList\.toggle\('bridge-warning'/);
  assert.doesNotMatch(app,/\bbridgePreference\.applied\s*=\s*true\b/);
});
