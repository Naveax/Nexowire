import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {
  hubCommandPublicKeyId,signGuardianHubCommand,
  verifyAndReserveGuardianHubCommand,
} from '../src/protocol/guardian-hub-signed-command.js';
import {
  guardianPublicKeyId,signGuardianModeReceipt,
} from '../src/protocol/guardian-signed-receipt.js';
import {
  reserveVerifiedGuardianCommand,
  type BridgeGuardianTrustedFacts,
} from '../src/agent/bridge-guardian-policy.js';
import {
  measureGuardianBrokerPostcondition,
} from '../src/agent/bridge-guardian-measured-postcondition.js';

const baseline=new Date('2026-10-10T15:00:00.000Z');
const modeList=['on','off','auto'] as const;
const fakeTask=(state:'Running'|'Disabled')=>({
  installed:true,taskName:'Nexowire Privileged Broker',
  identityVerified:true,state,
});
const fakeProcess=(running:boolean,trigger=true)=>({
  complete:true,trustedCollector:true,
  brokerProcessCount:running?1:0,
  brokerListenerCount:running?1:0,listenerPort:43112,
  brokerProcessImageAndOwnerVerified:running,
  recoveryTriggerVerified:trigger,
});
const fakeHealth=()=>({
  expectedVersion:'1.0.5',version:'1.0.5',
  reachable:true,elevated:true,ready:true,status:'READY',
});

async function fixture(mode:'on'|'off'|'auto') {
  let clock=new Date(baseline);
  const hub=generateKeyPairSync('ed25519');
  const guardian=generateKeyPairSync('ed25519');
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{now:()=>clock});
  const owner={accountId:'roundtrip-owner',role:'user'} as const;
  await service.ensureAccount({id:owner.accountId});
  const pairing=await service.beginPairing(owner,'roundtrip-win32');
  const paired=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'e'.repeat(64),
  });
  const deviceId=paired.device.id;
  const credential=paired.deviceCredential;
  await service.setDeviceAccessMode(owner,deviceId,'full');
  const device=await store.getDevice(deviceId);
  assert.ok(device);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:true});
  await service.setDeviceBridgePreference(owner,deviceId,mode);
  const preference=await store.getDeviceBridgePreference(deviceId);
  assert.ok(preference);
  const issued=await service.issueBridgeModeCommand(owner,deviceId,mode);
  const claimed=await service.claimBridgeModeCommand(credential,issued.requestId);
  assert.ok(claimed);
  const reserved=new Set<string>();
  const localFacts:BridgeGuardianTrustedFacts={
    deviceId,ownerAccountId:owner.accountId,
    credentialBinding:claimed.credentialBinding,
    platform:'win32',accessMode:'full',
    currentPreference:{desiredMode:mode,revision:preference.updatedAt},
    ownerApproval:{requestId:issued.requestId,
      preferenceRevision:preference.updatedAt},
    localGuardian:{
      installed:true,online:true,
      independentlyReachableWithBrokerOff:true,
      protectedSourceVerified:true,taskIdentityVerified:true,
      elevatedLocalTokenVerified:true,hubTransportAuthenticated:true,
      currentDeviceSessionVerified:true,
    },
    broker:{
      canonicalTaskIdentityVerified:true,
      launcherAclVerified:true,
    },
    now:new Date('2026-10-10T15:00:30.000Z'),
  };

  const envelope=signGuardianHubCommand({
    type:'guardian.hub-bridge-command',version:1,
    intent:claimed,ownerPreferenceRevision:preference.updatedAt,
    guardianKeyId:guardianPublicKeyId(guardian.publicKey),
    hubSignerKeyId:hubCommandPublicKeyId(hub.publicKey),
  },hub.privateKey);

  const trustedCommand=()=>verifyAndReserveGuardianHubCommand(envelope,{
    deviceId,ownerAccountId:owner.accountId,
    credentialBinding:claimed.credentialBinding,
    currentOwnerPreferenceRevision:preference.updatedAt,
    currentGuardianKeyId:guardianPublicKeyId(guardian.publicKey),
    enrolledHubPublicKey:hub.publicKey,
    now:new Date('2026-10-10T15:00:30.000Z'),
    atomicallyReserveRequest:async(requestId,requestedDevice,binding,revision)=>{
      const verified=await reserveVerifiedGuardianCommand(
        claimed,async()=>localFacts,async(id,dev,cred,rev)=>{
          if(requestId!==id||requestedDevice!==dev||binding!==cred||revision!==rev||
             reserved.has(id))return false;
          reserved.add(id);
          return true;
        },
      );
      return verified.requestId===requestId;
    },
  });
  return {
    owner,hub,guardian,store,service,credential,deviceId,
    mode,issued,claimed,envelope,preference,localFacts,reserved,
    trustedCommand,
    advance:(ms:number)=>{clock=new Date(baseline.getTime()+ms)},
  };
}

test('ON/OFF/AUTO owner→Hub signed intent→Guardian evidence→signed receipt→owner status',async()=>{
  for(const mode of modeList) {
    const f=await fixture(mode);
    const accepted=await f.trustedCommand();
    assert.equal(accepted.authenticated,true);
    assert.equal(accepted.executionAuthorized,false);
    assert.equal(f.reserved.size,1);
    await assert.rejects(f.trustedCommand(),/BRIDGE_GUARDIAN_ALREADY_CONSUMED_OR_REVOKED/);
    f.advance(30_000);

    const measured=await measureGuardianBrokerPostcondition(f.claimed,{
      now:()=>new Date('2026-10-10T15:00:30.000Z'),
      readTask:async()=>fakeTask(mode==='off'?'Disabled':'Running'),
      readProcessAndPort:async()=>fakeProcess(mode!=='off'),
      readHealth:async()=>fakeHealth(),
    });
    assert.equal(measured.locallyMeasured,true);
    assert.equal(measured.receipt.result,'applied');

    const guardianReceipt=signGuardianModeReceipt({
      type:'guardian.signed-bridge-receipt',version:1,
      intent:f.claimed,receipt:measured.receipt,
      preferenceRevision:f.preference.updatedAt,
      keyId:guardianPublicKeyId(f.guardian.publicKey),
    },f.guardian.privateKey);

    const done=await f.service.completeSignedBridgeModeCommand(
      f.credential,guardianReceipt,async()=>f.guardian.publicKey,
    );
    assert.equal(done.status,'applied');
    assert.equal((await f.service.bridgeCommandStatus(f.owner,f.issued.requestId)).status,'applied');
    await assert.rejects(
      f.service.completeSignedBridgeModeCommand(
        f.credential,guardianReceipt,async()=>f.guardian.publicKey,
      ),/BRIDGE_COMMAND_NOT_CLAIMED/,
    );
  }
});

test('OFF with residual listening process produces signed failure, NEVER applied',async()=>{
  const f=await fixture('off');
  await f.trustedCommand();
  f.advance(30_000);
  const measured=await measureGuardianBrokerPostcondition(f.claimed,{
    now:()=>new Date('2026-10-10T15:00:30.000Z'),
    readTask:async()=>fakeTask('Disabled'),
    readProcessAndPort:async()=>({...fakeProcess(false),brokerListenerCount:1}),
    readHealth:async()=>{throw new Error('HEALTH_UNAVAILABLE')},
  });
  assert.equal(measured.receipt.result,'failed');
  assert.equal(measured.locallyMeasured,false);
  const signed=signGuardianModeReceipt({
    type:'guardian.signed-bridge-receipt',version:1,
    intent:f.claimed,receipt:measured.receipt,
    preferenceRevision:f.preference.updatedAt,
    keyId:guardianPublicKeyId(f.guardian.publicKey),
  },f.guardian.privateKey);
  const completed=await f.service.completeSignedBridgeModeCommand(
    f.credential,signed,async()=>f.guardian.publicKey,
  );
  assert.equal(completed.status,'failed');
});

test('Guardian trust facts block signed Hub commands before any replay reservation',async()=>{
  const f=await fixture('on');
  const denied={
    ...f.localFacts,
    localGuardian:{...f.localFacts.localGuardian,
      independentlyReachableWithBrokerOff:false},
  };
  await assert.rejects(verifyAndReserveGuardianHubCommand(f.envelope,{
    deviceId:f.deviceId,ownerAccountId:f.owner.accountId,
    credentialBinding:f.claimed.credentialBinding,
    currentOwnerPreferenceRevision:f.preference.updatedAt,
    currentGuardianKeyId:guardianPublicKeyId(f.guardian.publicKey),
    enrolledHubPublicKey:f.hub.publicKey,
    now:new Date('2026-10-10T15:00:30.000Z'),
    atomicallyReserveRequest:async()=> {
      await reserveVerifiedGuardianCommand(f.claimed,async()=>denied,
        async()=>{throw new Error('MUST_NOT_RESERVE')});
      return true;
    },
  }),/BRIDGE_GUARDIAN_INDEPENDENCE_OR_TRUST_UNVERIFIED/);
  assert.equal(f.reserved.size,0);
});

test('unregistered Guardian public key cannot complete an otherwise valid signed roundtrip',async()=>{
  const f=await fixture('on');
  await f.trustedCommand();
  f.advance(30_000);
  const evidence=await measureGuardianBrokerPostcondition(f.claimed,{
    now:()=>new Date('2026-10-10T15:00:30.000Z'),
    readTask:async()=>fakeTask('Running'),
    readProcessAndPort:async()=>fakeProcess(true),
    readHealth:async()=>fakeHealth(),
  });
  const signed=signGuardianModeReceipt({
    type:'guardian.signed-bridge-receipt',version:1,
    intent:f.claimed,receipt:evidence.receipt,
    preferenceRevision:f.preference.updatedAt,
    keyId:guardianPublicKeyId(f.guardian.publicKey),
  },f.guardian.privateKey);
  const revoked=generateKeyPairSync('ed25519');
  await assert.rejects(f.service.completeSignedBridgeModeCommand(
    f.credential,signed,async()=>revoked.publicKey,
  ),/GUARDIAN_RECEIPT_UNREGISTERED_KEY/);
  assert.equal((await f.service.bridgeCommandStatus(f.owner,f.issued.requestId)).status,'claimed');
});
