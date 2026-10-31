/** AI-04: synthetic remote CAS and identity witnesses are NOT physical OS proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type ProtectedBrokerEvidence,
  type DispatchClaim,type ExternalBrokerDispatchAuthority,
} from '../src/agent/broker-external-dispatch-fence.js';

const keys=generateKeyPairSync('ed25519');
const pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
function fixture(opts?:{invalidateAt?:'begin'|'commit';throwAt?:number}){
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const scope={ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:4,
    expectedGeneration:7,requiredPrivilege:'CORE' as const};
  const request:BrokerDispatchRequest={requestId:randomUUID(),
    fingerprint:'e'.repeat(64),capability:'shell.exec',scope};
  const broker:ProtectedBrokerEvidence={verified:true,brokerId,
    ownerEpoch:4,grantGeneration:7,highIntegrityToken:true,
    signedProtectedImage:true,protectedParentAndImports:true};
  const calls={identity:0,begin:0,commit:0,release:0,readback:0};
  let current=true;
  function receipt(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    nonce:string):DispatchClaim{
    const now=Date.now();
    const bytes=Buffer.from(JSON.stringify({kind,authorityId,brokerId,
      dispatchId,challengeNonce:nonce,requestId:request.requestId,
      fingerprint:request.fingerprint,capability:request.capability,
      ownerId:scope.ownerId,deviceId:scope.deviceId,
      deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
      ownerEpoch:scope.ownerEpoch,generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+3000}));
    return {payload:bytes.toString('base64url'),
      signature:sign(null,bytes,keys.privateKey).toString('base64url')};
  }
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(_req,_broker,nonce){
      calls.begin++;
      if(opts?.invalidateAt==='begin')current=false;
      return receipt('broker_dispatch_permit_v1',nonce);
    },
    async commitIfCurrent(_req,_broker,_id,nonce){
      calls.commit++;
      if(opts?.invalidateAt==='commit')current=false;
      return receipt('broker_dispatch_commit_v1',nonce);
    },
    async release({brokerId:id,dispatchId:d,request:op}){
      calls.release++;
      assert.equal(id,brokerId);
      assert.equal(d,dispatchId);
      assert.equal(op.requestId,request.requestId);
    },
    async revokeAndDrain(){throw Error('NO_REAL_REVOCATION_PROVIDER')},
  };
  const gate=new BrokerExternalDispatchFence({authority,authorityId,
    publicKeyPem:pem,
    verifyIdentity:async()=>{
      calls.identity++;
      if(calls.identity===opts?.throwAt)throw Error('AUTHORITY_UNREACHABLE');
      return current;
    },
    verifyEffectiveBroker:async()=>{calls.readback++;return {...broker}},
    verifyOwnerRevocation:async()=>false});
  return {request,gate,calls};
}
test('AI-04 stable owner/device/session is rechecked after both CAS waits',async()=>{
  const f=fixture();let callbacks=0;
  assert.equal(await f.gate.execute(f.request,async()=>++callbacks),1);
  assert.equal(callbacks,1);
  assert.deepEqual(f.calls,{identity:3,begin:1,commit:1,release:1,readback:3});
});
test('AI-04 owner/session revocation during reserve denies remote commit',async()=>{
  const f=fixture({invalidateAt:'begin'});let callbacks=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++callbacks),
    {code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(callbacks,0);
  assert.deepEqual(f.calls,{identity:2,begin:1,commit:0,release:1,readback:2});
  await assert.rejects(f.gate.execute(f.request,async()=>++callbacks),
    {code:'DISPATCH_REVOKE_PENDING'});
});
test('AI-04 owner/session loss during commit blocks signed native effect',async()=>{
  const f=fixture({invalidateAt:'commit'});let callbacks=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++callbacks),
    {code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(callbacks,0);
  assert.deepEqual(f.calls,{identity:3,begin:1,commit:1,release:1,readback:2});
});
test('AI-04 identity UNKNOWN after commit denies effect and releases claim',async()=>{
  const f=fixture({throwAt:3});let callbacks=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++callbacks),
    {code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(callbacks,0);
  assert.deepEqual(f.calls,{identity:3,begin:1,commit:1,release:1,readback:2});
});
test('AI-04 identity UNKNOWN after reserve never advances to commit',async()=>{
  const f=fixture({throwAt:2});let callbacks=0;
  await assert.rejects(f.gate.execute(f.request,async()=>++callbacks),
    {code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(callbacks,0);
  assert.deepEqual(f.calls,{identity:2,begin:1,commit:0,release:1,readback:2});
});
