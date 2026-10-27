/**
 * Independent adversarial QA for #702. Test-only, synthetic transport.
 * A signed external CAS permit cannot turn a STALE local HIGH-token readback
 * into a live, privileged OS attestation. No physical devices are touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  BrokerExternalDispatchFence,
  type BrokerDispatchRequest,
  type DispatchClaim,
  type ExternalBrokerDispatchAuthority,
  type ProtectedBrokerEvidence,
} from '../src/agent/broker-external-dispatch-fence.js';

test('P0 RED: HIGH token downgraded during delayed external CAS cannot execute effect', async () => {
  const signer=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID();
  const ownerId=randomUUID(),deviceId=randomUUID();
  const deviceEpoch=randomUUID(),sessionEpoch=randomUUID();
  const operation:BrokerDispatchRequest={
    requestId:randomUUID(),fingerprint:'a'.repeat(64),
    capability:'shell.exec',
    scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,
      ownerEpoch:9,expectedGeneration:12,requiredPrivilege:'CORE'},
  };
  let notifyBegin!:()=>void,releaseBegin!:()=>void;
  const reachedBegin=new Promise<void>(resolve=>{notifyBegin=resolve});
  const resumeBegin=new Promise<void>(resolve=>{releaseBegin=resolve});
  let high=true,attestationReads=0,effects=0,releases=0;
  const dispatchId=randomUUID();
  const signed=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
      nonce:string,broker:ProtectedBrokerEvidence):DispatchClaim=>{
    const now=Date.now();
    const body=Buffer.from(JSON.stringify({
      kind,authorityId,brokerId:broker.brokerId,dispatchId,
      challengeNonce:nonce,requestId:operation.requestId,
      fingerprint:operation.fingerprint,capability:operation.capability,
      ownerId,deviceId,deviceEpoch,sessionEpoch,
      ownerEpoch:operation.scope.ownerEpoch,
      generation:operation.scope.expectedGeneration,
      privilege:operation.scope.requiredPrivilege,
      issuedAtMs:now,expiresAtMs:now+2000,
    }));
    return {payload:body.toString('base64url'),
      signature:sign(null,body,signer.privateKey).toString('base64url')};
  };
  const remote:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(req,broker,nonce){
      assert.equal(req.requestId,operation.requestId);
      notifyBegin();
      await resumeBegin;
      // This remote signs using the earlier Broker evidence. It does not
      // independently inspect the CURRENT Windows token (trust boundary).
      return signed('broker_dispatch_permit_v1',nonce,broker);
    },
    async commitIfCurrent(req,broker,id,nonce){
      assert.equal(req.requestId,operation.requestId);
      assert.equal(id,dispatchId);
      return signed('broker_dispatch_commit_v1',nonce,broker);
    },
    async release(id){assert.equal(id,dispatchId);releases++},
    async revokeAndDrain(){throw Error('NOT_USED_IN_SYNTHETIC_QA')},
  };
  const fence=new BrokerExternalDispatchFence({
    authority:remote,authorityId,
    publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async()=>true,
    verifyEffectiveBroker:async()=>{
      attestationReads++;
      return {verified:true,brokerId,ownerEpoch:9,grantGeneration:12,
        // Runtime false is intentional: the native readback changed.
        highIntegrityToken:high as true,
        signedProtectedImage:true,protectedParentAndImports:true};
    },
    verifyOwnerRevocation:async()=>false,
  });
  const pending=fence.execute(operation,async()=>{effects++;return 'OS_EFFECT'});
  await reachedBegin;
  high=false; // The initial HIGH evidence has become stale while CAS awaits.
  releaseBegin();
  await assert.rejects(pending,{code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'},
    'no privileged side effect may use a pre-await HIGH attestation');
  assert.equal(effects,0,'stale HIGH evidence must never reach native callback');
  assert.ok(attestationReads>=2,'independent effective token must be re-read');
  assert.ok(releases<=1,'claim release must not produce a second effect');
});
