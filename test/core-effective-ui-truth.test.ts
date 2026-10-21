import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
test('CORE selected preference never reuses legacy core.active as proof of elevation',()=>{
 assert.match(app,/const coreEffective = core\.effective === true/);
 assert.match(app,/core\.authoritySource === 'independent-protected-windows-broker'/);
 assert.match(app,/core\.actualElevatedTokenVerified === true/);
 assert.match(app,/core\.localEnrollmentVerified === true/);
 assert.match(app,/core\.brokerSourceAclVerified === true/);
 assert.match(app,/core\.brokerVersionVerified === true/);
 assert.doesNotMatch(app,/coreShortcut\.textContent = core\.active/);
 assert.match(app,/CORE KAYITLI • YETKİ BEKLEMEDE/);
});
test('UI recognizes one-time signed initial UAC and recurring CORE broker delegation',()=>{
 assert.match(app,/kalıcı yönetici delegasyonu doğrulandı/);
 assert.match(app,/her komutta tekrar UAC istenmez/);
 assert.match(app,/FULL standart kullanıcı yetkisidir/);
 assert.match(app,/bu düğme tek başına yükseltme yapmaz/);
 assert.doesNotMatch(app,/Start-Process\s+-Verb\s+RunAs|consent\.exe/);
});
