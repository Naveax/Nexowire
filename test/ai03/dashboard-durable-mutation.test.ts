import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {dashboardMutationFixture} from './dashboard-mutation-d1-fixture.js';
import {createControlPlaneHttpHandler} from '../../src/product/control-plane-http.js';
import type {ControlPlaneIdentity} from '../../src/product/control-plane-service.js';
const owner={accountId:'mutation-owner',role:'user'} as const;
const other={accountId:'mutation-other',role:'user'} as const;
const coreId=()=> 'core-v1:'+randomUUID();
const pairingId=(state:string)=>'pairing-v1:'+createHash('sha256').update('nexowire-pairing-v1\0'+state).digest('hex');
const pairing='/api/v1/pairing',core='/api/v1/me/devices/core-preference',consent='/api/v1/me/devices/core-enrollment-request';
type Fixture=ReturnType<typeof dashboardMutationFixture>;
function handler(f:Pick<Fixture,'service'|'authority'>,who:ControlPlaneIdentity|null=owner){
  return createControlPlaneHttpHandler(f.service,{authenticate:async()=>who,coreConsoleAuthority:f.authority});
}
function post(h:ReturnType<typeof handler>,route:string,id:string|null,body:unknown,confirm?:string){
  const headers=new Headers({'content-type':'application/json'});
  if(id!==null)headers.set('x-nexowire-mutation-id',id);
  if(confirm)headers.set('x-nexowire-confirm',confirm);
  return h(new Request('https://control.test'+route,{method:'POST',headers,body:JSON.stringify(body)}));
}
function status(h:ReturnType<typeof handler>,id:string){
  return h(new Request('https://control.test/api/v1/me/mutations/status?mutationId='+encodeURIComponent(id)));
}
async function accounts(f:Fixture){
  await f.service.ensureAccount({id:owner.accountId});await f.service.ensureAccount({id:other.accountId});
}
async function device(f:Fixture){
  const p=await f.service.beginPairing(owner,'CORE fixture');
  const {device}=await f.service.consumePairing({pairingId:p.pairingId,token:p.token,platform:'win32',deviceAnchorHash:'d'.repeat(64)});
  await f.service.setDeviceAccessMode(owner,device.id,'full');
  await f.service.setDevicePresence(device.id,true,new Date().toISOString(),{privilegeMode:'broker',adminBridgeReady:true});
  return device.id;
}
const count=(f:Fixture,table:'pairings'|'device_maintenance_events'|'dashboard_mutation_claims')=>
  Number(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get()?.n);

test('different browser profiles: same local pairing identity produces exactly one challenge; no token replay',async()=>{
  const f=dashboardMutationFixture();
  try{
    await accounts(f);const profileA=handler(f),profileB=handler(f.open());
    const id=pairingId('one native pairing session'),body={deviceId:'device-intent-one',deviceName:'Test PC'};
    const result=await Promise.all([post(profileA,pairing,id,body),post(profileB,pairing,id,body)]);
    assert.deepEqual(result.map(r=>r.status).sort(),[201,409]);
    const first=await result.find(r=>r.status===201)!.json() as {token:string};
    assert.match(first.token,/^nwx_pair_/);
    const duplicate=await result.find(r=>r.status===409)!.json();
    assert.deepEqual(duplicate,{error:'DASHBOARD_MUTATION_ALREADY_APPLIED'});
    assert.equal(count(f,'pairings'),1);assert.equal(count(f,'dashboard_mutation_claims'),1);
    const read=await status(profileB,id);assert.equal(read.status,200);
    const receipt=await read.text();assert.match(receipt,/"state":"APPLIED"/);assert.ok(!receipt.includes(first.token));
    assert.equal((await status(handler(f.open(),other),id)).status,404);
    assert.equal((await post(handler(f.open(),other),pairing,id,body)).status,409);
    assert.equal((await post(profileB,pairing,id,{...body,deviceName:'different'})).status,409);
    assert.equal((await post(profileB,pairing,null,body)).status,400);
    assert.equal(count(f,'pairings'),1);
  }finally{f.close();}
});
test('post-commit ACK loss: pairing tombstone survives new connection, never creates or replays a token',async()=>{
  const f=dashboardMutationFixture();
  try{
    await accounts(f);const id=pairingId('ack-lost'),body={deviceId:'device-lost-ack',deviceName:'Test'};
    f.adapter.loseNextAck=true;
    assert.equal((await post(handler(f),pairing,id,body)).status,500);
    assert.equal(count(f,'pairings'),1);
    const fresh=handler(f.open());
    assert.equal((await post(fresh,pairing,id,body)).status,409);
    assert.deepEqual(await (await status(fresh,id)).json(),{mutationId:id,deviceId:body.deviceId,kind:'pairing',state:'APPLIED',expectedRevision:null});
    assert.equal(count(f,'pairings'),1);
    assert.throws(()=>f.db.prepare('DELETE FROM dashboard_mutation_claims WHERE mutation_id=?').run(id),/IMMUTABLE/);
  }finally{f.close();}
});
test('CORE distinct profile IDs share atomic revision CAS; duplicates, ACK loss, semantic repeats and stale generation do not write',async()=>{
  const f=dashboardMutationFixture();
  try{
    await accounts(f);const deviceId=await device(f),profileA=handler(f),profileB=handler(f.open());
    const revision=await f.store.dashboardMutations.revision(deviceId,owner.accountId);assert.ok(revision);
    const ids=[coreId(),coreId()],payload={deviceId,enabled:true,confirmation:'CORE UNLIMITED',expectedRevision:revision};
    const before=count(f,'device_maintenance_events');
    const a=await Promise.all([post(profileA,core,ids[0]!,payload,'core-preference-v1'),post(profileB,core,ids[1]!,payload,'core-preference-v1')]);
    assert.deepEqual(a.map(r=>r.status).sort(),[200,409]);
    const won=ids[a.findIndex(r=>r.status===200)]!,lost=ids[a.findIndex(r=>r.status===409)]!;
    assert.equal(count(f,'device_maintenance_events'),before+1);
    const first=await a.find(r=>r.status===200)!.json() as {persistentMaintenance:{active:boolean}};
    assert.equal(first.persistentMaintenance.active,false);
    assert.equal((await (await status(profileB,won)).json() as {state:string}).state,'APPLIED');
    assert.equal((await (await status(profileB,lost)).json() as {state:string}).state,'DENIED');
    const newer=await f.store.dashboardMutations.revision(deviceId,owner.accountId);assert.ok(newer&&newer>revision);
    assert.equal((await post(profileB,core,won,payload,'core-preference-v1')).status,409);
    assert.equal((await post(profileB,core,lost,{...payload,expectedRevision:newer},'core-preference-v1')).status,409);
    assert.equal((await post(profileB,core,coreId(),{...payload,expectedRevision:newer},'core-preference-v1')).status,409);
    assert.equal((await post(profileB,core,null,{...payload,expectedRevision:newer},'core-preference-v1')).status,400);
    assert.equal(count(f,'device_maintenance_events'),before+1);
    // A fresh explicit OFF has its own identity/revision. Drop its commit ACK.
    const off=coreId(),offBody={deviceId,enabled:false,expectedRevision:newer};
    f.adapter.loseNextAck=true;
    assert.equal((await post(profileA,core,off,offBody)).status,500);
    assert.equal((await post(profileB,core,off,offBody)).status,409);
    assert.equal((await (await status(profileB,off)).json() as {state:string}).state,'APPLIED');
    assert.equal((await f.store.getDeviceMaintenancePreference(deviceId))?.enabled,false);
    assert.equal(count(f,'device_maintenance_events'),before+2);
    const last=await f.store.dashboardMutations.revision(deviceId,owner.accountId);assert.ok(last&&last>newer);
    await f.service.revokeDeviceRemoteAuthorization(owner,deviceId);
    assert.ok((await f.store.dashboardMutations.revision(deviceId,owner.accountId))!>last);
    assert.equal((await post(profileB,core,coreId(),{...payload,expectedRevision:last},'core-preference-v1')).status,409);
    assert.equal(count(f,'device_maintenance_events'),before+2);
  }finally{f.close();}
});
test('CORE consent request is a single pending transition, not local approval; missing issuer cannot enable',async()=>{
  const f=dashboardMutationFixture();
  try{
    await accounts(f);const deviceId=await device(f),a=handler(f),b=handler(f.open());
    const rev=()=>f.store.dashboardMutations.revision(deviceId,owner.accountId);
    const p={deviceId,enabled:true,confirmation:'CORE UNLIMITED',expectedRevision:await rev()};
    const noIssuer=createControlPlaneHttpHandler(f.service,{authenticate:async()=>owner});
    assert.equal((await post(noIssuer,core,coreId(),p,'core-preference-v1')).status,503);
    assert.equal((await post(a,core,coreId(),p,'core-preference-v1')).status,200);
    // Model a current authoritative request dismissal. No native approval is simulated.
    f.db.prepare('UPDATE device_core_console_authority SET enrollment_requested=0 WHERE device_id=?').run(deviceId);
    const current=await rev(),body={deviceId,expectedRevision:current};
    const results=await Promise.all([post(a,consent,coreId(),body,'core-enrollment-request-v1'),post(b,consent,coreId(),body,'core-enrollment-request-v1')]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const accepted=await results.find(r=>r.status===200)!.json() as {active:boolean;enrollmentRequested:boolean};
    assert.equal(accepted.active,false);assert.equal(accepted.enrollmentRequested,true);
    assert.equal(f.db.prepare('SELECT enrollment_requested,enrollment_id FROM device_core_console_authority WHERE device_id=?').get(deviceId)?.enrollment_requested,1);
    assert.equal(f.db.prepare('SELECT enrollment_id FROM device_core_console_authority WHERE device_id=?').get(deviceId)?.enrollment_id,null);
    assert.equal((await post(b,consent,coreId(),{deviceId,expectedRevision:await rev()},'core-enrollment-request-v1')).status,409);
  }finally{f.close();}
});

test('dashboard CAS token is withheld if relevant state changes during dashboard or console readback',async()=>{
  const f=dashboardMutationFixture();
  try{
    await accounts(f);const id=await device(f);
    const read=async(h=handler(f))=>{
      const response=await h(new Request('https://control.test/api/v1/me/dashboard'));
      assert.equal(response.status,200);
      const data=await response.json() as {devices:{id:string;coreMutationRevision:number|null}[]};
      return data.devices.find(x=>x.id===id)?.coreMutationRevision;
    };
    const original=await read();assert.ok(original);
    const get=f.store.getDeviceMaintenancePreference.bind(f.store);
    f.store.getDeviceMaintenancePreference=async target=>{
      const prior=await get(target);
      f.db.prepare('UPDATE devices SET online=0 WHERE id=?').run(id);
      return prior;
    };
    assert.equal(await read(),null);
    f.store.getDeviceMaintenancePreference=get;
    f.db.prepare('UPDATE devices SET online=1 WHERE id=?').run(id);
    const stable=await read();assert.ok(stable&&stable>original);
    const delayed=createControlPlaneHttpHandler(f.service,{authenticate:async()=>owner,
      coreConsoleAuthority:{handle:async()=>{throw Error('not a device request');},
        deviceStatus:async()=>{
          f.db.prepare('UPDATE devices SET online=0 WHERE id=?').run(id);
          return {localEnrolled:false,active:false,observedAtMs:null};
        }}});
    assert.equal(await read(delayed),null);
  }finally{f.close();}
});
