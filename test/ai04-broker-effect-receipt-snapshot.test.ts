/** AI-04 disposable Ed25519 receipt fixture: NOT protected native OS/CAS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {invokeBrokerEffectOnce,type BrokerExternalEffectAdmission,
  type BrokerEffectRequest,type BrokerEffectReceipt,
  type BrokerVerifiedEffectBinding,
} from '../src/agent/privileged-broker-effect-admission.js';
const keys=generateKeyPairSync('ed25519');
type Stage='reserve'|'commit';
type Variant='getter'|'binding-getter'|'proxy'|'binding-proxy'|'extra'|'binding-extra';
function fixture(hostile?:{stage:Stage;variant:Variant}){
  const scope:BrokerVerifiedEffectBinding={
    authorityId:'ai04_authority',ownerId:'ai04_owner',deviceId:'ai04_device',
    sessionId:'ai04_session',ownerEpoch:4,deviceEpoch:7,sessionEpoch:6,
    generation:9,highTokenProofId:'ai04_synthetic_high',
    protectedBrokerProofId:'ai04_synthetic_image',
    expiresAtMs:Date.now()+24000,
  };
  const counts={begin:0,commit:0,verify:0,effect:0,getter:0,trap:0};
  const ticket='ai04_receipt_only_fixture_ticket_0123456789';
  function issue(state:'RESERVED'|'COMMITTED',req:BrokerEffectRequest,
    nonce:string):BrokerEffectReceipt{
    const data={state,operationId:req.operationId,capability:req.capability,
      inputSha256:req.inputSha256,challengeNonce:nonce,ticket,
      binding:{...req.binding}};
    const signed=Buffer.from(JSON.stringify(data),'utf8');
    const receipt:BrokerEffectReceipt={...data,
      proof:sign(null,signed,keys.privateKey).toString('base64')};
    const stage=state==='RESERVED'?'reserve':'commit';
    if(hostile?.stage!==stage)return receipt;
    const proxy=<T extends object>(value:T)=>new Proxy(value,{
      get(){counts.trap++;throw Error('UNTRUSTED_GET')},
      getPrototypeOf(){counts.trap++;throw Error('UNTRUSTED_PROTOTYPE')},
      ownKeys(){counts.trap++;throw Error('UNTRUSTED_OWN_KEYS')},
    });
    switch(hostile.variant){
      case 'getter':
        Object.defineProperty(receipt,'state',{enumerable:true,
          get(){counts.getter++;return state}});
        return receipt;
      case 'binding-getter':
        Object.defineProperty(receipt.binding,'ownerId',{enumerable:true,
          get(){counts.getter++;return req.binding.ownerId}});
        return receipt;
      case 'proxy':return proxy(receipt);
      case 'binding-proxy':return {...receipt,binding:proxy(receipt.binding)};
      case 'extra':return {...receipt,unexpected:true} as BrokerEffectReceipt;
      case 'binding-extra':return {...receipt,
        binding:{...receipt.binding,unexpected:true}} as BrokerEffectReceipt;
    }
  }
  const authority:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>({...scope}),
    begin:async(req,nonce)=>{counts.begin++;return issue('RESERVED',req,nonce)},
    commit:async(req,given,nonce)=>{
      counts.commit++;assert.equal(given,ticket);
      return issue('COMMITTED',req,nonce);
    },
    verifyReceipt:async(receipt,wire)=>{
      counts.verify++;
      assert.ok(Object.isFrozen(receipt));
      assert.ok(Object.isFrozen(receipt.binding));
      const {proof:_proof,...payload}=receipt;
      assert.equal(JSON.stringify(payload),wire);
      return verify(null,Buffer.from(wire,'utf8'),keys.publicKey,
        Buffer.from(receipt.proof,'base64'));
    },
    readVerifiedBindingNow:()=>({...scope}),
  };
  return {counts,run:()=>invokeBrokerEffectOnce(authority,randomUUID(),
    'windows.ai04.fixture',{approved:true},
    ()=>{counts.effect++;return 'fixture-effect'},()=>true)};
}
test('AI-04 valid signed primitive receipt admits only disposable callback',async()=>{
  const f=fixture();
  assert.equal(await f.run(),'fixture-effect');
  assert.deepEqual(f.counts,{begin:1,commit:1,verify:2,effect:1,getter:0,trap:0});
});
for(const stage of ['reserve','commit'] as const){
  for(const variant of ['getter','binding-getter','proxy',
    'binding-proxy','extra','binding-extra'] as const){
    test('AI-04 hostile '+variant+' at '+stage+' denies before effect',async()=>{
      const f=fixture({stage,variant});
      await assert.rejects(f.run(),{code:'BROKER_EFFECT_ADMISSION_REQUIRED'});
      assert.equal(f.counts.effect,0);
      assert.equal(f.counts.getter,0);
      assert.equal(f.counts.trap,0);
      assert.equal(f.counts.begin,1);
      assert.equal(f.counts.commit,stage==='reserve'?0:1);
      assert.equal(f.counts.verify,stage==='reserve'?0:1);
    });
  }
}
