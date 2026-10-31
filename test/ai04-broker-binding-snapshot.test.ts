import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeBrokerEffectOnce,
  type BrokerExternalEffectAdmission,
  type BrokerVerifiedEffectBinding,
  type BrokerEffectRequest,
  type BrokerEffectReceipt,
} from '../src/agent/privileged-broker-effect-admission.js';

// AI-04 disposable source-only provider. It deliberately bypasses real signature
// verification and cannot establish a genuine CORE, Windows, or CAS authority.
const operationId='b94a32c1-92ab-4f09-8b8e-c30a7f61b480';
const binding=():BrokerVerifiedEffectBinding=>({
  authorityId:'ai04_fixture',
  ownerId:'owner_original',deviceId:'device_original',sessionId:'session_original',
  ownerEpoch:2,deviceEpoch:3,sessionEpoch:4,generation:5,
  highTokenProofId:'not_a_kernel_attestation',
  protectedBrokerProofId:'not_a_signed_broker',
  expiresAtMs:Date.now()+24_000,
});
const denied=(error:unknown)=>error instanceof Error &&
  'code' in error && error.code==='BROKER_EFFECT_ADMISSION_REQUIRED';

type WitnessStage='initial'|'recent'|'immediate'|'none';
function harness(stage:WitnessStage){
  const plain=binding();
  let reads=0;
  let getterReads=0;
  let callbacks=0;
  const hostile={...plain};
  // The *first* read is still syntactically valid, but has the wrong scope.
  // Pre-fix: bindingValid consumes it, then spread/sameBinding consumes the
  // restored owner scope and authorizes execution. A single snapshot must
  // reject accessors before observing or invoking them.
  Object.defineProperty(hostile,'ownerId',{
    configurable:true,enumerable:true,
    get(){
      getterReads++;
      return getterReads%2===1?'owner_wrong_scope':plain.ownerId;
    },
  });
  const ticket='ai04_disposable_ticket_0123456789_abcdefgh';
  const receipt=(state:'RESERVED'|'COMMITTED',
    request:BrokerEffectRequest,nonce:string):BrokerEffectReceipt=>({
    state,operationId:request.operationId,
    capability:request.capability,inputSha256:request.inputSha256,
    challengeNonce:nonce,ticket,binding:{...request.binding},
    proof:'ai04_only_fixture_signature_not_valid',
  });
  const provider:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>{
      reads++;
      if((stage==='initial' && reads===1) ||
         (stage==='recent' && reads===2))return hostile;
      return {...plain};
    },
    begin:async(request,nonce)=>receipt('RESERVED',request,nonce),
    commit:async(request,usedTicket,nonce)=>
      usedTicket===ticket?receipt('COMMITTED',request,nonce):null,
    verifyReceipt:async()=>true,
    readVerifiedBindingNow:()=>stage==='immediate'?hostile:{...plain},
  };
  const run=()=>invokeBrokerEffectOnce(provider,operationId,
    'windows.ai04.fixture.effect',{value:'fixture'},
    ()=>{callbacks++;return true},()=>true);
  return {
    run,
    get callbackCount(){return callbacks},
    get getterCount(){return getterReads},
  };
}

test('AI-04 baseline: plain detached binding permits disposable callback',async()=>{
  const f=harness('none');
  assert.equal(await f.run(),true);
  assert.equal(f.callbackCount,1);
  assert.equal(f.getterCount,0);
});

for(const stage of ['initial','recent','immediate'] as const){
  test('AI-04 fail closed on owner scope accessor ABA at '+stage,async()=>{
    const f=harness(stage);
    await assert.rejects(f.run(),denied);
    assert.equal(f.callbackCount,0,'callback must not execute');
    assert.equal(f.getterCount,0,
      'OS witness accessor must not run during validation or comparison');
  });
}

test('AI-04 refuse a throwing witness proxy without native effect',async()=>{
  const f=harness('none');
  // A separate failing proxy simulates an untrusted/native-boundary exception.
  const valid=binding();
  const provider:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>new Proxy(valid,{
      getOwnPropertyDescriptor(){throw Error('UNTRUSTED_WITNESS');},
    }),
    begin:async()=>{assert.fail('begin must not run');},
    commit:async()=>{assert.fail('commit must not run');},
    verifyReceipt:async()=>{assert.fail('verify must not run');},
    readVerifiedBindingNow:()=>valid,
  };
  let called=0;
  await assert.rejects(invokeBrokerEffectOnce(provider,operationId,
    'windows.ai04.fixture.effect',{value:'fixture'},
    ()=>{called++;return true},()=>true),denied);
  assert.equal(called,0);
  assert.equal(f.callbackCount,0);
});
