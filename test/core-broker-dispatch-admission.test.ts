/**
 * #03 SOURCE-ONLY dispatch integration QA. All remote CAS receipts and
 * HIGH-token readbacks in this file are synthetic; no live elevation.
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
import {
  brokerEffectFingerprint,
  CORE_EXECUTOR_DISPATCH_ENABLED,
  executeAdmittedCoreBrokerEffect,
  executeServerCoreBrokerMutation,
  type TrustedCoreBrokerDispatch,
} from '../src/agent/core-broker-dispatch-admission.js';

type Scenario='ok'|'beginLostAck'|'commitLostAck'|'expired'|
  'revoked'|'staleAfterBegin'|'staleAfterCommit'|'releaseLostAck';
const capability='windows.firewall.control';
const input={action:'enable',name:'nexowire-fixture'};
function fixture(scenario:Scenario='ok') {
  const pair=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const ownerId=randomUUID(),deviceId=randomUUID();
  const deviceEpoch=randomUUID(),sessionEpoch=randomUUID();
  let high=true,begins=0,commits=0,releases=0,reads=0,effects=0;
  const req:BrokerDispatchRequest={
    requestId:randomUUID(),fingerprint:brokerEffectFingerprint(capability,input),
    capability,scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,
      ownerEpoch:17,expectedGeneration:4,requiredPrivilege:'CORE'},
  };
  const signed=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    nonce:string,broker:ProtectedBrokerEvidence):DispatchClaim=>{
    const issued=Date.now();
    const body=Buffer.from(JSON.stringify({
      kind,authorityId,brokerId:broker.brokerId,dispatchId,
      challengeNonce:nonce,requestId:req.requestId,
      fingerprint:req.fingerprint,capability:req.capability,
      ownerId,deviceId,deviceEpoch,sessionEpoch,
      ownerEpoch:17,generation:4,privilege:'CORE',
      issuedAtMs:scenario==='expired'?issued-7000:issued,
      expiresAtMs:scenario==='expired'?issued-1000:issued+2000,
    }));
    return {payload:body.toString('base64url'),
      signature:sign(null,body,pair.privateKey).toString('base64url')};
  };
  const remote:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(operation,broker,nonce){
      assert.equal(operation.requestId,req.requestId);
      begins++;
      if(scenario==='beginLostAck')throw Error('CAS BEGIN ACK UNKNOWN');
      const proof=signed('broker_dispatch_permit_v1',nonce,broker);
      if(scenario==='staleAfterBegin')high=false;
      return proof;
    },
    async commitIfCurrent(operation,broker,id,nonce){
      assert.equal(operation.requestId,req.requestId);
      assert.equal(id,dispatchId);
      commits++;
      if(scenario==='revoked'||scenario==='commitLostAck')
        throw Error('CAS COMMIT UNKNOWN');
      const proof=signed('broker_dispatch_commit_v1',nonce,broker);
      if(scenario==='staleAfterCommit')high=false;
      return proof;
    },
    async release(release){
      releases++;
      assert.equal(release.dispatchId,dispatchId);
      assert.equal(release.brokerId,brokerId);
      assert.deepEqual(release.request,req);
      if(scenario==='releaseLostAck')throw Error('release ACK UNKNOWN');
    },
    async revokeAndDrain(){throw Error('not used in fixture')},
  };
  const fence=new BrokerExternalDispatchFence({
    authority:remote,authorityId,
    publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async operation=>operation.requestId===req.requestId,
    verifyEffectiveBroker:async()=>{
      reads++;
      return {verified:true,brokerId,ownerEpoch:17,grantGeneration:4,
        highIntegrityToken:high as true,
        signedProtectedImage:true,protectedParentAndImports:true};
    },
    verifyOwnerRevocation:async()=>false,
  });
  const trusted:TrustedCoreBrokerDispatch={
    fence,
    resolveAuthenticatedRequest:async()=>req,
  };
  const effect=async()=>{effects++;return 'MUTATION_RUN';};
  return {req,trusted,effect,stats:()=>({begins,commits,releases,reads,effects}),
    downgrade:()=>{high=false}};
}

test('#03 production legacy bearer/callback cannot bypass disabled CORE guard',async()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const f=fixture();
  await assert.rejects(
    executeServerCoreBrokerMutation(undefined,capability,input,f.effect),
    {code:'CORE_ELEVATED_DISPATCH_DISABLED'});
  await assert.rejects(
    executeServerCoreBrokerMutation(f.trusted,capability,input,f.effect),
    {code:'CORE_ELEVATED_DISPATCH_DISABLED'});
  assert.deepEqual(f.stats(),{begins:0,commits:0,releases:0,reads:0,effects:0});
});

test('#03 isolated signed begin + commit + refreshed HIGH admits callback exactly once',async()=>{
  const f=fixture();
  assert.equal(await executeAdmittedCoreBrokerEffect(
    f.trusted,capability,input,f.effect),'MUTATION_RUN');
  assert.deepEqual(f.stats(),{begins:1,commits:1,releases:1,reads:3,effects:1});
  // This is a separate test seam, not the production /execute path.
});

for(const [scenario,reason] of [
  ['beginLostAck','DISPATCH_EXTERNAL_CAS_UNKNOWN'],
  ['commitLostAck','DISPATCH_COMMIT_UNKNOWN'],
  ['revoked','DISPATCH_COMMIT_UNKNOWN'],
  ['expired','DISPATCH_PROOF_EXPIRED'],
  ['staleAfterBegin','DISPATCH_HIGH_TOKEN_UNVERIFIED'],
  ['staleAfterCommit','DISPATCH_HIGH_TOKEN_UNVERIFIED'],
] as const){
  test('#03 '+scenario+' rejects callback and does not replay',async()=>{
    const f=fixture(scenario);
    await assert.rejects(
      executeAdmittedCoreBrokerEffect(f.trusted,capability,input,f.effect),
      {code:reason});
    assert.equal(f.stats().effects,0);
    assert.ok(f.stats().begins<=1);
    assert.ok(f.stats().commits<=1);
    // An UNKNOWN or invalid proof cannot re-run an OS effect.
  });
}

test('#03 #908 stale-HIGH after external begin cannot enter commit or effect',async()=>{
  const f=fixture('staleAfterBegin');
  await assert.rejects(
    executeAdmittedCoreBrokerEffect(f.trusted,capability,input,f.effect),
    {code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
  assert.equal(f.stats().commits,0);
  assert.equal(f.stats().effects,0);
  assert.ok(f.stats().reads>=2);
});

test('#03 lost release ACK may follow an effect but must fence future replay',async()=>{
  const f=fixture('releaseLostAck');
  assert.equal(await executeAdmittedCoreBrokerEffect(
    f.trusted,capability,input,f.effect),'MUTATION_RUN');
  await assert.rejects(
    executeAdmittedCoreBrokerEffect(f.trusted,capability,input,f.effect),
    {code:'DISPATCH_REVOKE_PENDING'});
  assert.equal(f.stats().effects,1);
  assert.equal(f.stats().begins,1);
  assert.equal(f.stats().commits,1);
});

test('#03 command fingerprint and bound capability cannot be swapped',async()=>{
  const f=fixture();
  await assert.rejects(
    executeAdmittedCoreBrokerEffect(f.trusted,capability,{name:'different'},f.effect),
    {code:'CORE_DISPATCH_REQUEST_SCOPE_MISMATCH'});
  await assert.rejects(
    executeAdmittedCoreBrokerEffect(f.trusted,'windows.task.control',input,f.effect),
    {code:'CORE_DISPATCH_REQUEST_SCOPE_MISMATCH'});
  assert.equal(f.stats().effects,0);
  assert.equal(f.stats().begins,0);
});

test('#03 missing protected admission and invalid epoch/generation never execute',async()=>{
  const f=fixture();
  await assert.rejects(executeAdmittedCoreBrokerEffect(
    undefined as unknown as TrustedCoreBrokerDispatch,
    capability,input,f.effect),{code:'CORE_DISPATCH_TRUSTED_PROVIDER_UNAVAILABLE'});
  const wrong:TrustedCoreBrokerDispatch={
    ...f.trusted,
    resolveAuthenticatedRequest:async()=>({
      ...f.req,scope:{...f.req.scope,expectedGeneration:999},
    }),
  };
  await assert.rejects(
    executeAdmittedCoreBrokerEffect(wrong,capability,input,f.effect),
    {code:'DISPATCH_OWNER_EPOCH_MISMATCH'});
  assert.equal(f.stats().effects,0);
});
