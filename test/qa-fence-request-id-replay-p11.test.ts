/** #11 synthetic QA. No real CAS, Broker, Windows token or side effect. */
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

function fixture(rotateRequestId:boolean){
  const key=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID();
  const original:BrokerDispatchRequest={
    requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',capability:'windows.firewall.control',fingerprint:'a'.repeat(64),
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),
      sessionEpoch:randomUUID(),ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE'},
  };
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,highIntegrityToken:true,
    signedProtectedImage:true,protectedParentAndImports:true,
  };
  const tombstones=new Set<string>();
  const active=new Map<string,string>();
  const remoteRequestIds:string[]=[];
  const replacementIds=['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  let effects=0,replacements=0;
  const signed=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    req:BrokerDispatchRequest,id:string,nonce:string):DispatchClaim=>{
    const now=Date.now(),scope=req.scope;
    const payload={kind,authorityId,brokerId,dispatchId:id,challengeNonce:nonce,
      requestId:req.requestId,capability:req.capability,fingerprint:req.fingerprint,
      ownerId:scope.ownerId,deviceId:scope.deviceId,deviceEpoch:scope.deviceEpoch,
      sessionEpoch:scope.sessionEpoch,ownerEpoch:scope.ownerEpoch,
      generation:scope.expectedGeneration,privilege:scope.requiredPrivilege,
      issuedAtMs:now,expiresAtMs:now+2500};
    const bytes=Buffer.from(JSON.stringify(payload));
    return {payload:bytes.toString('base64url'),
      signature:sign(null,bytes,key.privateKey).toString('base64url')};
  };
  const authority:ExternalBrokerDispatchAuthority={
    beginIfCurrent:async(req,_broker,nonce)=>{
      // A same-process adapter changes the parsed request before network use.
      // No remote party is modeled as having access to JavaScript memory.
      if(rotateRequestId){
        const replacement=replacementIds[replacements++];
        if(!replacement)throw Error('unexpected extra request');
        Reflect.set(req,'requestId',replacement);
      }
      remoteRequestIds.push(req.requestId);
      if(tombstones.has(req.requestId))throw Error('durable duplicate');
      tombstones.add(req.requestId);
      const dispatchId=randomUUID();
      active.set(dispatchId,JSON.stringify(req));
      return signed('broker_dispatch_permit_v1',req,dispatchId,nonce);
    },
    commitIfCurrent:async(req,_broker,id,nonce)=>{
      if(active.get(id)!==JSON.stringify(req))throw Error('commit scope mismatch');
      return signed('broker_dispatch_commit_v1',req,id,nonce);
    },
    revokeAndDrain:async()=>{throw Error('not used');},
    release:async value=>{
      if(active.get(value.dispatchId)!==JSON.stringify(value.request))
        throw Error('release scope mismatch');
      active.delete(value.dispatchId);
      // The request UUID tombstone deliberately survives release/restart.
    },
  };
  const newBroker=()=>new BrokerExternalDispatchFence({
    authority,authorityId,
    publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async()=>true,verifyEffectiveBroker:async()=>({...broker}),
    verifyOwnerRevocation:async()=>false,
  });
  const attempt=async(lostAck:boolean)=>newBroker().execute(original,async()=>{
    effects++;
    if(lostAck)throw Error('synthetic ACK lost after fixture effect');
    return 'synthetic-effect';
  });
  return {attempt,original,tombstones,remoteRequestIds,get effects(){return effects;}};
}

test('durable synthetic CAS rejects the same request after a lost effect ACK and restart',async()=>{
  const f=fixture(false);
  await assert.rejects(f.attempt(true),/synthetic ACK lost/);
  await assert.rejects(f.attempt(false));
  assert.equal(f.effects,1);
  assert.equal(f.tombstones.size,1);
  assert.ok(f.tombstones.has(f.original.requestId));
});

test('adapter request UUID replacement cannot replay after lost effect ACK and restart',async()=>{
  const f=fixture(true);
  try{await f.attempt(true)}catch{}
  const effectsAfterFirst=f.effects;
  try{await f.attempt(false)}catch{}
  assert.ok(effectsAfterFirst<=1);
  assert.equal(f.effects,effectsAfterFirst,'unknown retry must not invoke a second effect');
  assert.ok(f.tombstones.size<=1,'retry must not mint a second durable request UUID');
});

