/**
 * #03 source-only integration tests. Signed receipts and HIGH token are
 * synthetic. This does NOT attest physical Windows or a deployed CAS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
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
  executeProtectedBrokerEffect,
  type ProtectedBrokerEffectDispatch,
} from '../src/agent/core-broker-effect-dispatch.js';

const transport={} as IncomingMessage;
const capability='windows.firewall.control';
const input={action:'enable',name:'synthetic'};
type Fault='none'|'expired'|'stale-begin-high'|'stale-commit-high'|
  'commit-unknown'|'release-lost-ack'|'scope-mismatch'|'revoke'|'identity-denied';
function harness(fault:Fault='none'){
  const key=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const request:BrokerDispatchRequest={
    requestId:randomUUID(),capability,
    fingerprint:brokerEffectFingerprint(capability,input),
    scope:{
      ownerId:randomUUID(),deviceId:randomUUID(),
      deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
      ownerEpoch:19,expectedGeneration:8,requiredPrivilege:'CORE',
    },
  };
  let high=true,beginCount=0,commitCount=0,releaseCount=0;
  let effectCount=0,highReads=0;
  const signed=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    nonce:string,broker:ProtectedBrokerEvidence):DispatchClaim=>{
    const now=Date.now();
    const body=Buffer.from(JSON.stringify({
      kind,authorityId,brokerId:broker.brokerId,dispatchId,
      challengeNonce:nonce,requestId:request.requestId,
      fingerprint:request.fingerprint,capability:request.capability,
      ownerId:request.scope.ownerId,deviceId:request.scope.deviceId,
      deviceEpoch:request.scope.deviceEpoch,sessionEpoch:request.scope.sessionEpoch,
      ownerEpoch:request.scope.ownerEpoch,
      generation:fault==='scope-mismatch'?9:request.scope.expectedGeneration,
      privilege:request.scope.requiredPrivilege,
      issuedAtMs:fault==='expired'?now-8000:now,
      expiresAtMs:fault==='expired'?now-1000:now+2000,
    }));
    return {payload:body.toString('base64url'),
      signature:sign(null,body,key.privateKey).toString('base64url')};
  };
  const remote:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(_req,broker,nonce){
      beginCount++;
      if(fault==='stale-begin-high')high=false;
      if(fault==='revoke')throw Error('remote revoke started');
      return signed('broker_dispatch_permit_v1',nonce,broker);
    },
    async commitIfCurrent(_req,broker,id,nonce){
      commitCount++;
      assert.equal(id,dispatchId);
      if(fault==='commit-unknown')throw Error('lost commit ACK');
      if(fault==='stale-commit-high')high=false;
      return signed('broker_dispatch_commit_v1',nonce,broker);
    },
    async release(release){
      releaseCount++;
      assert.equal(release.dispatchId,dispatchId);
      assert.equal(release.brokerId,brokerId);
      assert.deepEqual(release.request,request);
      if(fault==='release-lost-ack')throw Error('lost release ACK');
    },
    async revokeAndDrain(){throw Error('not invoked')},
  };
  const fence=new BrokerExternalDispatchFence({
    authority:remote,authorityId,
    publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async(req)=>fault!=='identity-denied'&&
      req.scope.sessionEpoch===request.scope.sessionEpoch&&
      req.scope.ownerEpoch===19&&req.scope.expectedGeneration===8,
    verifyEffectiveBroker:async()=>{
      highReads++;
      return {verified:true,brokerId,ownerEpoch:19,grantGeneration:8,
        highIntegrityToken:high as true,
        signedProtectedImage:true,protectedParentAndImports:true};
    },
    verifyOwnerRevocation:async()=>false,
  });
  const dispatch:ProtectedBrokerEffectDispatch={
    fence,resolveAuthenticatedRequest:async()=>request,
  };
  const invoke=(chosen:ProtectedBrokerEffectDispatch|undefined=dispatch,
    payload:unknown=input,cap:string=capability)=>
    executeProtectedBrokerEffect(chosen,transport,cap,payload,
      async()=>{effectCount++;return 'EFFECT';});
  return {dispatch,request,invoke,
    metrics:()=>({beginCount,commitCount,releaseCount,effectCount,highReads})};
}

test('#03 legacy bearer/capability without external fence never invokes effect',async()=>{
  const h=harness();
  await assert.rejects(executeProtectedBrokerEffect(undefined,transport,
    capability,input,async()=>{throw Error('FORBIDDEN_EFFECT');}),
    {code:'CORE_EXTERNAL_CAS_DISPATCH_REQUIRED'});
  assert.equal(h.metrics().effectCount,0);
  assert.equal(h.metrics().beginCount,0);
});

test('#03 protected dispatch requires exact authenticated request fingerprint',async()=>{
  const h=harness();
  await assert.rejects(h.invoke(h.dispatch,{action:'disable',name:'synthetic'}),
    {code:'CORE_EFFECT_FINGERPRINT_MISMATCH'});
  await assert.rejects(h.invoke(h.dispatch,input,'windows.service.control'),
    {code:'CORE_EFFECT_FINGERPRINT_MISMATCH'});
  const noAuth:ProtectedBrokerEffectDispatch={
    ...h.dispatch,resolveAuthenticatedRequest:async()=>{throw Error('unavailable')},
  };
  await assert.rejects(h.invoke(noAuth),
    {code:'CORE_AUTHENTICATED_INTENT_UNAVAILABLE'});
  assert.equal(h.metrics().beginCount,0);
  assert.equal(h.metrics().effectCount,0);
});

test('#03 signed remote reserve+commit, current epoch and refreshed HIGH permit one effect',async()=>{
  const h=harness();
  assert.equal(await h.invoke(),'EFFECT');
  assert.deepEqual(h.metrics(),{
    beginCount:1,commitCount:1,releaseCount:1,effectCount:1,highReads:3,
  });
});

test('#03 expired, wrong generation, revoke and identity denial never execute callback',async()=>{
  for(const fault of ['expired','scope-mismatch','revoke','identity-denied'] as const){
    const h=harness(fault);
    await assert.rejects(h.invoke(),/DISPATCH_/);
    assert.equal(h.metrics().effectCount,0,fault);
  }
});

test('#03 #908 HIGH token downgrade during begin or commit cannot reach OS callback',async()=>{
  for(const fault of ['stale-begin-high','stale-commit-high'] as const){
    const h=harness(fault);
    await assert.rejects(h.invoke(),{code:'DISPATCH_HIGH_TOKEN_UNVERIFIED'});
    assert.equal(h.metrics().effectCount,0,fault);
    assert.ok(h.metrics().highReads>=2);
  }
});

test('#03 lost commit ACK becomes UNKNOWN, fenced request cannot be replayed',async()=>{
  const h=harness('commit-unknown');
  await assert.rejects(h.invoke(),{code:'DISPATCH_COMMIT_UNKNOWN'});
  assert.equal(h.metrics().effectCount,0);
  await assert.rejects(h.invoke(),{code:'DISPATCH_REVOKE_PENDING'});
  assert.equal(h.metrics().effectCount,0);
  assert.equal(h.metrics().commitCount,1);
});

test('#03 release lost ACK cannot run a second OS callback',async()=>{
  const h=harness('release-lost-ack');
  assert.equal(await h.invoke(),'EFFECT');
  await assert.rejects(h.invoke(),{code:'DISPATCH_REVOKE_PENDING'});
  assert.equal(h.metrics().effectCount,1);
});

test('#03 spoofed grant/session/fingerprint never bypasses authenticated source',async()=>{
  const h=harness();
  const forged:ProtectedBrokerEffectDispatch={
    ...h.dispatch,
    resolveAuthenticatedRequest:async()=>({
      ...h.request,scope:{...h.request.scope,sessionEpoch:randomUUID()},
    }),
  };
  await assert.rejects(h.invoke(forged),{code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(h.metrics().effectCount,0);
});
