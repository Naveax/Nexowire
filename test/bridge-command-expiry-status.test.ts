import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {guardianPublicKeyId,signGuardianModeReceipt} from '../src/protocol/guardian-signed-receipt.js';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';

const base=new Date('2026-10-10T15:00:00.000Z');
async function fixture() {
  let time=new Date(base);
  const keys=generateKeyPairSync('ed25519');
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{now:()=>time});
  const owner={accountId:'expiry-owner',role:'user'} as const;
  await service.ensureAccount({id:owner.accountId});
  const pairing=await service.beginPairing(owner,'expiry-device');
  const paired=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'e'.repeat(64),
  });
  const deviceId=paired.device.id;
  await service.setDeviceAccessMode(owner,deviceId,'full');
  const device=await store.getDevice(deviceId);
  assert.ok(device);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:true});
  await service.setDeviceBridgePreference(owner,deviceId,'on');
  const issue=async()=>await service.issueBridgeModeCommand(owner,deviceId,'on');
  const now=(ms:number)=>{time=new Date(base.getTime()+ms)};
  const preference=await store.getDeviceBridgePreference(deviceId);
  assert.ok(preference);
  return {store,service,owner,deviceId,credential:paired.deviceCredential,issue,now,
    keys,preferenceRevision:preference.updatedAt};
}

test('unsigned finalization is not exposed outside ControlPlaneService',async()=>{
  const f=await fixture();
  assert.equal('completeBridgeModeCommand' in f.service,false);
  assert.equal(typeof f.service.completeSignedBridgeModeCommand,'function');
});

test('queued commands project expired exactly at expiry without writing into durable audit history',async()=>{
  const {store,service,owner,issue,now}=await fixture();
  const created=await issue();
  const first=await service.bridgeCommandStatus(owner,created.requestId);
  assert.equal(first.status,'queued');
  now(119_999);
  assert.equal((await service.bridgeCommandStatus(owner,created.requestId)).status,'queued');
  now(120_000);
  assert.equal((await service.bridgeCommandStatus(owner,created.requestId)).status,'expired');
  assert.equal((await store.getBridgeCommand(created.requestId))?.status,'queued');
  now(120_001);
  assert.equal((await service.bridgeCommandStatus(owner,created.requestId)).status,'expired');
});

test('claimed commands also expire but cannot be reclaimed or completed',async()=>{
  const f=await fixture();
  const issued=await f.issue();
  const claimed=await f.service.claimBridgeModeCommand(f.credential,issued.requestId);
  assert.ok(claimed);
  assert.equal((await f.service.bridgeCommandStatus(f.owner,issued.requestId)).status,'claimed');
  f.now(120_000);
  assert.equal((await f.service.bridgeCommandStatus(f.owner,issued.requestId)).status,'expired');
  assert.equal(await f.service.claimBridgeModeCommand(f.credential,issued.requestId),null);
  assert.equal((await f.store.getBridgeCommand(issued.requestId))?.status,'claimed');
});

test('final applied or failed results remain auditable after timeout',async()=>{
  for(const result of ['applied','failed'] as const){
    const f=await fixture();
    const issued=await f.issue();
    const claimed=await f.service.claimBridgeModeCommand(f.credential,issued.requestId);
    assert.ok(claimed);
    const receipt={
      type:'admin-bridge.mode-receipt' as const,version:1 as const,
      requestId:issued.requestId,deviceId:f.deviceId,
      credentialBinding:claimed.credentialBinding,
      desiredMode:'on' as const,observedAt:'2026-10-10T15:00:30.000Z',
      result,
      taskState:result==='applied'?'Running' as const:'Unknown' as const,
      taskVerified:result==='applied',
      brokerHealth:result==='applied'?'authenticated-ready' as const:'unverified' as const,
      failureCode:result==='failed'?'BROKER_NOT_READY':null,
    };
    f.now(31_000);
    const signedReceipt=signGuardianModeReceipt({
      type:'guardian.signed-bridge-receipt',version:1,
      intent:claimed,receipt,
      preferenceRevision:f.preferenceRevision,
      keyId:guardianPublicKeyId(f.keys.publicKey),
    },f.keys.privateKey);
    const accepted=await f.service.completeSignedBridgeModeCommand(
      f.credential,signedReceipt,async()=>f.keys.publicKey,
    );
    assert.equal(accepted.status,result);
    f.now(200_000);
    assert.equal((await f.service.bridgeCommandStatus(f.owner,issued.requestId)).status,result);
  }
});
