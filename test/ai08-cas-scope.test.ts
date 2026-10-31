/** AI-08 independent CAS request-mutation QA.
 * All keys, broker attestations and effects are synthetic, not native evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  BrokerExternalDispatchFence,type BrokerDispatchRequest,
  type ProtectedBrokerEvidence,type ExternalBrokerDispatchAuthority,
  type DispatchClaim,
} from '../src/agent/broker-external-dispatch-fence.js';

type Attack='original-mutation'|'signed-owner-substitution'|'broker-disappears'|'parallel-claim';
function make(attack:Attack){
  const keys=generateKeyPairSync('ed25519');
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const original:BrokerDispatchRequest={
    requestId:randomUUID(),capability:'windows.firewall.control',fingerprint:'e'.repeat(64),
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),
      sessionEpoch:randomUUID(),ownerEpoch:3,expectedGeneration:9,requiredPrivilege:'CORE'},
  };
  const expected=structuredClone(original);
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:3,grantGeneration:9,
    highIntegrityToken:true,signedProtectedImage:true,protectedParentAndImports:true,
  };
  let effects=0,brokerReads=0,beginReads=0;
  let enterBegin!:()=>void,releaseBegin!:()=>void;
  const beginEntered=new Promise<void>(resolve=>{enterBegin=resolve});
  const beginHeld=new Promise<void>(resolve=>{releaseBegin=resolve});
  let seen:BrokerDispatchRequest|undefined;
  const replayTombstones=new Set<string>();
  const proof=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    req:BrokerDispatchRequest,nonce:string):DispatchClaim=>{
    const ts=Date.now(),scope=req.scope;
    const payload={kind,authorityId,brokerId,dispatchId,challengeNonce:nonce,
      requestId:req.requestId,fingerprint:req.fingerprint,capability:req.capability,
      ownerId:attack==='signed-owner-substitution'?randomUUID():scope.ownerId,
      deviceId:scope.deviceId,deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
      ownerEpoch:scope.ownerEpoch,generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:ts,expiresAtMs:ts+2000};
    const bytes=Buffer.from(JSON.stringify(payload));
    return {payload:bytes.toString('base64url'),
      signature:sign(null,bytes,keys.privateKey).toString('base64url')};
  };
  const authority:ExternalBrokerDispatchAuthority={
    beginIfCurrent:async(req,_b,nonce)=>{
      beginReads++;
      assert.deepEqual(req,expected,'begin must receive admitted detached request');
      assert.ok(Object.isFrozen(req));
      assert.ok(Object.isFrozen(req.scope));
      if(replayTombstones.has(req.requestId))throw Error('durable replay tombstone');
      replayTombstones.add(req.requestId);
      seen=structuredClone(req);
      if(attack==='parallel-claim'){enterBegin();await beginHeld;}
      return proof('broker_dispatch_permit_v1',req,nonce);
    },
    commitIfCurrent:async(req,_b,id,nonce)=>{
      assert.deepEqual(req,expected);
      assert.equal(id,dispatchId);
      return proof('broker_dispatch_commit_v1',req,nonce);
    },
    revokeAndDrain:async()=>{throw Error('not in this synthetic test')},
    release:async()=>{},
  };
  const fence=new BrokerExternalDispatchFence({
    authority,authorityId,
    publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
    verifyIdentity:async req=>{
      assert.deepEqual(req,expected);
      if(attack==='original-mutation'){
        original.scope.ownerId=randomUUID();
        original.scope.deviceId=randomUUID();
        original.scope.sessionEpoch=randomUUID();
        original.fingerprint='f'.repeat(64);
        original.requestId=randomUUID();
      }
      await Promise.resolve();
      return true;
    },
    verifyEffectiveBroker:async()=>{
      brokerReads++;
      if(attack==='broker-disappears'&&brokerReads>=2)
        throw Error('synthetic broker revoked between begin and commit');
      return {...broker};
    },
    verifyOwnerRevocation:async()=>false,
  });
  return {original,expected,get effects(){return effects},
    get seen(){return seen},get beginReads(){return beginReads},
    beginEntered,releaseBegin:()=>releaseBegin(),
    run:()=>fence.execute(original,async approved=>{
      effects++;
      assert.deepEqual(approved,expected,'callback must receive immutable validated scope');
      return 'synthetic-effect';
    })};
}

test('AI-08: mutation of original request after identity await cannot substitute scope',async()=>{
  const f=make('original-mutation');
  assert.equal(await f.run(),'synthetic-effect');
  assert.equal(f.effects,1);
  assert.deepEqual(f.seen,f.expected);
  assert.notEqual(f.original.requestId,f.expected.requestId);
});

test('AI-08: correctly signed receipt with substituted owner must still deny',async()=>{
  const f=make('signed-owner-substitution');
  await assert.rejects(f.run());
  assert.equal(f.effects,0);
  assert.equal(f.beginReads,1);
});

test('AI-08: loss of trusted broker readback between CAS phases denies execution',async()=>{
  const f=make('broker-disappears');
  await assert.rejects(f.run());
  assert.equal(f.effects,0);
});

test('AI-08: concurrent same-UUID external CAS dispatch cannot double-admit',async()=>{
  const f=make('parallel-claim');
  const first=f.run();
  try{
    await f.beginEntered;
    await assert.rejects(f.run(),{code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
    assert.equal(f.beginReads,1,'second in-flight UUID never reaches remote reserve');
  }finally{f.releaseBegin();}
  assert.equal(await first,'synthetic-effect');
  assert.equal(f.effects,1);
  await assert.rejects(f.run(),{code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'},
    'the consumed UUID cannot be replayed after completion');
  assert.equal(f.effects,1);
});
