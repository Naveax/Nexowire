import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const begin=app.indexOf('function getDeviceTier(device) {');
const end=app.indexOf('\nfunction syncDeviceToolbar(',begin);
test('future ROOT maintenance request and synthetic active flag cannot masquerade as session-bound elevated authority',()=>{
 assert.ok(begin>=0&&end>begin,'device tier source not found');
 assert.match(app,/const physicalRootStatusVerifierInstalled = false;/);
 const fake={accessMode:'full',rootMode:{active:true,
  expiresAt:new Date(Date.now()+600_000).toISOString()},
  persistentMaintenance:{active:false},privilegeMode:'broker',
  adminBridgeReady:true,ownerEpoch:9,receipt:{verified:true},sessionBound:true};
 const ctx=vm.createContext({device:fake,Date});
 const tierSource=app.slice(app.indexOf('const physicalCoreStatusVerifierInstalled = false;'),end);
 vm.runInContext(tierSource,ctx);
 assert.equal(vm.runInContext('getDeviceTier(device)',ctx),'full');
 assert.match(app,/const rootLeaseActive = physicalRootStatusVerifierInstalled &&/);
 assert.match(app,/const active = physicalRootStatusVerifierInstalled &&\s*pending/);
 assert.match(app,/rootStateChip\.textContent = rootLeaseActive \?/);
 assert.match(app,/rootContainer\.classList\.toggle\('active', active\)/);
 assert.doesNotMatch(app,/const active = pending && device\.rootMode\?\.active === true/);
});
test('ROOT preference remains cancellable and distinguishes pending from signed Windows HIGH execution',()=>{
 assert.match(app,/rootButton\.textContent = pending \?/);
 assert.match(app,/if \(pending\) \{\s*void setDeviceRootMode\(device.id, false, row\)/);
 assert.match(app,/ROOT yetkisi ETKİN DEĞİL|ROOT yetkisi ETK/);
 assert.match(app,/Windows UAC/);
});
