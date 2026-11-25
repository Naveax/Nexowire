import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {createScopedDispatchBrokerResolver,ProtectedDispatchWorkGate,startProtectedBrokerDispatchService,type ProtectedDispatchCredentialRecord,type ProtectedBrokerDispatchServiceOptions}
  from '../../src/agent/protected-broker-dispatch-service.js';

const credential='a'.repeat(48),other='b'.repeat(48);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function active():ProtectedDispatchCredentialRecord{
  return {credentialSha256:digest(credential),certificateSha256:digest('peer'),
    brokerId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),
    installationId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
    state:'ACTIVE',notBeforeMs:Date.now()-1000,expiresAtMs:Date.now()+60000};
}

test('dispatch credentials require actual matching TLS peer and current installation binding',async()=>{
  const current=active();let lookups=0,checks=0;
  const resolver=createScopedDispatchBrokerResolver({
    async lookup(key){lookups++;assert.equal(key,digest(credential));return current},
    async verifyLiveBinding(value){checks++;assert.equal(value.installationId,current.installationId);
      assert.ok(Object.isFrozen(value));return true},
  });
  assert.equal(await resolver(credential),undefined);
  assert.equal(lookups,0);
  assert.equal(await resolver(credential,{certificateSha256:digest('other')}),undefined);
  assert.equal(checks,0);
  const accepted=await resolver(credential,{certificateSha256:current.certificateSha256});
  assert.deepEqual(accepted,{brokerId:current.brokerId,ownerId:current.ownerId,
    deviceId:current.deviceId,deviceEpoch:current.deviceEpoch,sessionEpoch:current.sessionEpoch});
  assert.ok(Object.isFrozen(accepted));
  assert.equal(checks,1);
});

test('dispatch credential revocation, expiry, wrong digest and unavailable verification fail closed',async()=>{
  const current=active();let value:unknown=current,valid=true,broken=false;
  const resolver=createScopedDispatchBrokerResolver({
    async lookup(){if(broken)throw Error('unavailable');return value},
    async verifyLiveBinding(){return valid},
  });
  const peer={certificateSha256:current.certificateSha256};
  assert.equal(await resolver(other,peer),undefined);
  value={...current,state:'REVOKED'};assert.equal(await resolver(credential,peer),undefined);
  value={...current,notBeforeMs:Date.now()+10000};assert.equal(await resolver(credential,peer),undefined);
  value={...current,expiresAtMs:Date.now()-1};assert.equal(await resolver(credential,peer),undefined);
  value=current;valid=false;assert.equal(await resolver(credential,peer),undefined);
  valid=true;broken=true;assert.equal(await resolver(credential,peer),undefined);
  broken=false;assert.ok(await resolver(credential,peer));
  value=undefined;assert.equal(await resolver(credential,peer),undefined);
});

test('dispatch credential resolver snapshots identity before asynchronous native binding verification',async()=>{
  const current={...active()},owner=current.ownerId;
  const resolver=createScopedDispatchBrokerResolver({
    async lookup(){return current},
    async verifyLiveBinding(record){
      current.ownerId=randomUUID();
      assert.equal(record.ownerId,owner);
      return true;
    },
  });
  assert.equal((await resolver(credential,{certificateSha256:current.certificateSha256}))?.ownerId,owner);
});

test('shutdown fence tracks authority promises after HTTP close and never reopens after timeout',async()=>{
  const gate=new ProtectedDispatchWorkGate(1);
  let finish!:()=>void,entered=false;
  const held=new Promise<void>(resolve=>{finish=resolve;});
  const running=gate.run(async()=>{entered=true;await held;});
  await Promise.resolve();assert.equal(entered,true);
  await assert.rejects(gate.run(async()=>assert.fail('capacity bypass')),/ADMISSION_CLOSED/);
  await assert.rejects(gate.drain(5),/SHUTDOWN_UNKNOWN/);
  await assert.rejects(gate.run(async()=>assert.fail('shutdown bypass')),/ADMISSION_CLOSED/);
  finish();await running;await gate.drain(100);
  await assert.rejects(gate.run(async()=>assert.fail('reopen bypass')),/ADMISSION_CLOSED/);
});
test('protected dispatch startup rejects missing completion policy before any listener or DB connection',async()=>{
  const c={host:'127.0.0.1',port:0,authorityId:randomUUID(),
    verifyProvenance:async()=>assert.fail('unexpected provenance call'),
    readProtectedBroker:async()=>assert.fail('unexpected Broker call'),
    verifyOwnerRevocation:async()=>assert.fail('unexpected approval call'),
    verifyNativeDrain:async()=>assert.fail('unexpected drain call')} as unknown as ProtectedBrokerDispatchServiceOptions;
  await assert.rejects(startProtectedBrokerDispatchService(c),/DISPATCH_SERVICE_CONFIGURATION_REQUIRED/);
});

test('protected startup denies shared dispatch and native observer signing identity before opening database',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const config={
    host:'127.0.0.1',port:0,authorityId:randomUUID(),
    privateKeyPem:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    nativeCompletion:{observerPublicKeyPem:pair.publicKey.export({format:'pem',type:'spki'}).toString(),
      evidenceByCapability:{'fixture.process':'JOB_OBJECT_EMPTY'}},
    tls:{},credentials:{lookup:async()=>assert.fail('unexpected credential lookup'),
      verifyLiveBinding:async()=>assert.fail('unexpected binding read')},
    verifyProvenance:async()=>assert.fail('unexpected DB provenance check'),
    readProtectedBroker:async()=>assert.fail('unexpected Broker read'),
    verifyOwnerRevocation:async()=>assert.fail('unexpected owner approval'),
    verifyNativeDrain:async()=>assert.fail('unexpected drain'),
    readNativeDrainProof:async()=>assert.fail('unexpected native observer'),
  } as unknown as ProtectedBrokerDispatchServiceOptions;
  await assert.rejects(startProtectedBrokerDispatchService(config),/DISPATCH_SERVICE_OBSERVER_KEY_NOT_INDEPENDENT/);
});
