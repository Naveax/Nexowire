/**
 * #18 independently reproduces the one uncovered #712/#719 inter-Hub edge.
 *
 * Deliberate UNSAFE NEGATIVE: a signed permit was already reserved before
 * revoke but is DELIVERED to Hub A only AFTER distinct Hub B began remote
 * revokeAndDrain. Hub A's process-local fence is unaware, and can invoke
 * its effect while the revoke is pending. Do NOT count PASS as safety.
 *
 * Real BrokerExternalDispatchFence and genuine ephemeral Ed25519 signatures.
 * Remote CAS, Broker HIGH token, two Hub hosts and Access readback are
 * TEST-ONLY models. No live Agent, DB, UAC, VM or external CAS service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type ExternalBrokerDispatchAuthority,type DispatchClaim,
  type BrokerDispatchRequest,type DispatchRevokeRequest,
  type ProtectedBrokerEvidence}
  from '../src/agent/broker-external-dispatch-fence.js';
import {signedOperatorGrantVerifier}
  from '../src/agent/witness-signed-provenance.js';

function latch(){
  let release!:()=>void;
  const promise=new Promise<void>(resolve=>{release=resolve});
  return {promise,release};
}
function signed(data:unknown,key:KeyObject):DispatchClaim{
  const bytes=Buffer.from(JSON.stringify(data));
  return {payload:bytes.toString('base64url'),
    signature:sign(null,bytes,key).toString('base64url')};
}

test('#18 NEGATIVE two Hubs: pre-revoke reserved permit delivered AFTER other Hub starts stalled drain can launch effect',async()=>{
  const ids={authorityId:randomUUID(),brokerId:randomUUID(),
    ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
  const ownerEpoch=8,generation=11;
  const authorityKeys=generateKeyPairSync('ed25519');
  const ownerKeys=generateKeyPairSync('ed25519');
  const reserved=latch(),deliverPermit=latch(),revokeStarted=latch(),
    drainReleased=latch(),effectEntered=latch(),finishEffect=latch();
  const active=new Set<string>();
  let revoking=false,revoked=false,releaseCount=0;
  const remote:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(request:BrokerDispatchRequest,
      broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>{
      const s=request.scope;
      if(revoking||revoked||s.ownerId!==ids.ownerId||
        s.deviceId!==ids.deviceId||s.deviceEpoch!==ids.deviceEpoch||
        s.sessionEpoch!==ids.sessionEpoch||s.ownerEpoch!==ownerEpoch||
        s.expectedGeneration!==generation)
        throw Error('SYNTHETIC_REMOTE_FENCE_DENIED');
      const dispatchId=randomUUID();
      active.add(dispatchId);
      reserved.release();
      // Claim is already allocated and will be returned only AFTER revoke
      // begins on Hub B. This is NOT a new reservation after revoke.
      await deliverPermit.promise;
      const now=Date.now();
      return signed({kind:'broker_dispatch_permit_v1',
        authorityId:ids.authorityId,brokerId:broker.brokerId,dispatchId,
        challengeNonce,requestId:request.requestId,
        fingerprint:request.fingerprint,capability:request.capability,
        ownerId:s.ownerId,deviceId:s.deviceId,
        deviceEpoch:s.deviceEpoch,sessionEpoch:s.sessionEpoch,
        ownerEpoch:s.ownerEpoch,generation:s.expectedGeneration,
        privilege:s.requiredPrivilege,
        issuedAtMs:now,expiresAtMs:now+2500},authorityKeys.privateKey);
    },
    async revokeAndDrain(r:DispatchRevokeRequest):Promise<DispatchClaim>{
      if(revoking||revoked||r.ownerId!==ids.ownerId||
         r.deviceId!==ids.deviceId||r.deviceEpoch!==ids.deviceEpoch||
         r.sessionEpoch!==ids.sessionEpoch||
         r.expectedGeneration!==generation)
        throw Error('SYNTHETIC_STALE_REVOKE');
      revoking=true;
      revokeStarted.release();
      if(active.size>0)await drainReleased.promise;
      revoked=true;
      return signed({kind:'broker_dispatch_revocation_v1',
        authorityId:ids.authorityId,deviceId:ids.deviceId,
        ownerId:ids.ownerId,deviceEpoch:ids.deviceEpoch,
        sessionEpoch:ids.sessionEpoch,
        previousGeneration:generation,generation:generation+1,
        drained:true,revoked:true},authorityKeys.privateKey);
    },
    async release(dispatchId:string):Promise<void>{
      releaseCount++;
      active.delete(dispatchId);
      if(active.size===0)drainReleased.release();
    },
  };

  const verifyApproval=signedOperatorGrantVerifier(
    ownerKeys.publicKey.export({format:'pem',type:'spki'}).toString());
  const gate=()=>new BrokerExternalDispatchFence({
    authority:remote,authorityId:ids.authorityId,
    publicKeyPem:authorityKeys.publicKey.export({
      format:'pem',type:'spki'}).toString(),
    verifyIdentity:async()=>true,
    // All-positive SYNTHETIC evidence, never installed native Windows HIGH.
    verifyEffectiveBroker:async()=>({
      verified:true,brokerId:ids.brokerId,ownerEpoch,
      grantGeneration:generation,highIntegrityToken:true,
      signedProtectedImage:true,protectedParentAndImports:true,
    }),
    verifyOwnerRevocation:async r=>verifyApproval({
      kind:'revoke',authorityId:ids.authorityId,
      deviceId:ids.deviceId,ownerId:ids.ownerId,
      epoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
      generation:r.expectedGeneration,
    },r.signedOwnerApproval),
  });
  const request=():BrokerDispatchRequest=>({
    requestId:randomUUID(),fingerprint:'b'.repeat(64),
    capability:'files.write',
    scope:{ownerId:ids.ownerId,deviceId:ids.deviceId,
      deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
      ownerEpoch,expectedGeneration:generation,requiredPrivilege:'CORE'},
  });
  const intent={kind:'revoke',authorityId:ids.authorityId,
    deviceId:ids.deviceId,ownerId:ids.ownerId,
    epoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
    generation};
  const now=Date.now();
  const revokeRequest:DispatchRevokeRequest={
    deviceId:ids.deviceId,ownerId:ids.ownerId,
    deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
    expectedGeneration:generation,
    signedOwnerApproval:JSON.stringify(signed({
      version:1,intent,nonce:randomUUID(),
      issuedAt:now-1000,expiresAt:now+60_000,
    },ownerKeys.privateKey)),
  };

  const hubA=gate(),hubB=gate();
  let effects=0;
  const pending=hubA.execute(request(),async()=>{
    effects++;
    assert.equal(revoking,true,'effect starts AFTER remote revoke began');
    assert.equal(revoked,false,'remote revoke still draining');
    effectEntered.release();
    await finishEffect.promise;
    return 'SYNTHETIC_EFFECT_ONLY';
  });
  await reserved.promise;
  assert.equal(active.size,1);
  let drainCompleted=false;
  const drain=hubB.revoke(revokeRequest).then(x=>{
    drainCompleted=true;
    return x;
  });
  await revokeStarted.promise;
  assert.equal(effects,0,'nothing executed before remote revoke start');
  await assert.rejects(hubB.execute(request(),async()=>{effects++}),
    {code:'DISPATCH_REVOKE_PENDING'});
  // #719's read-only REVIEWED_ONLY_NO_DISPATCH cannot synchronize Hub A's
  // actual native effect. The #712 nonce is fresh and genuinely signed,
  // but Hub A's local revoked flag is not shared with Hub B.
  deliverPermit.release();
  await effectEntered.promise;
  assert.equal(effects,1,
    'NEGATIVE: Hub A executed after Hub B requested external drain');
  assert.equal(drainCompleted,false,'drain is still waiting for admitted lease');
  finishEffect.release();
  assert.equal(await pending,'SYNTHETIC_EFFECT_ONLY');
  const receipt=await drain;
  assert.equal(receipt.drained,true);
  assert.equal(releaseCount,1);
  assert.equal(active.size,0);
  assert.equal(revoked,true);
  await assert.rejects(gate().execute(request(),async()=>{effects++}),
    {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
  assert.equal(effects,1);
});
