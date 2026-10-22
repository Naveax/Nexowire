/**
 * Independent #18 source QA for the missing FINAL native-effect boundary.
 *
 * #731 intentionally demonstrated that a delayed valid signed permit from
 * Hub A can enter its callback AFTER Hub B begins revokeAndDrain. This test
 * injects an explicitly TEST-ONLY atomically checked final native boundary
 * INSIDE that callback. It is not implemented by #712 or #741.
 *
 * A PASS here means only that a correctly placed final external fence in
 * this synthetic execution model blocks the native effect. No real Broker,
 * physical monotonic authority, CAS deployment, UAC, VM or live DB is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {
 BrokerExternalDispatchFence,
 type BrokerDispatchRequest,type DispatchRevokeRequest,
 type DispatchClaim,type ExternalBrokerDispatchAuthority,
 type ProtectedBrokerEvidence,
} from '../src/agent/broker-external-dispatch-fence.js';
import {signedOperatorGrantVerifier}
 from '../src/agent/witness-signed-provenance.js';

function latch(){
 let open!:()=>void;
 const promise=new Promise<void>(resolve=>open=resolve);
 return {promise,open};
}
function signed(payload:unknown,key:KeyObject):DispatchClaim{
 const bytes=Buffer.from(JSON.stringify(payload));
 return {payload:bytes.toString('base64url'),
  signature:sign(null,bytes,key).toString('base64url')};
}

test('#18 final-boundary barrier: Hub A permit after Hub B revoke-start must NOT reach synthetic native effect without fresh atomic CAS',async()=>{
 const ids={authorityId:randomUUID(),brokerId:randomUUID(),
  ownerId:randomUUID(),deviceId:randomUUID(),
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
 const ownerEpoch=12,grantGeneration=31;
 const signer=generateKeyPairSync('ed25519'),
  owner=generateKeyPairSync('ed25519');
 const reserved=latch(),delivered=latch(),
  revokeStarted=latch(),drained=latch();
 let revoking=false,revoked=false,backendGeneration=grantGeneration,
  finalAuthorityChecks=0,nativeEffects=0,gateCallbackEntrances=0,releases=0;
 const active=new Set<string>();
 const operation:BrokerDispatchRequest={
  requestId:randomUUID(),fingerprint:'a'.repeat(64),
  capability:'system.change',
  scope:{ownerId:ids.ownerId,deviceId:ids.deviceId,
   deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
   ownerEpoch,expectedGeneration:grantGeneration,requiredPrivilege:'CORE'},
 };
 const remote:ExternalBrokerDispatchAuthority={
  async beginIfCurrent(request:BrokerDispatchRequest,
    evidence:ProtectedBrokerEvidence,nonce:string):Promise<DispatchClaim>{
   const s=request.scope;
   if(revoking||revoked||s.ownerId!==ids.ownerId||
      s.deviceId!==ids.deviceId||s.deviceEpoch!==ids.deviceEpoch||
      s.sessionEpoch!==ids.sessionEpoch||s.ownerEpoch!==ownerEpoch||
      s.expectedGeneration!==backendGeneration)
    throw Error('SYNTHETIC_BEGIN_FENCED');
   const id=randomUUID();
   active.add(id);
   reserved.open();
   // Reserved BEFORE revoke, but signed permit response DELIVERED AFTER.
   await delivered.promise;
   const now=Date.now();
   return signed({kind:'broker_dispatch_permit_v1',
    authorityId:ids.authorityId,brokerId:evidence.brokerId,
    dispatchId:id,challengeNonce:nonce,
    requestId:request.requestId,fingerprint:request.fingerprint,
    capability:request.capability,ownerId:s.ownerId,deviceId:s.deviceId,
    deviceEpoch:s.deviceEpoch,sessionEpoch:s.sessionEpoch,
    ownerEpoch:s.ownerEpoch,generation:s.expectedGeneration,
    privilege:s.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+2000},
    signer.privateKey);
  },
  async revokeAndDrain(req:DispatchRevokeRequest):Promise<DispatchClaim>{
   if(revoking||revoked||req.ownerId!==ids.ownerId||
      req.deviceId!==ids.deviceId||req.deviceEpoch!==ids.deviceEpoch||
      req.sessionEpoch!==ids.sessionEpoch||
      req.expectedGeneration!==backendGeneration)
    throw Error('SYNTHETIC_REVOKE_STALE');
   revoking=true;
   revokeStarted.open();
   if(active.size>0)await drained.promise;
   revoked=true;
   const previousGeneration=backendGeneration++;
   return signed({kind:'broker_dispatch_revocation_v1',
    authorityId:ids.authorityId,deviceId:ids.deviceId,
    ownerId:ids.ownerId,deviceEpoch:ids.deviceEpoch,
    sessionEpoch:ids.sessionEpoch,previousGeneration,
    generation:backendGeneration,drained:true,revoked:true},
    signer.privateKey);
  },
  async release(id:string){
   releases++;
   active.delete(id);
   if(active.size===0)drained.open();
  },
 };
 const verifyOperator=signedOperatorGrantVerifier(
  owner.publicKey.export({format:'pem',type:'spki'}).toString());
 const gate=()=>new BrokerExternalDispatchFence({
  authority:remote,authorityId:ids.authorityId,
  publicKeyPem:signer.publicKey.export({format:'pem',type:'spki'}).toString(),
  verifyIdentity:async()=>true,
  // A synthetic evidence callback is NEVER a physical Windows HIGH token.
  verifyEffectiveBroker:async()=>({
   verified:true,brokerId:ids.brokerId,ownerEpoch,
   grantGeneration,highIntegrityToken:true,
   signedProtectedImage:true,protectedParentAndImports:true,
  }),
  verifyOwnerRevocation:async x=>verifyOperator({
   kind:'revoke',authorityId:ids.authorityId,
   deviceId:ids.deviceId,ownerId:ids.ownerId,
   epoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
   generation:x.expectedGeneration,
  },x.signedOwnerApproval),
 });
 const issuedAt=Date.now();
 const revoke:DispatchRevokeRequest={
  deviceId:ids.deviceId,ownerId:ids.ownerId,
  deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
  expectedGeneration:grantGeneration,
  signedOwnerApproval:JSON.stringify(signed({
   version:1,nonce:randomUUID(),
   issuedAt:issuedAt-1000,expiresAt:issuedAt+60_000,
   intent:{kind:'revoke',authorityId:ids.authorityId,
    deviceId:ids.deviceId,ownerId:ids.ownerId,
    epoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
    generation:grantGeneration},
  },owner.privateKey)),
 };

 // TEST-ONLY PROPOSED native atomic check, deliberately NOT #712 code.
 // Check and any modeled effect commit are one synchronous critical section,
 // serialized against this fixture's revoke-start transition.
 function finalAuthorityCheckThenNativeEffect(req:BrokerDispatchRequest){
  finalAuthorityChecks++;
  const s=req.scope;
  if(revoking||revoked||s.ownerId!==ids.ownerId||
     s.deviceEpoch!==ids.deviceEpoch||s.sessionEpoch!==ids.sessionEpoch||
     s.ownerEpoch!==ownerEpoch||s.expectedGeneration!==backendGeneration)
   throw Error('FINAL_ATOMIC_AUTHORITY_REVOKE_PENDING');
  nativeEffects++;
  return 'TEST_ONLY_EFFECT';
 }

 const hubA=gate(),hubB=gate();
 const late=hubA.execute(operation,async()=>{
  gateCallbackEntrances++;
  return finalAuthorityCheckThenNativeEffect(operation);
 });
 await reserved.promise;
 assert.equal(active.size,1);
 assert.equal(nativeEffects,0);
 const draining=hubB.revoke(revoke);
 await revokeStarted.promise;
 assert.equal(revoking,true);
 assert.equal(revoked,false,'revoke has started but lease is still active');
 // The already RESERVED signed permit now arrives on Hub A.
 delivered.open();
 await assert.rejects(late,{message:'FINAL_ATOMIC_AUTHORITY_REVOKE_PENDING'});
 assert.equal(gateCallbackEntrances,1,
  '#712 enters injected callback: production final CAS is NOT built in');
 assert.equal(finalAuthorityChecks,1);
 assert.equal(nativeEffects,0,
  'no synthetic native side effect without a passing FINAL authority check');
 assert.equal(releases,1);
 assert.equal(active.size,0);
 const completed=await draining;
 assert.equal(completed.drained,true);
 assert.equal(revoked,true);
 assert.equal(backendGeneration,grantGeneration+1);
 // A fresh Hub cannot reserve after completed revoke in the same model.
 await assert.rejects(gate().execute(operation,async()=>{nativeEffects++}),
  {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(nativeEffects,0);
});
