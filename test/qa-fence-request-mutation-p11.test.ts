/** #11 adversarial source QA. Keys, CAS, Broker evidence and callback are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  BrokerExternalDispatchFence,
  type BrokerDispatchRequest,
  type DispatchClaim,
  type DispatchReleaseRequest,
  type ExternalBrokerDispatchAuthority,
  type ProtectedBrokerEvidence,
} from '../src/agent/broker-external-dispatch-fence.js';

function fixture(mode:'none'|'payload'|'scope'){
  const key=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const original:BrokerDispatchRequest={
    requestId:randomUUID(),capability:'windows.firewall.control',fingerprint:'a'.repeat(64),
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),
      sessionEpoch:randomUUID(),ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE'},
  };
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,highIntegrityToken:true,
    signedProtectedImage:true,protectedParentAndImports:true,
  };
  let reserved:string|undefined,remoteRequest:BrokerDispatchRequest|undefined;
  let effects=0,identitySeen:BrokerDispatchRequest|undefined;
  const signed=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    req:BrokerDispatchRequest,nonce:string):DispatchClaim=>{
    const now=Date.now(),scope=req.scope;
    const payload={
      kind,authorityId,brokerId,dispatchId,challengeNonce:nonce,
      requestId:req.requestId,capability:req.capability,fingerprint:req.fingerprint,
      ownerId:scope.ownerId,deviceId:scope.deviceId,deviceEpoch:scope.deviceEpoch,
      sessionEpoch:scope.sessionEpoch,ownerEpoch:scope.ownerEpoch,
      generation:scope.expectedGeneration,privilege:scope.requiredPrivilege,
      issuedAtMs:now,expiresAtMs:now+2500,
    };
    const bytes=Buffer.from(JSON.stringify(payload));
    return {payload:bytes.toString('base64url'),signature:sign(null,bytes,key.privateKey).toString('base64url')};
  };
  // Synthetic backend commits only the exact request it reserved.
  const backend={
    begin(req:BrokerDispatchRequest,nonce:string){
      reserved=JSON.stringify(req);
      remoteRequest=JSON.parse(reserved) as BrokerDispatchRequest;
      return signed('broker_dispatch_permit_v1',req,nonce);
    },
    commit(req:BrokerDispatchRequest,id:string,nonce:string){
      if(id!==dispatchId||reserved!==JSON.stringify(req))throw Error('scope mismatch');
      return signed('broker_dispatch_commit_v1',req,nonce);
    },
    release(value:DispatchReleaseRequest){
      if(value.dispatchId!==dispatchId||reserved!==JSON.stringify(value.request))
        throw Error('release scope mismatch');
    },
  };
  const authority:ExternalBrokerDispatchAuthority={
    beginIfCurrent:async(req,_broker,nonce)=>{
      // Only the in-process client adapter can mutate this shared object;
      // this does not model a network peer mutating memory remotely.
      if(mode==='payload'){
        Reflect.set(req,'capability','windows.task.control');
        Reflect.set(req,'fingerprint','b'.repeat(64));
      }
      if(mode==='scope'){
        Reflect.set(req.scope,'ownerId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        Reflect.set(req.scope,'deviceId','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
        Reflect.set(req.scope,'sessionEpoch','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      }
      return backend.begin(req,nonce);
    },
    commitIfCurrent:async(req,_broker,id,nonce)=>backend.commit(req,id,nonce),
    revokeAndDrain:async()=>{throw Error('not used');},
    release:async value=>backend.release(value),
  };
  const fence=new BrokerExternalDispatchFence({
    authority,authorityId,
    publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async req=>{
      identitySeen=JSON.parse(JSON.stringify(req)) as BrokerDispatchRequest;
      return true;
    },
    verifyEffectiveBroker:async()=>({...broker}),
    verifyOwnerRevocation:async()=>false,
  });
  const run=()=>fence.execute(original,async()=>{effects++;return 'synthetic-effect';});
  return {run,original,get effects(){return effects;},
    get remoteRequest(){return remoteRequest;},get identitySeen(){return identitySeen;}};
}

test('positive exact request is authenticated, signed and runs only its fixture callback',async()=>{
  const f=fixture('none');
  assert.equal(await f.run(),'synthetic-effect');
  assert.equal(f.effects,1);
  assert.deepEqual(f.remoteRequest,f.original);
  assert.deepEqual(f.identitySeen,f.original);
});

test('a shared adapter cannot substitute the signed capability and fingerprint before callback',async()=>{
  const f=fixture('payload');
  let denied=false;
  try{await f.run()}catch{denied=true;}
  if(denied){
    assert.equal(f.effects,0,'denial must not invoke the synthetic callback');
    return;
  }
  assert.equal(f.effects,1);
  assert.equal(f.identitySeen?.capability,f.original.capability);
  assert.equal(f.identitySeen?.fingerprint,f.original.fingerprint);
  assert.deepEqual(
    {capability:f.remoteRequest?.capability,fingerprint:f.remoteRequest?.fingerprint},
    {capability:f.original.capability,fingerprint:f.original.fingerprint},
    'signed CAS capability and fingerprint must match the callback request',
  );
});


test('a shared adapter cannot substitute nested owner, device or session scope',async()=>{
  const f=fixture('scope');
  let denied=false;
  try{await f.run()}catch{denied=true;}
  if(denied){
    assert.equal(f.effects,0,'denial must not invoke the synthetic callback');
    return;
  }
  assert.equal(f.effects,1);
  assert.deepEqual(f.identitySeen?.scope,f.original.scope);
  assert.deepEqual(f.remoteRequest?.scope,f.original.scope,
    'signed CAS owner, device and session must match the callback request');
});
