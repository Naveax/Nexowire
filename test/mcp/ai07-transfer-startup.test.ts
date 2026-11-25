import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {HelperSelectionLeaseTransport} from '../../src/security/postgres-helper-selection-authority.js';
import {assertSelectedTransferHelper,withVerifiedTransferHelper,runProtectedTransferNativeAgent,createTransferRuntimeLeaseAuthority,type TransferHelperActiveLease,type TransferHelperRuntimeAuthority} from '../../src/agent/protected-transfer-startup.js';
import {installedTransferHelperPath,type HelperSelection,type TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import {runProtectedTransferHub} from '../../src/mcp/protected-transfer-hub-startup.js';
import {startProtectedTransferAndCoreServices} from '../../src/security/protected-transfer-services-startup.js';

const pin={sha256:'a'.repeat(64),signerSha256:'b'.repeat(64)};
function fixture(){
  let value:HelperSelection={revision:'r1',pin},held=false,verified=0;
  const authority:TransferHelperRuntimeAuthority={
    async withActiveSelection<T>(effect:(lease:TransferHelperActiveLease)=>Promise<T>){assert(!held);held=true;const ctrl=new AbortController();try{return await effect({signal:ctrl.signal,async assertActive(){assert(held);}});}finally{held=false;ctrl.abort();}},
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

test('real selection provider adapter uses original durable runtime lease, stops on readback loss and never releases UNKNOWN',async()=>{
  const id=randomUUID(),revision=randomUUID();let reads=0,releases=0,begins=0,loss=false;
  const transport:HelperSelectionLeaseTransport={
    async beginRuntime(requestId){begins++;return {id,requestId,kind:'RUNTIME',expectedRevision:revision};},
    async beginDeployment(){throw Error('unexpected deployment');},
    async read(leaseId){assert.equal(leaseId,id);reads++;if(loss)throw Error('fixture authority lost');return {revision,pin};},
    async commit(){throw Error('unexpected commit');},
    async release(){releases++;},
  };
  const authority=createTransferRuntimeLeaseAuthority(transport,250);
  const store:TransferHelperArtifactStore={async verifyInstalled(value){assert.deepEqual(value,pin);},async stage(){throw Error('unexpected stage');}};
  await assert.rejects(withVerifiedTransferHelper(authority,store,async(binding,scope)=>{
    assert.equal(binding.revision,revision);await scope.assertActive();
    loss=true;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('lease watchdog did not abort')),3000);
      const stop=()=>{clearTimeout(timer);resolve();};
      if(scope.signal.aborted)stop();else scope.signal.addEventListener('abort',stop,{once:true});
    });
    await assert.rejects(scope.assertActive(),/LEASE_RELEASED/);
    throw Error('runtime permanently fenced');
  }),/runtime permanently fenced/);
  assert(reads>=2);assert.equal(begins,1);assert.equal(releases,0);
  await assert.rejects(authority.withActiveSelection(async()=>{}),/SCOPE_RETIRED/);
});
test('detached lease callback cannot activate publisher after authority has returned',async()=>{
  const f=fixture();let resume!:()=>void,started!:()=>void,activated=0;
  const gate=new Promise<void>(r=>{resume=r;});
  const entered=new Promise<void>(r=>{started=r;});
  const ctrl=new AbortController();
  let pending:Promise<unknown>|undefined;
  const early:TransferHelperRuntimeAuthority={
    async readSelection(){return {revision:'r1',pin};},
    async withActiveSelection<T>(effect:(lease:TransferHelperActiveLease)=>Promise<T>){
      pending=effect({signal:ctrl.signal,async assertActive(){started();await gate;}}).catch(error=>error);
      await entered;return undefined as T;
    },
  };
  await assert.rejects(withVerifiedTransferHelper(early,f.store,async()=>{activated++;}),/ACTIVATION_UNCONFIRMED/);
  resume();assert.match(String(await pending),/LEASE_RELEASED/);assert.equal(activated,0);
});
