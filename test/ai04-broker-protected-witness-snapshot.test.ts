/** AI-04 source-only Broker witness tests. The synthetic receipt authority
 * is NOT a production CAS, nor does it certify a real Windows HIGH token. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type DispatchClaim,
  type ProtectedBrokerEvidence,type ExternalBrokerDispatchAuthority,
} from '../src/agent/broker-external-dispatch-fence.js';

const keys=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const signature=(obj:unknown):DispatchClaim=>{
  const bytes=Buffer.from(JSON.stringify(obj));
  return {payload:bytes.toString('base64url'),
    signature:sign(null,bytes,keys.privateKey).toString('base64url')};
};
function fixture(){
  const authorityId=randomUUID(),brokerId=randomUUID();
  const ownerId=randomUUID(),deviceId=randomUUID();
  const deviceEpoch=randomUUID(),sessionEpoch=randomUUID();
  const request:BrokerDispatchRequest={
    requestId:randomUUID(),fingerprint:'c'.repeat(64),capability:'shell.exec',
    scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch:4,
      expectedGeneration:7,requiredPrivilege:'CORE'},
  };
  const raw:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true,
  };
  let beginCalls=0,commitCalls=0,releaseCalls=0;
  const dispatchId=randomUUID();
  let onBegin:((b:ProtectedBrokerEvidence)=>void)|undefined;
  let onCommit:((b:ProtectedBrokerEvidence)=>void)|undefined;
  const receipt=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    b:ProtectedBrokerEvidence,nonce:string):DispatchClaim=>{
    const now=Date.now();
    return signature({kind,authorityId,brokerId:b.brokerId,dispatchId,
      challengeNonce:nonce,requestId:request.requestId,
      fingerprint:request.fingerprint,capability:request.capability,
      ownerId,deviceId,deviceEpoch,sessionEpoch,ownerEpoch:4,
      generation:7,privilege:'CORE',issuedAtMs:now,expiresAtMs:now+2000});
  };
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(req,b,nonce){
      beginCalls++;
      assert.equal(req.requestId,request.requestId);
      assert.equal(b.brokerId,brokerId);
      assert.ok(Object.isFrozen(b),'remote CAS must receive immutable evidence');
      onBegin?.(b);
      return receipt('broker_dispatch_permit_v1',b,nonce);
    },
    async commitIfCurrent(req,b,id,nonce){
      commitCalls++;
      assert.equal(req.requestId,request.requestId);
      assert.equal(id,dispatchId);
      assert.equal(b.brokerId,brokerId);
      assert.ok(Object.isFrozen(b));
      onCommit?.(b);
      return receipt('broker_dispatch_commit_v1',b,nonce);
    },
    async release(value){
      releaseCalls++;
      assert.equal(value.dispatchId,dispatchId);
      assert.equal(value.brokerId,brokerId);
    },
    async revokeAndDrain(){throw new Error('SOURCE_FIXTURE_NO_REVOKE');},
  };
  let read=async():Promise<ProtectedBrokerEvidence>=>raw;
  const gate=new BrokerExternalDispatchFence({
    authority,authorityId,publicKeyPem,
    verifyIdentity:async()=>true,
    verifyEffectiveBroker:async()=>read(),
    verifyOwnerRevocation:async()=>false,
  });
  return {
    raw,brokerId,request,gate,
    setRead:(fn:()=>Promise<ProtectedBrokerEvidence>)=>{read=fn},
    setBegin:(fn:(b:ProtectedBrokerEvidence)=>void)=>{onBegin=fn},
    setCommit:(fn:(b:ProtectedBrokerEvidence)=>void)=>{onCommit=fn},
    counts:()=>({beginCalls,commitCalls,releaseCalls}),
  };
}

test('AI-04 detached HIGH witness cannot be changed by async CAS while approving an effect',async()=>{
  const f=fixture();
  const raw=f.raw as {brokerId:string;ownerEpoch:number};
  f.setBegin(b=>{
    assert.notStrictEqual(b,raw);
    assert.equal(Reflect.set(b,'brokerId',randomUUID()),false);
    raw.brokerId=randomUUID(); raw.ownerEpoch=99;
    assert.equal(b.brokerId,f.brokerId);
    assert.equal(b.ownerEpoch,4);
    raw.brokerId=f.brokerId; raw.ownerEpoch=4;
  });
  f.setCommit(b=>{
    raw.brokerId=randomUUID();
    assert.equal(b.brokerId,f.brokerId);
    raw.brokerId=f.brokerId;
  });
  let effects=0;
  assert.equal(await f.gate.execute(f.request,async()=>++effects),1);
  assert.equal(effects,1);
  assert.deepEqual(f.counts(),{beginCalls:1,commitCalls:1,releaseCalls:1});
});

for(const key of ['brokerId','ownerEpoch','highIntegrityToken',
  'protectedParentAndImports'] as const){
  test('AI-04 deny accessor/native witness ABA for '+key,async()=>{
    const f=fixture(),witness={...f.raw};
    let reads=0;
    Object.defineProperty(witness,key,{
      enumerable:true,configurable:true,
      get(){reads++;return f.raw[key]},
    });
    f.setRead(async()=>witness);
    let effects=0;
    await assert.rejects(
      f.gate.execute(f.request,async()=>++effects),
      {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
    assert.equal(reads,0,'do not evaluate a security getter');
    assert.equal(effects,0);
    assert.deepEqual(f.counts(),{beginCalls:0,commitCalls:0,releaseCalls:0});
  });
}
for(const stage of ['recent','afterCommit'] as const){
  test('AI-04 deny accessor witness after remote '+stage,async()=>{
    const f=fixture(),raw={...f.raw};
    Object.defineProperty(raw,'brokerId',{enumerable:true,
      get(){return f.brokerId}});
    let reads=0;
    f.setRead(async()=>{reads++;return reads===(stage==='recent'?2:3)
      ?raw:f.raw});
    let effects=0;
    await assert.rejects(f.gate.execute(f.request,async()=>++effects),
      {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
    assert.equal(effects,0);
    assert.equal(f.counts().beginCalls,1);
    assert.equal(f.counts().commitCalls,stage==='recent'?0:1);
  });
}
test('AI-04 deny throwing proxy witness without CAS or callback',async()=>{
  const f=fixture();
  const proxy=new Proxy(f.raw,{ownKeys(){throw Error('MALICIOUS_DESCRIPTOR_TRAP')}});
  f.setRead(async()=>proxy);
  let effects=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++effects),
    {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
  assert.equal(effects,0);
  assert.equal(f.counts().beginCalls,0);
});
test('AI-04 deny inherited Broker evidence instead of accepting its getters',async()=>{
  const f=fixture(),derived=Object.create(f.raw) as ProtectedBrokerEvidence;
  f.setRead(async()=>derived);
  let effects=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++effects),
    {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
  assert.equal(effects,0);
  assert.equal(f.counts().beginCalls,0);
});
