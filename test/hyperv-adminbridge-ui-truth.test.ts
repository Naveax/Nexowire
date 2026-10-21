import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
test('Admin Bridge UI states FULL/ROOT/CORE and 401 are not Windows elevation',()=>{
  assert.match(app,/bridge-privilege-truth/);
  assert.match(app,/Windows yetkisi doğrulanmadı/);
  assert.match(app,/FULL\/ROOT\/CORE/);
  assert.match(app,/Broker \/health 401 yönetici tokeni kanıtı değildir/);
  assert.match(app,/Bu ekran UAC onayı vermez/);
});
test('UI describes exact scoped VM and consent without asserting Broker mode applied',()=>{
  assert.match(app,/tam VM GUID/);
  assert.match(app,/cihaz\/sahip politikası/);
  assert.match(app,/imzalı yerel onay/);
  assert.match(app,/görünür UAC izni/);
  assert.match(app,/doğrulanmış Broker sürümü/);
  assert.match(app,/güvenilir ACL/);
  assert.match(app,/Yalnızca tercih kaydı/);
  assert.doesNotMatch(app,/Start-VM|Stop-VM|Start-Process\s+-Verb\s+RunAs/);
});
