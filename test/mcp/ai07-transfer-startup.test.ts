import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSelectedTransferHelper,withVerifiedTransferHelper,runProtectedTransferNativeAgent,type TransferHelperRuntimeAuthority} from '../../src/agent/protected-transfer-startup.js';
import {installedTransferHelperPath,type HelperSelection,type TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import {runProtectedTransferHub} from '../../src/mcp/protected-transfer-hub-startup.js';
import {startProtectedTransferAndCoreServices} from '../../src/security/protected-transfer-services-startup.js';

const pin={sha256:'a'.repeat(64),signerSha256:'b'.repeat(64)};
function fixture(){
  let value:HelperSelection={revision:'r1',pin},held=false,verified=0;
  const authority:TransferHelperRuntimeAuthority={
    async withActiveSelection<T>(effect:()=>Promise<T>){assert(!held);held=true;try{return await effect();}finally{held=false;}},
    async readSelection(){assert(held);return value;},
  };
  const store:TransferHelperArtifactStore={async verifyInstalled(p){assert(held);assert.deepEqual(p,pin);verified++;},async stage(){throw Error('unexpected stage');}};
  return {authority,store,set:(next:HelperSelection)=>{value=next;},held:()=>held,verified:()=>verified};
}
test('selected exact helper binding is verified inside activation lease and stale revision is denied',async()=>{
  const f=fixture();
  await withVerifiedTransferHelper(f.authority,f.store,async binding=>{
    assert(f.held());assert.equal(f.verified(),1);assert.equal(binding.flushHelper,installedTransferHelperPath(pin));
    assert.equal(binding.flushHelperSha256,pin.sha256);assert.equal(binding.flushHelperSignerSha256,pin.signerSha256);
    await assertSelectedTransferHelper(f.authority,binding);
    f.set({revision:'r2',pin});
    await assert.rejects(assertSelectedTransferHelper(f.authority,binding),/TRANSFER_HELPER_SELECTION_CHANGED/);
  });
  assert(!f.held());
});
test('detached helper or changed selection cannot activate',async()=>{
  const f=fixture();let calls=0;
  f.set({revision:'detached',pin:null});
  await assert.rejects(withVerifiedTransferHelper(f.authority,f.store,async()=>{calls++;}),/TRANSFER_HELPER_NOT_SELECTED/);
  f.set({revision:'r1',pin});
  const store={...f.store,async verifyInstalled(){f.set({revision:'r2',pin});}};
  await assert.rejects(withVerifiedTransferHelper(f.authority,store,async()=>{calls++;}),/TRANSFER_HELPER_SELECTION_CHANGED/);
  assert.equal(calls,0);
});
test('missing or non-entered runtime lease fails closed before activation',async()=>{
  const f=fixture();let calls=0;
  await assert.rejects(withVerifiedTransferHelper({readSelection:f.authority.readSelection} as TransferHelperRuntimeAuthority,f.store,async()=>{calls++;}),/TRANSFER_HELPER_RUNTIME_LEASE_REQUIRED/);
  const nonEntering:TransferHelperRuntimeAuthority={readSelection:f.authority.readSelection,async withActiveSelection<T>(){return undefined as T;}};
  await assert.rejects(withVerifiedTransferHelper(nonEntering,f.store,async()=>{calls++;}),/TRANSFER_HELPER_RUNTIME_ACTIVATION_UNCONFIRMED/);
  assert.equal(calls,0);
});
test('ordinary native and Hub startup without protected composition cannot activate transfer',async()=>{
  await assert.rejects(runProtectedTransferNativeAgent({} as Parameters<typeof runProtectedTransferNativeAgent>[0],{}),/PROTECTED_NATIVE_TRANSFER_STARTUP_REQUIRED/);
  await assert.rejects(runProtectedTransferHub({} as Parameters<typeof runProtectedTransferHub>[0],{} as Parameters<typeof runProtectedTransferHub>[1]),/PROTECTED_TRANSFER_HUB_STARTUP_REQUIRED/);
});
test('combined CORE/transfer service denies mismatched authority before any DB or listener startup',async()=>{
  const config={core:{authorityId:'one',database:{}},transfer:{authority:{authorityId:'two'},server:{authorityId:'two'},database:{}},startupScope:{}};
  await assert.rejects(startProtectedTransferAndCoreServices(config as unknown as Parameters<typeof startProtectedTransferAndCoreServices>[0]),/TRANSFER_CORE_SHARED_AUTHORITY_STARTUP_REQUIRED/);
});
