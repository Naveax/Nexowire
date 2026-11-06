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
