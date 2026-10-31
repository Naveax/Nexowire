/** AI-08 synthetic signed-receipt QA; NEVER OS/Broker evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {
  invokeBrokerEffectOnce,
  type BrokerVerifiedEffectBinding,type BrokerEffectReceipt,type BrokerEffectRequest,
  type BrokerExternalEffectAdmission,
} from '../src/agent/privileged-broker-effect-admission.js';

const CAP='windows.firewall.control';
const ALTERNATE='windows.task.control';
const TICKET='ai08_synthetic_ticket_0123456789abcdef';
type Attack='none'|'reserve-scope'|'reserve-signature'|'commit-capability'|'lost-commit-ack'|'transport-post-snapshot-tamper';
function fixture(attack:Attack){
  const key=generateKeyPairSync('ed25519');
  const binding:BrokerVerifiedEffectBinding={
    authorityId:'ai08-authority',ownerId:'ai08-owner',deviceId:'ai08-device',
    sessionId:'ai08-session',ownerEpoch:3,deviceEpoch:4,sessionEpoch:5,
    generation:6,highTokenProofId:'ai08-high-synthetic',
    protectedBrokerProofId:'ai08-protected-synthetic',
    expiresAtMs:Date.now()+20_000,
  };
  let callbacks=0,remoteConsumes=0,verifiedPayloads=0,transportTampered=false;
  let transportReservation:BrokerEffectReceipt|undefined;
  const issued=(state:'RESERVED'|'COMMITTED',request:BrokerEffectRequest,
    challengeNonce:string):BrokerEffectReceipt=>{
    const payload={state,operationId:request.operationId,capability:request.capability,
      inputSha256:request.inputSha256,challengeNonce,ticket:TICKET,
      binding:{...request.binding}};
    const signedPayload=attack==='reserve-signature'&&state==='RESERVED'
      ?{...payload,capability:ALTERNATE}:payload;
    const proof=sign(null,Buffer.from(JSON.stringify(signedPayload)),key.privateKey).toString('base64');
    if(attack==='reserve-scope'&&state==='RESERVED')payload.binding.ownerId='foreign-owner';
    if(attack==='commit-capability'&&state==='COMMITTED')payload.capability=ALTERNATE;
    return {...payload,proof};
  };
  const admitted=new Set<string>();
  const adapter:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>({...binding}),
    readVerifiedBindingNow:()=>({...binding}),
    begin:async (req,nonce)=>{
      if(admitted.has(req.operationId))return null;
      admitted.add(req.operationId);
      const receipt=issued('RESERVED',req,nonce);
      if(attack==='transport-post-snapshot-tamper')transportReservation=receipt;
      return receipt;
    },
    commit:async(req,ticket,nonce)=>{
      if(ticket!==TICKET)return null;
      remoteConsumes++;
      if(attack==='lost-commit-ack')throw Error('synthetic ACK lost after consuming');
      return issued('COMMITTED',req,nonce);
    },
    verifyReceipt:async(receipt,signedPayloadUtf8)=>{
      verifiedPayloads++;
      if(attack==='transport-post-snapshot-tamper'&&verifiedPayloads===1){
        assert.ok(transportReservation);
        // The transport may mutate after returning its signed-looking object.
        // Verification MUST use a detached frozen snapshot, not the raw object.
        Object.assign(transportReservation.binding,{ownerId:'foreign-owner'});
        Object.assign(transportReservation,{capability:ALTERNATE});
        transportTampered=true;
        assert.equal(receipt.binding.ownerId,binding.ownerId);
        assert.equal(receipt.capability,CAP);
      }
      assert.ok(Object.isFrozen(receipt));
      assert.ok(Object.isFrozen(receipt.binding));
      const {proof:ignored,...signed}=receipt;
      assert.equal(JSON.stringify(signed),signedPayloadUtf8);
      return verify(null,Buffer.from(signedPayloadUtf8,'utf8'),key.publicKey,
        Buffer.from(receipt.proof,'base64'));
    },
  };
  const input={nested:{owner:binding.ownerId},seq:7};
  const operationId=randomUUID();
  const run=()=>invokeBrokerEffectOnce(adapter,operationId,CAP,input,verifiedInput=>{
    callbacks++;
    assert.equal((verifiedInput as typeof input).nested.owner,binding.ownerId);
    assert.equal((verifiedInput as typeof input).seq,7);
    return 'synthetic-executed';
  },()=>true);
  return {run,input,get callbacks(){return callbacks},
    get remoteConsumes(){return remoteConsumes},
    get verifiedPayloads(){return verifiedPayloads},
    get transportTampered(){return transportTampered}};
}

test('AI-08: receipt verifier receives an immutable, exact signed snapshot',async()=>{
  const f=fixture('none');
  assert.equal(await f.run(),'synthetic-executed');
  assert.equal(f.callbacks,1);
  assert.equal(f.remoteConsumes,1);
  assert.equal(f.verifiedPayloads,2);
  await assert.rejects(f.run(),'durably reserved operation ID cannot be replayed');
  assert.equal(f.callbacks,1);
});

for(const attack of ['reserve-scope','reserve-signature','commit-capability',
  'lost-commit-ack'] as const){
  test('AI-08: '+attack+' denies callback even after external side-effect uncertainty',async()=>{
    const f=fixture(attack);
    await assert.rejects(f.run());
    assert.equal(f.callbacks,0,'no local privileged callback is authorized');
    await assert.rejects(f.run(),'same request ID cannot recover a lost ACK');
    assert.equal(f.callbacks,0);
    if(attack==='lost-commit-ack')assert.equal(f.remoteConsumes,1);
  });
}

test('AI-08: detached input cannot be mutated across admission awaits',async()=>{
  const f=fixture('none');
  const begun=f.run();
  f.input.nested.owner='attacker-overwrite';
  f.input.seq=999;
  assert.equal(await begun,'synthetic-executed');
  assert.equal(f.callbacks,1);
});

test('AI-08: post-snapshot transport mutation cannot substitute signed Broker authority',async()=>{
  const f=fixture('transport-post-snapshot-tamper');
  assert.equal(await f.run(),'synthetic-executed');
  assert.equal(f.transportTampered,true,'the malicious transport really changed its raw fields');
  assert.equal(f.callbacks,1,'only the originally verified scope may execute');
  assert.equal(f.remoteConsumes,1);
  assert.equal(f.verifiedPayloads,2);
});
