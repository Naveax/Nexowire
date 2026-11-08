/** #11 adversarial QA only. All signatures, authority and effects are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {
  invokeBrokerEffectOnce,
  type BrokerExternalEffectAdmission,
  type BrokerEffectRequest,
  type BrokerEffectReceipt,
  type BrokerVerifiedEffectBinding,
} from '../src/agent/privileged-broker-effect-admission.js';

type Phase='RESERVED'|'COMMITTED';
function latch<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
const desired='windows.firewall.control';
const other='windows.task.control';
const ticket='synthetic_ticket_0123456789_abcdefgh';
const operation='de935b67-516b-411e-948b-37ae22072f41';
const bytes=(r:BrokerEffectReceipt)=>{
  const {proof,...payload}=r;
  return Buffer.from(JSON.stringify(payload));
};
function fixture(attack:Phase|null){
  const key=generateKeyPairSync('ed25519');
  const binding:BrokerVerifiedEffectBinding={
    authorityId:'fixture_authority',ownerId:'fixture_owner',deviceId:'fixture_device',
    sessionId:'fixture_session',ownerEpoch:1,deviceEpoch:1,sessionEpoch:1,generation:1,
    highTokenProofId:'fixture_high',protectedBrokerProofId:'fixture_broker',
    expiresAtMs:Date.now()+25_000,
  };
  const ready=latch<void>(),proceed=latch<void>(),verified=latch<void>(),finish=latch<void>();
  let issued:BrokerEffectReceipt|undefined,effects=0,consumed=false;
  const make=(state:Phase,req:BrokerEffectRequest,nonce:string)=>{
    const payload={
      state,operationId:req.operationId,capability:req.capability,
      inputSha256:req.inputSha256,challengeNonce:nonce,ticket,binding:{...req.binding},
    };
    // Only the *other* capability is signed for the attacked phase.
    const signed=attack===state?{...payload,capability:other}:payload;
    const proof=sign(null,Buffer.from(JSON.stringify(signed)),key.privateKey).toString('base64');
    const r:BrokerEffectReceipt={...payload,proof};
    if(state===attack)issued=r;
    return r;
  };
  const authority:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>({...binding}),
    readVerifiedBindingNow:()=>({...binding}),
    begin:async(req,nonce)=>consumed?null:make('RESERVED',req,nonce),
    commit:async(req,t,nonce)=>{
      if(consumed||t!==ticket)return null;
      consumed=true;
      return make('COMMITTED',req,nonce);
    },
    verifyReceipt:async receipt=>{
      if(receipt.state===attack){
        ready.resolve();
        await proceed.promise;
        // Honest verifier checks the signed bytes it observes at this instant.
        const valid=verify(null,bytes(receipt),key.publicKey,Buffer.from(receipt.proof,'base64'));
        verified.resolve();
        await finish.promise;
        return valid;
      }
      return verify(null,bytes(receipt),key.publicKey,Buffer.from(receipt.proof,'base64'));
    },
  };
  const run=()=>invokeBrokerEffectOnce(authority,operation,desired,{action:'fixture'},
    ()=>{effects++;return 'fixture-effect';},()=>true);
  return {run,ready,proceed,verified,finish,get issued(){return issued},get effects(){return effects}};
}

test('positive synthetic signed receipt for the exact capability can reach its fixture callback',async()=>{
  const f=fixture(null);
  assert.equal(await f.run(),'fixture-effect');
  assert.equal(f.effects,1);
});

for(const phase of ['RESERVED','COMMITTED'] as const){
  test('ABA receipt mutation during '+phase+' signature verification must deny', {timeout:5000},async()=>{
    const f=fixture(phase);
    const result=f.run().then(()=>({accepted:true}),()=>({accepted:false}));
    // A stricter implementation may deny before invoking the verifier.
    const entered=await Promise.race([f.ready.promise.then(()=>true),result.then(()=>false)]);
    if(entered){
      assert.ok(f.issued);
      // Mutate the transport-owned original while the verifier is awaiting,
      // then restore it before the outer post-verification check.
      const changed=Reflect.set(f.issued,'capability',other);
      f.proceed.resolve();
      await f.verified.promise;
      if(changed)Reflect.set(f.issued,'capability',desired);
      f.finish.resolve();
    }
    const observed=await result;
    assert.equal(f.effects,0,'synthetic side-effect callback must remain uncalled');
    assert.equal(observed.accepted,false,'mismatched signed capability reached admission');
  });
}
