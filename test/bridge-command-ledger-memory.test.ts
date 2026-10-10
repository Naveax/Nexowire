import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import type { BridgeQueuedCommand } from '../src/product/control-plane-store.js';

const initial='2026-10-10T14:00:00.000Z';
const expires='2026-10-10T14:02:00.000Z';
const hash='e'.repeat(64);
const device={
  id:'ledger-d',ownerAccountId:'ledger-o',deviceAnchorHash:null,
  name:'Ledger',platform:'win32',credentialHash:hash,
  accessMode:'full' as const,agentVersion:null,
  privilegeMode:'broker' as const,adminBridgeReady:true,
  online:true,lastSeenAt:initial,createdAt:initial,updatedAt:initial,
};
const command:BridgeQueuedCommand={
  requestId:'11111111-1111-4111-8111-111111111111',
  deviceId:device.id,ownerAccountId:device.ownerAccountId,
  credentialBinding:hash,desiredMode:'on',issuedAt:initial,expiresAt:expires,
};

test('memory ledger mirrors D1 one-time queue claim completion and pairing invalidation',async()=>{
  const store=new MemoryControlPlaneStore();
  await store.putDevice(device);
  assert.equal(await store.queueBridgeCommand(command),true);
  assert.equal(await store.queueBridgeCommand(command),false);
  const claims=await Promise.all(Array.from({length:8},()=>
    store.claimBridgeCommand(command.requestId,device.id,hash,'2026-10-10T14:00:10.000Z')));
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await store.completeBridgeCommand(
    command.requestId,device.id,hash,'applied','2026-10-10T14:00:20.000Z',null),true);
  assert.equal(await store.completeBridgeCommand(
    command.requestId,device.id,hash,'applied','2026-10-10T14:00:21.000Z',null),false);
  const complete=await store.getBridgeCommand(command.requestId);
  assert.equal(complete?.status,'applied');
  assert.equal(complete?.failureCode,null);
  const pending={...command,requestId:'22222222-2222-4222-8222-222222222222'};
  assert.equal(await store.queueBridgeCommand(pending),true);
  assert.equal(await store.claimBridgeCommand(pending.requestId,device.id,hash,expires),false);
  await store.putDevice({...device,credentialHash:'f'.repeat(64)});
  assert.equal(await store.claimBridgeCommand(pending.requestId,device.id,hash,'2026-10-10T14:00:22.000Z'),false);
  assert.equal(await store.queueBridgeCommand({...pending,requestId:'33333333-3333-4333-8333-333333333333'}),false);
});

test('memory ledger rejects invalid ownership and timestamps before writing',async()=>{
  const store=new MemoryControlPlaneStore();
  await store.putDevice(device);
  for(const candidate of [
    {...command,ownerAccountId:'another'},
    {...command,deviceId:'another'},
    {...command,credentialBinding:'f'.repeat(64)},
    {...command,requestId:'not-uuid'},
    {...command,desiredMode:'uninstall' as 'on'},
    {...command,issuedAt:'2026-10-10T14:00:00Z'},
    {...command,expiresAt:'2026-10-10T14:04:00.000Z'},
    {...command,expiresAt:initial},
  ]) {
    assert.equal(await store.queueBridgeCommand(candidate),false);
  }
  assert.equal(await store.getBridgeCommand(command.requestId),null);
  assert.equal(await store.queueBridgeCommand(command),true);
  assert.equal(await store.claimBridgeCommand(command.requestId,device.id,hash,'bad'),false);
  assert.equal(await store.claimBridgeCommand(command.requestId,device.id,hash,'2026-10-10T13:59:59.000Z'),false);
  assert.equal(await store.claimBridgeCommand(command.requestId,device.id,hash,'2026-10-10T14:00:10.000Z'),true);
  assert.equal(await store.completeBridgeCommand(command.requestId,device.id,hash,
    'failed','2026-10-10T14:00:09.000Z','BROKER_FAILED'),false);
  assert.equal(await store.completeBridgeCommand(command.requestId,device.id,hash,
    'failed','2026-10-10T14:00:11.000Z','invalid code'),false);
  assert.equal(await store.completeBridgeCommand(command.requestId,device.id,hash,
    'failed','2026-10-10T14:00:11.000Z','BROKER_FAILED'),true);
  assert.equal((await store.getBridgeCommand(command.requestId))?.status,'failed');
});
