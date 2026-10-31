/** AI-04 source-only admission identity snapshot regressions.
 * Synthetic requests and keys do NOT prove a real OS Broker or CAS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type DispatchRevokeRequest,
  type ExternalBrokerDispatchAuthority,
} from '../src/agent/broker-external-dispatch-fence.js';

const keyPair=generateKeyPairSync('ed25519');
const publicKeyPem=keyPair.publicKey.export({type:'spki',format:'pem'}).toString();
function harness(){
  const counters={identity:0,ownerRevoke:0,begin:0,commit:0,release:0};
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(){counters.begin++;throw Error('TEST_ONLY_BLOCKED')},
    async commitIfCurrent(){counters.commit++;throw Error('TEST_ONLY_BLOCKED')},
    async release(){counters.release++},
    async revokeAndDrain(){throw Error('TEST_ONLY_BLOCKED')},
  };
  const gate=new BrokerExternalDispatchFence({
    authority,authorityId:randomUUID(),publicKeyPem,
    verifyIdentity:async()=>{counters.identity++;return false},
    verifyEffectiveBroker:async()=>{throw Error('NO_PROTECTED_OS_READBACK')},
    verifyOwnerRevocation:async()=>{counters.ownerRevoke++;return false},
  });
  const deviceId=randomUUID(),ownerId=randomUUID(),
    deviceEpoch=randomUUID(),sessionEpoch=randomUUID();
  const op=():BrokerDispatchRequest=>({
    requestId:randomUUID(),fingerprint:'a'.repeat(64),capability:'shell.exec',
    scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch:2,
      expectedGeneration:3,requiredPrivilege:'CORE'},
  });
  const revoke=():DispatchRevokeRequest=>({
    ownerId,deviceId,deviceEpoch,sessionEpoch,expectedGeneration:3,
    signedOwnerApproval:'synthetic_source_only_owner_signature_0123456789',
  });
  return {gate,counters,op,revoke};
}
const expectNoEffect=async(raw:BrokerDispatchRequest,
  expected:'DISPATCH_REQUEST_INVALID'|'DISPATCH_IDENTITY_UNVERIFIED')=>{
  const f=harness();let effects=0;
  await assert.rejects(f.gate.execute(raw,async()=>++effects),{code:expected});
  assert.equal(effects,0);
  assert.equal(f.counters.begin,0);
  assert.equal(f.counters.commit,0);
  assert.equal(f.counters.release,0);
  assert.equal(f.counters.identity,expected==='DISPATCH_IDENTITY_UNVERIFIED'?1:0);
};

test('AI-04 plain frozen dispatch scope reaches (deny-only) independent identity gate',async()=>{
  const f=harness();
  await expectNoEffect(f.op(),'DISPATCH_IDENTITY_UNVERIFIED');
});
test('AI-04 reject top-level getter without reading caller property',async()=>{
  const f=harness(),raw=f.op();let reads=0;
  Object.defineProperty(raw,'requestId',{enumerable:true,
    get(){reads++;return randomUUID()}});
  await expectNoEffect(raw,'DISPATCH_REQUEST_INVALID');
  assert.equal(reads,0);
});
test('AI-04 reject nested session scope getter without ABA',async()=>{
  const f=harness(),raw=f.op();let reads=0;
  Object.defineProperty(raw.scope,'sessionEpoch',{enumerable:true,
    get(){reads++;return randomUUID()}});
  await expectNoEffect(raw,'DISPATCH_REQUEST_INVALID');
  assert.equal(reads,0);
});
for(const stage of ['root','scope'] as const){
  test('AI-04 reject '+stage+' Proxy before its reflective traps',async()=>{
    const f=harness(),raw=f.op();let traps=0;
    const attack=<T extends object>(target:T)=>new Proxy(target,{
      ownKeys(){traps++;throw Error('MALICIOUS_PROXY_REFLECTION')},
      get(){traps++;throw Error('MALICIOUS_PROXY_GET')},
    });
    const input=stage==='root'?attack(raw):{...raw,scope:attack(raw.scope)};
    await expectNoEffect(input,'DISPATCH_REQUEST_INVALID');
    assert.equal(traps,0,'Proxy rejection should precede JS reflection');
  });
  test('AI-04 reject inherited '+stage+' input fields',async()=>{
    const f=harness(),raw=f.op();
    const input=stage==='root'
      ?Object.create(raw) as BrokerDispatchRequest
      :{...raw,scope:Object.create(raw.scope) as BrokerDispatchRequest['scope']};
    await expectNoEffect(input,'DISPATCH_REQUEST_INVALID');
  });
}
test('AI-04 reject non-enumerable nested owner scope extension',async()=>{
  const f=harness(),raw=f.op();
  Object.defineProperty(raw.scope,'hidden',{value:1,enumerable:false});
  await expectNoEffect(raw,'DISPATCH_REQUEST_INVALID');
});
test('AI-04 reject symbol nested owner scope extension',async()=>{
  const f=harness(),raw=f.op();
  Object.assign(raw.scope,{[Symbol('forged-scope')]:true});
  await expectNoEffect(raw,'DISPATCH_REQUEST_INVALID');
});
test('AI-04 plain revoke reaches deny-only signed owner verifier',async()=>{
  const f=harness();
  await assert.rejects(f.gate.revoke(f.revoke()),
    {code:'DISPATCH_REVOKE_SIGNATURE_UNTRUSTED'});
  assert.equal(f.counters.ownerRevoke,1);
  assert.equal(f.counters.begin,0);
});
test('AI-04 reject revoke approval getter before invoking owner verifier',async()=>{
  const f=harness(),raw=f.revoke();let reads=0;
  Object.defineProperty(raw,'signedOwnerApproval',{enumerable:true,
    get(){reads++;return 'MALICIOUS_OWNER_SIGNATURE'}});
  await assert.rejects(f.gate.revoke(raw),{code:'DISPATCH_REVOKE_INVALID'});
  assert.equal(reads,0);
  assert.equal(f.counters.ownerRevoke,0);
});
test('AI-04 reject revoked owner-scope Proxy without running traps',async()=>{
  const f=harness();let traps=0;
  const raw=new Proxy(f.revoke(),{
    ownKeys(){traps++;throw Error('REVOKE_TRAP')},
  });
  await assert.rejects(f.gate.revoke(raw),{code:'DISPATCH_REVOKE_INVALID'});
  assert.equal(traps,0);
  assert.equal(f.counters.ownerRevoke,0);
});
