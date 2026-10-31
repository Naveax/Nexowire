/** Synthetic signed CAS receipts only. This does NOT attest Windows Broker,
 * real owner credentials, kernel Job isolation or durable external CAS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type ProtectedBrokerEvidence,
  type DispatchClaim,type ExternalBrokerDispatchAuthority,
} from '../src/agent/broker-external-dispatch-fence.js';

const keys=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
type Stage='reserve'|'commit';
type Hostile='accessor'|'inherited'|'proxy'|'extra-own-key'|'symbol-key';

function fixture(hostile?:{stage:Stage;kind:Hostile}) {
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const request:BrokerDispatchRequest={
    requestId:randomUUID(),fingerprint:'f'.repeat(64),capability:'shell.exec',
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),
      deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:4,
      expectedGeneration:7,requiredPrivilege:'CORE'},
  };
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true,
  };
  const counts={begin:0,commit:0,release:0,getterReads:0};
  const receipt=(stage:Stage,challengeNonce:string):DispatchClaim=>{
    const now=Date.now(),scope=request.scope;
    const fields={
      kind:stage==='reserve'?'broker_dispatch_permit_v1':'broker_dispatch_commit_v1',
      authorityId,brokerId,dispatchId,challengeNonce,
      requestId:request.requestId,fingerprint:request.fingerprint,
      capability:request.capability,ownerId:scope.ownerId,deviceId:scope.deviceId,
      deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
      ownerEpoch:scope.ownerEpoch,generation:scope.expectedGeneration,
      privilege:scope.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+2000,
    };
    const bytes=Buffer.from(JSON.stringify(fields),'utf8');
    const signed:DispatchClaim={
      payload:bytes.toString('base64url'),
      signature:sign(null,bytes,keys.privateKey).toString('base64url'),
    };
    if(hostile?.stage!==stage)return signed;
    switch(hostile.kind){
      case 'accessor': {
        Object.defineProperty(signed,'payload',{enumerable:true,configurable:true,
          get(){counts.getterReads++;return signed.signature;}});
        return signed;
      }
      case 'inherited':
        return Object.create(signed) as DispatchClaim;
      case 'proxy':
        return new Proxy(signed,{
          getOwnPropertyDescriptor(){throw Error('MALICIOUS_RECEIPT_TRAP')},
        });
      case 'extra-own-key':
        return {...signed,secret:'untrusted'} as DispatchClaim;
      case 'symbol-key':
        return Object.assign(signed,{[Symbol('secret')]:true});
    }
  };
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(){throw Error('NO_NONCE');},
    async commitIfCurrent(){throw Error('NO_NONCE');},
    async release(){counts.release++},
    async revokeAndDrain(){throw Error('TEST_ONLY_NO_REVOKE')},
  };
  authority.beginIfCurrent=async (_request,_broker,nonce)=>{
    counts.begin++;return receipt('reserve',nonce);
  };
  authority.commitIfCurrent=async (_request,_broker,_dispatchId,nonce)=>{
    counts.commit++;return receipt('commit',nonce);
  };
  const gate=new BrokerExternalDispatchFence({
    authority,authorityId,publicKeyPem,
    verifyIdentity:async()=>true,
    verifyEffectiveBroker:async()=>({...broker}),
    verifyOwnerRevocation:async()=>false,
  });
  return {gate,request,counts};
}

test('AI-04 plain exact Ed25519 signed receipt admits one disposable effect',async()=>{
  const f=fixture();let effects=0;
  assert.equal(await f.gate.execute(f.request,async()=>++effects),1);
  assert.equal(effects,1);
  assert.deepEqual(f.counts,{begin:1,commit:1,release:1,getterReads:0});
});

for(const stage of ['reserve','commit'] as const){
  for(const kind of ['accessor','inherited','proxy','extra-own-key',
    'symbol-key'] as const){
    test('AI-04 reject hostile '+kind+' receipt object at '+stage,async()=>{
      const f=fixture({stage,kind});let effects=0;
      await assert.rejects(f.gate.execute(f.request,async()=>++effects),
        {code:'DISPATCH_PROOF_INVALID'});
      assert.equal(effects,0);
      assert.equal(f.counts.getterReads,0,
        'never invoke property getter while validating signed receipt');
      assert.equal(f.counts.begin,1);
      assert.equal(f.counts.commit,stage==='reserve'?0:1);
      // Once the remote admission has been committed, only the original
      // reservation may be released, never a fallback mutation.
      assert.equal(f.counts.release,stage==='reserve'?0:1);
      await assert.rejects(f.gate.execute({...f.request,requestId:randomUUID()},
        async()=>++effects),{code:'DISPATCH_REVOKE_PENDING'});
      assert.equal(effects,0);
    });
  }
}
