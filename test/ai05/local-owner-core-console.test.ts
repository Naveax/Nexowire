import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalOwnerCoreConsole,WindowsLocalOwnerCoreStore,
  type LocalOwnerCoreGrant,type LocalOwnerCoreStore} from '../../src/agent/local-owner-core-console.js';
import type {CoreAuthorityState} from '../../src/protocol/core-console-authority.js';
import {NEXOWIRE_VERSION} from '../../src/version.js';

function fixture(){
  let grant:LocalOwnerCoreGrant|null=null,stopped=false,prompts=0,effects=0;
  const reserved=new Set<string>();
  const store:LocalOwnerCoreStore={stopFile:'unused-test-stop-file',
    load:async()=>grant,save:async g=>{grant=structuredClone(g);},
    stopped:async()=>stopped,stop:async()=>{stopped=true;},clearStop:async()=>{stopped=false;},
    reserve:async id=>{if(reserved.has(id))throw Error('DUPLICATE');reserved.add(id);}};
  const state={ownerAccountId:'owner-fixture',deviceId:'device-fixture',ownerEpoch:1,
    grantGeneration:1,revokeEpoch:0,coreEnabled:true,accessMode:'full',deviceOnline:true,
    bridgeVerified:true,authorityTimeMs:Date.now(),enrollmentRequested:false,enrollmentId:null,
    publicKeySpki:null,physicalActive:false,statusObservedAtMs:null,nativeConsentReceiptId:null,
    windowsUserSid:null,windowsSessionId:null,windowsLogonLuid:null,windowsLogonSessionEpoch:null} as Omit<CoreAuthorityState,'installationId'>;
  let approve=async()=>true;
  const options={deviceId:state.deviceId,store,
    read:async(installationId:string)=>({...state,installationId}),
    probe:async()=>({reachable:true,elevated:true,version:NEXOWIRE_VERSION}),
    approve:async()=>{prompts++;return approve();},
    native:async()=>{effects++;return {data:{nativeEffectVerified:true}};}};
  return {state,options,make:()=>new LocalOwnerCoreConsole(options),
    approve:(f:()=>Promise<boolean>)=>{approve=f;},prompts:()=>prompts,effects:()=>effects};
}
const signal=()=>new AbortController().signal;

test('local owner approves once and a fresh controller reuses indefinite persisted consent',async()=>{
  const f=fixture();const first=f.make();
  assert.equal((await first.status('full')).active,false);
  assert.equal(await first.enroll(signal()),true);
  first.close();
  const second=f.make();
  assert.equal((await second.status('full')).active,true);
  assert.equal((await second.status('full')).expiresAt,null);
  assert.equal(await second.enroll(signal()),true);
  assert.equal(f.prompts(),1);
  await second.execute('windows.pointer.move',{x:0,y:0},randomUUID(),'full');
  assert.equal(f.effects(),1);
});

test('denied local approval never enrolls or executes',async()=>{
  const f=fixture();f.approve(async()=>false);const c=f.make();
  assert.equal(await c.enroll(signal()),false);
  await assert.rejects(c.execute('windows.pointer.move',{},randomUUID(),'full'),/CORE_NOT_ACTIVE/);
  assert.equal(f.effects(),0);
});

test('CORE off, SAFE, owner/epoch change pause or invalidate local consent',async()=>{
  for(const change of [()=>({coreEnabled:false}),()=>({accessMode:'safe' as const}),
    ()=>({ownerAccountId:'different-owner'}),()=>({revokeEpoch:1})]){
    const f=fixture();const c=f.make();await c.enroll(signal());Object.assign(f.state,change());
    assert.equal((await c.status('full')).active,false);
    await assert.rejects(c.execute('windows.pointer.move',{},randomUUID(),'full'));
    assert.equal(f.effects(),0);
  }
});

test('temporary Broker loss does not discard consent or require another approval',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  f.options.probe=async()=>({reachable:false,elevated:false,version:NEXOWIRE_VERSION});
  assert.equal((await c.status('full')).active,false);
  f.options.probe=async()=>({reachable:true,elevated:true,version:NEXOWIRE_VERSION});
  assert.equal((await c.status('full')).active,true);assert.equal(f.prompts(),1);
});

test('temporary authority 503 is retried once without losing persisted owner consent',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  const original=f.options.read;let calls=0;
  f.options.read=async installationId=>{
    calls++;
    if(calls===1)throw Error('CORE_AUTHORITY_DENIED_503');
    return original(installationId);
  };
  const status=await c.status('full');
  assert.equal(status.state,'ACTIVE_LOCAL_OWNER');
  assert.equal(calls,2);
  assert.equal(f.prompts(),1,'no additional physical approval after retry');
});

test('hard owner authority denial or repeated failure never activates stale consent',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  let calls=0;
  f.options.read=async()=>{calls++;throw Error('CORE_AUTHORITY_DENIED_403');};
  assert.equal((await c.status('full')).state,'CORE_CURRENT_STATE_UNAVAILABLE');
  assert.equal(calls,1,'explicit denial must not be retried');
  calls=0;
  f.options.read=async()=>{calls++;throw Error('CORE_AUTHORITY_DENIED_503');};
  const unavailable=await c.status('full');
  assert.equal(unavailable.active,false);
  assert.equal(unavailable.state,'CORE_CURRENT_STATE_UNAVAILABLE');
  assert.equal(calls,2,'transient error has one bounded retry, not an unbounded loop');
  assert.equal(f.prompts(),1);
});

test('owner change on a retried authority read still invalidates the grant',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  const original=f.options.read;let calls=0;
  f.options.read=async installationId=>{
    calls++;
    if(calls===1)throw new TypeError('fetch failed');
    return {...(await original(installationId)),ownerAccountId:'different-owner'};
  };
  const status=await c.status('full');
  assert.equal(calls,2);
  assert.equal(status.active,false);
  assert.equal(status.state,'CORE_OWNER_OR_GRANT_CHANGED');
  await assert.rejects(c.execute('windows.pointer.move',{},randomUUID(),'full'),/CORE_NOT_ACTIVE/);
  assert.equal(f.effects(),0);
});

test('local revoke survives controller restart and requires a new local approval',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());await c.revoke();
  const next=f.make();assert.equal((await next.status('full')).active,false);
  await next.enroll(signal());assert.equal((await next.status('full')).active,true);
  assert.equal(f.prompts(),2);
});

test('revoke or owner change while prompt is open cannot save active consent',async()=>{
  for(const revoke of [true,false]){
    const f=fixture();const c=f.make();
    f.approve(async()=>{if(revoke)await c.revoke();else Object.assign(f.state,{ownerEpoch:f.state.ownerEpoch+1});return true;});
    if(revoke)assert.equal(await c.enroll(signal()),false);
    else await assert.rejects(c.enroll(signal()),/CORE_CHANGED/);
    assert.equal((await c.status('full')).active,false);
  }
});

test('same request cannot execute again after a controller restart',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());const id=randomUUID();
  await c.execute('windows.pointer.move',{},id,'full');
  await assert.rejects(f.make().execute('windows.pointer.move',{},id,'full'),/DUPLICATE/);
  assert.equal(f.effects(),1);
});

test('local CORE never promotes shell commands into privileged effects',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  await assert.rejects(c.execute('shell.exec',{},randomUUID(),'full'),/SCOPE_DENIED/);
  assert.equal(f.effects(),0);
});

test('disk request reservation survives a newly constructed store',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nwx-owner-core-'));
  try{
    const id=randomUUID();await new WindowsLocalOwnerCoreStore(root).reserve(id);
    await assert.rejects(new WindowsLocalOwnerCoreStore(root).reserve(id),{code:'EEXIST'});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('CORE unavailable status provides bounded, non-secret source diagnostics',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  const original=f.options.read;
  for(const [error,expected] of [
    [Error('CORE_AUTHORITY_DENIED_403'),'AUTHORITY_HTTP_403'],
    [Error('CORE_AUTHORITY_DENIED_502'),'AUTHORITY_HTTP_502'],
    [Error('CORE_AUTHORITY_DENIED_503'),'AUTHORITY_HTTP_503'],
    [Error('CORE_AUTHORITY_DENIED_504'),'AUTHORITY_HTTP_504'],
    [new TypeError('fetch failed'),'AUTHORITY_NETWORK'],
    [Object.assign(new Error('The operation was aborted'),{name:'TimeoutError'}),
      'AUTHORITY_TIMEOUT'],
    [Error('CORE_AUTHORITY_DENIED_429'),'AUTHORITY_HTTP_OTHER'],
    [Error('secret:private-account-token-should-not-appear'),'UNKNOWN'],
  ] as const){
    f.options.read=async()=>{throw error;};
    const status=await c.status('full');
    assert.equal(status.active,false);
    assert.equal(status.state,'CORE_CURRENT_STATE_UNAVAILABLE');
    assert.equal(status.unavailableReason,expected);
    assert.equal(JSON.stringify(status).includes('private-account-token'),false);
  }
  f.options.read=async id=>({...await original(id),deviceId:'wrong-device'});
  assert.equal((await c.status('full')).unavailableReason,'OWNER_DEVICE_MISMATCH');
  f.options.read=original;
  f.options.probe=async()=>{throw Error('sensitive local broker configuration');};
  assert.equal((await c.status('full')).unavailableReason,'BROKER_PROBE_FAILED');
  assert.equal(f.prompts(),1,'diagnostics must not invoke enrollment again');
  assert.equal(f.effects(),0);
});

test('unreadable local DPAPI grant reports local cause and never executes a CORE effect',async()=>{
  const f=fixture();const c=f.make();await c.enroll(signal());
  f.options.store.load=async()=>{throw Error('sensitive encrypted grant file contents');};
  const status=await c.status('full');
  assert.equal(status.state,'CORE_CURRENT_STATE_UNAVAILABLE');
  assert.equal(status.unavailableReason,'LOCAL_GRANT_READ_FAILED');
  assert.equal(status.active,false);
  assert.equal(JSON.stringify(status).includes('sensitive'),false);
  await assert.rejects(c.execute('windows.pointer.move',{x:0,y:0},randomUUID(),'full'),/CORE_NOT_ACTIVE/);
  assert.equal(f.effects(),0);
});
