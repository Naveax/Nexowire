/**
 * #10 independent, test-only adversarial cases for #926.
 * Cryptographic signatures are real; CAS and clocks are fixtures, not host proof.
 * No ports, OS privileges, devices, or production source are touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {
 BrokerExternalDispatchFence, type BrokerDispatchRequest,
 type DispatchClaim, type DispatchRevokeRequest,
 type ExternalBrokerDispatchAuthority, type DispatchReleaseRequest,
 type ProtectedBrokerEvidence,
} from '../src/agent/broker-external-dispatch-fence.js';

function deferred() {
 let resolve!:()=>void;
 const promise=new Promise<void>(r=>{resolve=r});
 return {promise,resolve};
}
function harness() {
 const signer=generateKeyPairSync('ed25519');
 const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
 const request:BrokerDispatchRequest={
  requestId:randomUUID(),fingerprint:'a'.repeat(64),capability:'shell.exec',
  scope:{ownerId:randomUUID(),deviceId:randomUUID(),
   deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
   ownerEpoch:2,expectedGeneration:4,requiredPrivilege:'CORE'},
 };
 const revoke:DispatchRevokeRequest={
  deviceId:request.scope.deviceId,ownerId:request.scope.ownerId,
  deviceEpoch:request.scope.deviceEpoch,sessionEpoch:request.scope.sessionEpoch,
  expectedGeneration:4,signedOwnerApproval:'fixture-only-approval-'.repeat(3),
 };
 const state={
  wall:Date.now(),mono:1_000_000_000n,
  beginCalls:0,commitCalls:0,releaseCalls:0,revokeCalls:0,effects:0,
  beginLost:false,commitLost:false,releaseLost:false,replayRevoke:false,
  afterBegin:undefined as (()=>void)|undefined,
  afterCommit:undefined as (()=>void)|undefined,
  beginHold:undefined as ReturnType<typeof deferred>|undefined,
  oldRevocation:undefined as DispatchClaim|undefined,
  reserved:false,committed:false,revoked:false,
  tombstones:new Set<string>(),
 };
 const claim=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
   nonce:string,broker:ProtectedBrokerEvidence):DispatchClaim=>{
  const scope=request.scope;
  const bytes=Buffer.from(JSON.stringify({
   kind,authorityId,brokerId:broker.brokerId,dispatchId,
   challengeNonce:nonce,requestId:request.requestId,
   fingerprint:request.fingerprint,capability:request.capability,
   ownerId:scope.ownerId,deviceId:scope.deviceId,
   deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
   ownerEpoch:scope.ownerEpoch,generation:scope.expectedGeneration,
   privilege:scope.requiredPrivilege,issuedAtMs:state.wall,
   expiresAtMs:state.wall+2500,
  }));
  return {payload:bytes.toString('base64url'),
   signature:sign(null,bytes,signer.privateKey).toString('base64url')};
 };
 const signRevoke=(r:DispatchRevokeRequest,nonce:string)=>{
  const bytes=Buffer.from(JSON.stringify({
   kind:'broker_dispatch_revocation_v1',authorityId,
   deviceId:r.deviceId,ownerId:r.ownerId,
   deviceEpoch:r.deviceEpoch,sessionEpoch:r.sessionEpoch,
   challengeNonce:nonce,previousGeneration:r.expectedGeneration,
   generation:r.expectedGeneration+1,drained:true,revoked:true,
  }));
  return {payload:bytes.toString('base64url'),
   signature:sign(null,bytes,signer.privateKey).toString('base64url')};
 };
 const remote:ExternalBrokerDispatchAuthority={
  async beginIfCurrent(r,broker,nonce){
   state.beginCalls++;
   if(state.revoked||state.tombstones.has(r.requestId))
    throw Error('DURABLE_REQUEST_TOMBSTONE');
   state.tombstones.add(r.requestId);
   state.reserved=true;
   if(state.beginHold)await state.beginHold.promise;
   if(state.beginLost)throw Error('BEGIN_ACK_LOST_AFTER_RESERVATION');
   const proof=claim('broker_dispatch_permit_v1',nonce,broker);
   state.afterBegin?.();
   return proof;
  },
  async commitIfCurrent(r,broker,id,nonce){
   state.commitCalls++;
   if(!state.reserved||state.revoked||id!==dispatchId||
      r.requestId!==request.requestId)throw Error('COMMIT_REFUSED');
   state.committed=true;
   if(state.commitLost)throw Error('COMMIT_ACK_LOST_AFTER_ADMISSION');
   const proof=claim('broker_dispatch_commit_v1',nonce,broker);
   state.afterCommit?.();
   return proof;
  },
  async release(r:DispatchReleaseRequest){
   state.releaseCalls++;
   assert.equal(r.dispatchId,dispatchId);
   assert.equal(r.brokerId,brokerId);
   assert.deepEqual(r.request,request);
   state.reserved=false;
   if(state.releaseLost)throw Error('RELEASE_ACK_LOST_AFTER_EFFECT');
  },
  async revokeAndDrain(r,nonce){
   state.revokeCalls++;
   if(state.replayRevoke&&state.oldRevocation)return state.oldRevocation;
   if(state.revoked||state.reserved)throw Error('CANNOT_DRAIN');
   state.revoked=true;
   return state.oldRevocation=signRevoke(r,nonce);
  },
 };
 const fence=()=>new BrokerExternalDispatchFence({
  authority:remote,authorityId,
  publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
  now:()=>state.wall,monotonicNowNs:()=>state.mono,
  verifyIdentity:async()=>true,
  verifyEffectiveBroker:async()=>({
   verified:true,brokerId,highIntegrityToken:true,
   signedProtectedImage:true,protectedParentAndImports:true,
   ownerEpoch:2,grantGeneration:4,
  }),
  verifyOwnerRevocation:async()=>true,
 });
 const effect=async()=>{state.effects++;return 'OS_EFFECT'};
 return {state,fence,request,revoke,effect};
}

test('frozen wall + monotonic expired begin rejects callback before commit',async()=>{
 const h=harness();h.state.afterBegin=()=>{h.state.mono+=3_000_000_000n};
 const gate=h.fence();
 await assert.rejects(gate.execute(h.request,h.effect),{code:'DISPATCH_PROOF_EXPIRED'});
 assert.equal(h.state.commitCalls,0);
 assert.equal(h.state.effects,0);
 assert.equal(h.state.releaseCalls,1);
 await assert.rejects(gate.execute(h.request,h.effect),{code:'DISPATCH_REVOKE_PENDING'});
});
test('frozen wall + monotonic expired commit rejects callback after commit',async()=>{
 const h=harness();h.state.afterCommit=()=>{h.state.mono+=3_000_000_000n};
 await assert.rejects(h.fence().execute(h.request,h.effect),{code:'DISPATCH_PROOF_EXPIRED'});
 assert.equal(h.state.commitCalls,1);
 assert.equal(h.state.effects,0);
 assert.equal(h.state.releaseCalls,1);
});
test('backwards monotonic clock after begin is irreversibly fail closed',async()=>{
 const h=harness();h.state.afterBegin=()=>{h.state.mono-=1n};
 const gate=h.fence();
 await assert.rejects(gate.execute(h.request,h.effect),{code:'DISPATCH_CLOCK_UNTRUSTED'});
 assert.equal(h.state.commitCalls,0);
 assert.equal(h.state.effects,0);
 await assert.rejects(gate.execute(h.request,h.effect),{code:'DISPATCH_REVOKE_PENDING'});
});
test('backwards wall clock after commit rejects before OS callback',async()=>{
 const h=harness();h.state.afterCommit=()=>{h.state.wall-=1};
 await assert.rejects(h.fence().execute(h.request,h.effect),{code:'DISPATCH_CLOCK_UNTRUSTED'});
 assert.equal(h.state.commitCalls,1);
 assert.equal(h.state.effects,0);
});
test('duplicate request while begin pending and after release cannot replay',async()=>{
 const h=harness(),hold=deferred();h.state.beginHold=hold;
 const gate=h.fence();const pending=gate.execute(h.request,h.effect);
 const result=pending.catch(e=>e);
 for(let i=0;i<100&&h.state.beginCalls===0;i++)await Promise.resolve();
 assert.equal(h.state.beginCalls,1);
 await assert.rejects(gate.execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 hold.resolve();
 assert.equal(await result,'OS_EFFECT');
 assert.equal(h.state.effects,1);
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(h.state.effects,1);
});
test('lost begin ACK leaves durable fixture tombstone and zero callbacks',async()=>{
 const h=harness();h.state.beginLost=true;
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(h.state.effects,0);assert.equal(h.state.commitCalls,0);
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(h.state.beginCalls,2);assert.equal(h.state.effects,0);
});
test('lost commit ACK after admission cannot execute or replay callback',async()=>{
 const h=harness();h.state.commitLost=true;
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_COMMIT_UNKNOWN'});
 assert.equal(h.state.commitCalls,1);assert.equal(h.state.effects,0);
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(h.state.effects,0);
});
test('release ACK lost AFTER effect keeps exactly one callback, never replays',async()=>{
 const h=harness();h.state.releaseLost=true;
 const gate=h.fence();
 assert.equal(await gate.execute(h.request,h.effect),'OS_EFFECT');
 assert.equal(h.state.effects,1,'completed callback must not be erased by lost release ACK');
 assert.equal(h.state.releaseCalls,1);
 await assert.rejects(gate.execute(h.request,h.effect),
  {code:'DISPATCH_REVOKE_PENDING'});
 await assert.rejects(h.fence().execute(h.request,h.effect),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(h.state.effects,1,'never repeat already executed effect');
});
test('old signed revoke receipt with stale nonce cannot count as new revoke',async()=>{
 const h=harness();const gateA=h.fence();
 assert.equal((await gateA.revoke(h.revoke)).revoked,true);
 h.state.replayRevoke=true;
 const gateB=h.fence();
 await assert.rejects(gateB.revoke(h.revoke),
  {code:'DISPATCH_REVOKE_PROOF_MISMATCH'});
 await assert.rejects(gateB.execute(h.request,h.effect),
  {code:'DISPATCH_REVOKE_PENDING'});
 assert.equal(h.state.revokeCalls,2);
 assert.equal(h.state.effects,0);
});
