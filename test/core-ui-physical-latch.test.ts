import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const latch='const physicalCoreStatusVerifierInstalled = false;';
const begin=app.indexOf('function getDeviceTier(device) {');
const end=app.indexOf('\nfunction syncDeviceToolbar(',begin);
function tier(snapshot:unknown):string{
 assert.ok(app.includes(latch),'physical CORE verifier must not be client-configured');
 assert.ok(begin>=0&&end>begin,'device tier implementation not found');
 const scope=vm.createContext({device:snapshot,Date});
 // Execute the actual source declarations preceding getDeviceTier rather than
 // constructing a synthetic VM gate that could omit a newly added verifier.
 const gateStart=app.indexOf(latch);
 assert.ok(gateStart>=0&&gateStart<begin);
 vm.runInContext(app.slice(gateStart,end),scope);
 return vm.runInContext('getDeviceTier(device)',scope) as string;
}
test('forged physical CORE and persistent preference are not a VERIFIED tier',()=>{
 const claimed={accessMode:'full',online:true,privilegeMode:'broker',
  adminBridgeReady:true,persistentMaintenance:{active:true,effective:true,
   enabled:true,finalNativeEffectVerified:true,externalCasAtomicCommitVerified:true,
   ownerEpoch:17,grantGeneration:32},
  physicalConsole:{localEnrolled:true,active:true,observedAtMs:Date.now()},
  currentOwnerEpoch:17,currentGrantGeneration:32,
  journal:{status:'succeeded',verified:true},audit:{status:'succeeded',verified:true},
  clientConsent:{approved:true},runbook:{status:'completed',nativeResult:'VERIFIED'}};
 assert.equal(tier(claimed),'full');
 assert.equal(tier({...claimed,persistentMaintenance:{active:false}}),'full');
});
test('actual CORE card and shortcut never promote browser-provided active flags',()=>{
 assert.match(app,/const coreEffective = physicalCoreStatusVerifierInstalled && core\.active === true/);
 assert.match(app,/coreContainer\.classList\.toggle\('active', coreEffective\)/);
 assert.match(app,/coreShortcut\.classList\.toggle\('active', coreEffective\)/);
 assert.match(app,/coreShortcut\.setAttribute\('aria-pressed', String\(coreEffective\)\)/);
 assert.match(app,/coreShortcut\.textContent = coreEffective \?/);
 assert.match(app,/coreText\.textContent = coreEffective/);
 assert.match(app,/const physicalFresh=physicalCoreStatusVerifierInstalled&&/);
 assert.doesNotMatch(app,/coreContainer\.classList\.toggle\('active', core\.active === true\)/);
 assert.doesNotMatch(app,/coreShortcut\.setAttribute\('aria-pressed', String\(core\.active === true\)\)/);
});
