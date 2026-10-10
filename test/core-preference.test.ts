import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService, type ControlPlaneIdentity } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

test('CORE policy is owner-bound, indefinite, Broker-dependent and revoked by SAFE', async () => {
  let now = new Date('2026-10-10T11:00:00Z');
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {now:()=>now});
  const owner = {accountId:'core-owner',role:'user'} as const;
  const outsider = {accountId:'other',role:'user'} as const;
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:outsider.accountId});
  const challenge = await service.beginPairing(owner,'core-test-device');
  const paired = await service.consumePairing({
    pairingId:challenge.pairingId,token:challenge.token,
    platform:'win32',deviceAnchorHash:'1'.repeat(64),
  });
  const id = paired.device.id;
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
  await service.setDeviceAccessMode(owner,id,'full');
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
  const device = await store.getDevice(id); assert.ok(device);
  await store.putDevice({...device,online:true,privilegeMode:'direct',adminBridgeReady:true});
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:false});
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:true});
  await assert.rejects(service.setDeviceCorePreference(outsider,id,true),/DEVICE_NOT_FOUND/);
  await assert.rejects(service.setDeviceCorePreference({accountId:owner.accountId,role:'service'},id,true),/CORE_REQUIRES_OWNER_LOGIN/);
  const granted = await service.setDeviceCorePreference(owner,id,true);
  assert.equal(granted.persistentMaintenance.active,true);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,true);
  now = new Date('2028-10-10T11:00:00Z');
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.active,true);
  await store.putDevice({...device,online:false,privilegeMode:'broker',adminBridgeReady:false});
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,true);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.active,false);
  await service.setDeviceCorePreference(owner,id,false);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:true});
  await service.setDeviceCorePreference(owner,id,true);
  await service.setDeviceAccessMode(owner,id,'safe');
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
  await service.setDeviceAccessMode(owner,id,'full');
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.active,false);
});

test('CORE HTTP activation requires authenticated owner and typed confirmation', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store);
  const owner:ControlPlaneIdentity={accountId:'core-http-owner',role:'user'};
  await service.ensureAccount({id:owner.accountId});
  const challenge=await service.beginPairing(owner,'core-http-device');
  const {device}=await service.consumePairing({
    pairingId:challenge.pairingId,token:challenge.token,
    platform:'win32',deviceAnchorHash:'2'.repeat(64),
  });
  await service.setDeviceAccessMode(owner,device.id,'full');
  await service.setDevicePresence(device.id,true,new Date().toISOString(),{privilegeMode:'broker',adminBridgeReady:true});
  const handle=createControlPlaneHttpHandler(service,{
    authenticate: async r => {
      const raw=r.headers.get('x-test-identity');
      return raw ? JSON.parse(raw) as ControlPlaneIdentity : null;
    },
  });
  const path='/api/v1/me/devices/core-preference';
  const body=JSON.stringify({deviceId:device.id,enabled:true,confirmation:'CORE UNLIMITED'});
  const req=(identity:ControlPlaneIdentity|null,confirm:string|null,payload=body)=>new Request('https://test.example'+path,{
    method:'POST',headers:{
      'content-type':'application/json',
      ...(identity?{'x-test-identity':JSON.stringify(identity)}:{}),
      ...(confirm?{'x-nexowire-confirm':confirm}:{}),
    },body:payload,
  });
  assert.equal((await handle(req(null,'core-preference-v1'))).status,401);
  assert.equal((await handle(req(owner,null))).status,400);
  assert.equal((await handle(req(owner,'wrong'))).status,400);
  assert.equal((await handle(req({...owner,role:'service'},'core-preference-v1'))).status,403);
  assert.equal((await handle(req({accountId:'another',role:'user'},'core-preference-v1'))).status,404);
  const result=await handle(req(owner,'core-preference-v1'));
  assert.equal(result.status,200);
  assert.equal((await result.json() as {persistentMaintenance:{active:boolean}}).persistentMaintenance.active,true);
  const off=await handle(req(owner,null,JSON.stringify({deviceId:device.id,enabled:false})));
  assert.equal(off.status,200);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
});

test('Admin Bridge modes persist as desired-only policy and OFF invalidates CORE', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store);
  const owner = {accountId:'bridge-owner',role:'user'} as const;
  await service.ensureAccount({id:owner.accountId});
  const pairing=await service.beginPairing(owner,'bridge-test');
  const {device}=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'f'.repeat(64),
  });
  const id=device.id;
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.desiredMode,'auto');
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.applied,false);
  await service.setDeviceAccessMode(owner,id,'full');
  await service.setDevicePresence(id,true,new Date().toISOString(),{privilegeMode:'broker',adminBridgeReady:true});
  await service.setDeviceCorePreference(owner,id,true);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.active,true);
  await assert.rejects(service.setDeviceBridgePreference({...owner,role:'service'},id,'off'),/BRIDGE_REQUIRES_OWNER_LOGIN/);
  await assert.rejects(service.setDeviceBridgePreference(owner,id,'invalid'),/INVALID_BRIDGE_MODE/);
  const off=await service.setDeviceBridgePreference(owner,id,'off');
  assert.equal(off.bridgePreference.applied,false);
  assert.equal(off.bridgePreference.desiredMode,'off');
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
  await service.setDeviceBridgePreference(owner,id,'auto');
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.desiredMode,'auto');
  await service.setDeviceBridgePreference(owner,id,'on');
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.desiredMode,'on');
  await service.setDeviceAccessMode(owner,id,'safe');
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.desiredMode,'off');
});

test('Admin Bridge mode API requires owner authentication and explicit confirmation', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store);
  const owner:ControlPlaneIdentity={accountId:'bridge-http',role:'user'};
  await service.ensureAccount({id:owner.accountId});
  const pairing=await service.beginPairing(owner,'bridge-api');
  const {device}=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'e'.repeat(64),
  });
  const handler=createControlPlaneHttpHandler(service,{
    authenticate:async r => {
      const raw=r.headers.get('x-test-identity');
      return raw?JSON.parse(raw) as ControlPlaneIdentity:null;
    },
  });
  const mk=(identity:ControlPlaneIdentity|null,confirm:boolean)=>new Request('https://test.example/api/v1/me/devices/bridge-preference',{
    method:'POST',headers:{
      'content-type':'application/json',
      ...(identity?{'x-test-identity':JSON.stringify(identity)}:{}),
      ...(confirm?{'x-nexowire-confirm':'bridge-preference-v1'}:{}),
    },body:JSON.stringify({deviceId:device.id,mode:'off'}),
  });
  assert.equal((await handler(mk(null,true))).status,401);
  assert.equal((await handler(mk(owner,false))).status,400);
  assert.equal((await handler(mk({...owner,role:'service'},true))).status,403);
  assert.equal((await handler(mk(owner,true))).status,200);
  assert.equal((await service.dashboard(owner)).devices[0]?.bridgePreference.applied,false);
});
