import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwnerDeviceTarget } from '../src/product/device-target-resolution.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

const owner = { accountId:'acct-owner', role:'user' as const };
const outsider = { accountId:'acct-other', role:'user' as const };
const devices = [
  {id:'a',name:'Naveax',online:true,folderId:'fn'},
  {id:'b',name:'work-pc',online:true,folderId:'fn'},
  {id:'c',name:'Maxiwillanwelltman',online:false,folderId:'fm'},
];
const folders = [
  {id:'fn',name:'Naveax'}, {id:'fm',name:'Maxi'}, {id:'fe',name:'Buğra'},
];

test('explicit device name and folder+single device resolve deterministically', () => {
  const named = resolveOwnerDeviceTarget(devices, folders, {deviceName:' Maxiwillanwelltman '});
  assert.equal(named.status, 'selected');
  if (named.status === 'selected') {
    assert.equal(named.device.id, 'c');
    assert.equal(named.device.online, false);
  }
  const scoped = resolveOwnerDeviceTarget(devices, folders, {folderName:'MAXI'});
  assert.equal(scoped.status, 'selected');
  if (scoped.status === 'selected') {
    assert.equal(scoped.reason, 'one-in-folder');
    assert.equal(scoped.device.id, 'c');
  }
  assert.throws(() =>
    resolveOwnerDeviceTarget(devices, folders, {folderName:'Maxi',deviceName:'Naveax'}), /DEVICE_NOT_FOUND/);
});

test('ambiguous targets require a choice; empty folders remain visible', () => {
  const implicit = resolveOwnerDeviceTarget(devices, folders);
  assert.equal(implicit.status, 'selection_required');
  if (implicit.status === 'selection_required') {
    assert.equal(implicit.devices.length, 3);
    assert.equal(implicit.folders.length, 3);
  }
  const mixed = resolveOwnerDeviceTarget(devices, folders, {folderName:'Naveax'});
  assert.equal(mixed.status, 'selection_required');
  if (mixed.status === 'selection_required') {
    assert.deepEqual(mixed.devices.map(d=>d.id), ['a','b']);
  }
  const empty = resolveOwnerDeviceTarget(devices, folders, {folderName:'Buğra'});
  assert.equal(empty.status, 'empty_folder');
  assert.equal(resolveOwnerDeviceTarget(devices.slice(0,1), folders).status, 'selected');
  assert.equal(resolveOwnerDeviceTarget([], folders).status, 'no_devices');
});

test('owner service routing restricts account devices and folder membership', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store);
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:outsider.accountId});
  const p = await service.beginPairing(owner, 'machine');
  const consumed = await service.consumePairing({
    pairingId:p.pairingId,token:p.token,platform:'win32',deviceAnchorHash:'f'.repeat(64),
  });
  const group = await service.createDeviceFolder(owner, 'Maxi');
  await service.assignDeviceToFolder(owner, consumed.device.id, group.id);
  const selected = await service.resolveDeviceTarget(owner, {folderName:'Maxi'});
  assert.equal(selected.status, 'selected');
  if(selected.status === 'selected') assert.equal(selected.device.id, consumed.device.id);
  await assert.rejects(service.resolveDeviceTarget(outsider,{folderId:group.id}),/FOLDER_NOT_FOUND/);
  await assert.rejects(service.resolveDeviceTarget(outsider,{deviceId:consumed.device.id}),/DEVICE_NOT_FOUND/);
  await assert.rejects(service.resolveDeviceTarget({accountId:owner.accountId,role:'service'},{}),/OWNER_LOGIN_REQUIRED/);
});

test('target API requires OAuth owner and confirmation header, never executes a task', async () => {
  const service = new ControlPlaneService(new MemoryControlPlaneStore());
  await service.ensureAccount({id:owner.accountId});
  const handler = createControlPlaneHttpHandler(service,{
    authenticate: async req => req.headers.get('x-account') === 'owner' ? owner
      : req.headers.get('x-account') === 'service'
        ? {accountId:owner.accountId,role:'service'} : null,
  });
  const url = 'https://control.test/api/v1/me/devices/resolve-target';
  const request = (account:string|null, confirm = true, body:unknown = {}) => {
    const headers: Record<string,string> = {'content-type':'application/json'};
    if (account) headers['x-account'] = account;
    if (confirm) headers['x-nexowire-confirm'] = 'device-target-v1';
    return new Request(url,{method:'POST',headers,body:JSON.stringify(body)});
  };
  assert.equal((await handler(request(null))).status,401);
  assert.equal((await handler(request('owner',false))).status,403);
  assert.equal((await handler(request('service'))).status,403);
  assert.equal((await handler(request('owner',true,{folderName:3}))).status,400);
  const result = await handler(request('owner'));
  assert.equal(result.status,200);
  assert.deepEqual((await result.json() as {status:string}).status, 'no_devices');
});
