import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeBrokerEffectOnce,
  type BrokerExternalEffectAdmission,
  type BrokerVerifiedEffectBinding,
  type BrokerEffectRequest,
  type BrokerEffectReceipt,
} from '../src/agent/privileged-broker-effect-admission.js';

const op='de935b67-516b-411e-948b-37ae22072f41';
const capability='windows.firewall.control';
const input={action:'enable',name:'only-fixture'};
const proof=():BrokerVerifiedEffectBinding=>({
  authorityId:'authority_fixture',ownerId:'owner_1',deviceId:'device_1',
  sessionId:'session_1',ownerEpoch:4,deviceEpoch:8,sessionEpoch:6,
  generation:9,highTokenProofId:'kernel_proof_opaque_v1',
  protectedBrokerProofId:'protected_image_opaque_v1',
  expiresAtMs:Date.now()+24_000,
});
const deny=(e:unknown)=>e instanceof Error &&
  'code' in e && e.code==='BROKER_EFFECT_ADMISSION_REQUIRED';
function fixture() {
  const events:string[]=[];
  let current=proof();
  const committed=new Set<string>();
  const challenges:string[]=[];
  let lastRequest:BrokerEffectRequest|undefined;
  let reserveReceipt:BrokerEffectReceipt|undefined;
  let commitReceipt:BrokerEffectReceipt|undefined;
  const ticket='test_fixture_nonce_bound_ticket_0123456789';
  const receipt=(state:'RESERVED'|'COMMITTED',req:BrokerEffectRequest,
    challengeNonce:string):BrokerEffectReceipt=>({
      state,operationId:req.operationId,capability:req.capability,
      inputSha256:req.inputSha256,challengeNonce,ticket,binding:{...req.binding},
      proof:'signed_fixture_only_not_a_real_signature',
    });
  const authority:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>{
      events.push(lastRequest?'readback':'initial');
      return {...current};
    },
    begin:async(req,nonce)=>{
      events.push('begin');lastRequest=req;challenges.push(nonce);
      if(committed.has(req.operationId))return null;
      reserveReceipt=receipt('RESERVED',req,nonce);return reserveReceipt;
    },
    commit:async(req,issuedTicket,nonce)=>{
      events.push('commit');challenges.push(nonce);
      if(committed.has(req.operationId)||issuedTicket!==ticket)return null;
      committed.add(req.operationId);
      commitReceipt=receipt('COMMITTED',req,nonce);return commitReceipt;
    },
    verifyReceipt:async()=>{
      events.push('verify');return true;
    },
    readVerifiedBindingNow:()=>{events.push('sync');return {...current};},
  };
  const run=(id:unknown=op,raw:unknown=input)=>
    invokeBrokerEffectOnce(authority,id,capability,raw,
      (verifiedInput)=>{events.push('invoke');return verifiedInput;},()=>true);
  return {authority,events,run,challenges,committed,
    get reserveReceipt(){return reserveReceipt;},
    get commitReceipt(){return commitReceipt;},
    get lastRequest(){return lastRequest;},
    setBinding:(b:BrokerVerifiedEffectBinding)=>{current=b;},
  };
}

test('no external authority, missing UUID, malformed proof or input denies',async()=>{
  let invoked=0;
  for(const id of [op,undefined,'caller-can-retry',{}]){
    await assert.rejects(invokeBrokerEffectOnce(undefined,id,capability,input,
      ()=>{invoked++;return true;},()=>true),deny);
  }
  const f=fixture();
  await assert.rejects(f.run('not-a-uuid'),deny);
  const bad={...proof(),protectedBrokerProofId:''};
  f.setBinding(bad);
  await assert.rejects(f.run(),deny);
  assert.equal(invoked,0);
  assert.deepEqual(f.events,['initial']);
});

test('external fixture reserve/commit use distinct 256-bit nonce and exact scope',async()=>{
  const f=fixture();
  assert.deepEqual(await f.run(),input);
  assert.deepEqual(f.events,
    ['initial','begin','verify','commit','verify','readback','sync','invoke']);
  assert.equal(f.challenges.length,2);
  assert.match(f.challenges[0]!,/^[0-9a-f]{64}$/);
  assert.match(f.challenges[1]!,/^[0-9a-f]{64}$/);
  assert.notEqual(f.challenges[0],f.challenges[1]);
  assert.equal(f.lastRequest?.binding.generation,9);
  assert.equal(f.lastRequest?.binding.sessionId,'session_1');
  assert.equal(f.reserveReceipt?.inputSha256,f.commitReceipt?.inputSha256);
  await assert.rejects(f.run(),deny);
  assert.equal(f.events.filter(x=>x==='invoke').length,1);
});

test('lost begin/commit ACK or provider error never reaches a callback',async()=>{
  for(const stage of ['begin','commit','verify'] as const) {
    const f=fixture();
    if(stage==='begin')f.authority.begin=async(req)=>{
      f.committed.add(req.operationId);
      throw Error('BEGIN_ACK_UNKNOWN_AFTER_RESERVE');
    };
    if(stage==='commit')f.authority.commit=async(req)=>{
      f.committed.add(req.operationId);
      throw Error('COMMIT_ACK_UNKNOWN_AFTER_COMMIT');
    };
    if(stage==='verify')f.authority.verifyReceipt=async()=>{throw Error('SIGNATURE_MISSING');};
    await assert.rejects(f.run(),deny);
    await assert.rejects(f.run(),deny);
    assert.equal(f.events.includes('invoke'),false);
  }
});

test('replayed signed reserve and commit receipts fail fresh challenge',async()=>{
  const f=fixture();
  await f.run();
  const oldReserve=f.reserveReceipt!;
  const oldCommit=f.commitReceipt!;
  const g=fixture();
  g.authority.begin=async()=>oldReserve;
  await assert.rejects(g.run(),deny);
  assert.equal(g.events.includes('invoke'),false);
  const h=fixture();
  h.authority.commit=async()=>oldCommit;
  await assert.rejects(h.run(),deny);
  assert.equal(h.events.includes('invoke'),false);
});

test('receipt must exactly bind capability, fingerprint, ticket and current epochs',async()=>{
  for(const tamper of [
    (r:BrokerEffectReceipt)=>({...r,capability:'windows.task.control'}),
    (r:BrokerEffectReceipt)=>({...r,inputSha256:'0'.repeat(64)}),
    (r:BrokerEffectReceipt)=>({...r,operationId:'1e935b67-516b-411e-948b-37ae22072f41'}),
    (r:BrokerEffectReceipt)=>({...r,ticket:'mismatched_fixture_ticket_0123456789'}),
    (r:BrokerEffectReceipt)=>({...r,binding:{...r.binding,generation:11}}),
    (r:BrokerEffectReceipt)=>({...r,binding:{...r.binding,ownerId:'other_owner'}}),
    (r:BrokerEffectReceipt)=>({...r,binding:{...r.binding,protectedBrokerProofId:'other_protected_id'}}),
  ]) {
    const f=fixture(),commit=f.authority.commit.bind(f.authority);
    f.authority.commit=async(req,ticket,nonce)=>{
      const receipt=await commit(req,ticket,nonce);
      return receipt?tamper(receipt):null;
    };
    await assert.rejects(f.run(),deny);
    assert.equal(f.events.includes('invoke'),false);
  }
});

test('a receipt is not authorized by matching strings without verification',async()=>{
  const f=fixture();
  f.authority.verifyReceipt=async()=>false;
  await assert.rejects(f.run(),deny);
  assert.equal(f.events.includes('invoke'),false);
});

test('revoked generation, device/session/owner epochs and HIGH proof reject after awaits',async()=>{
  for(const mutate of [
    (b:BrokerVerifiedEffectBinding)=>({...b,ownerEpoch:b.ownerEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,deviceEpoch:b.deviceEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,sessionEpoch:b.sessionEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,generation:b.generation+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,highTokenProofId:'stale_high'}),
    (b:BrokerVerifiedEffectBinding)=>({...b,protectedBrokerProofId:'untrusted_image'}),
    (b:BrokerVerifiedEffectBinding)=>({...b,expiresAtMs:Date.now()-10}),
  ]) {
    const f=fixture(),before=f.authority.commit.bind(f.authority);
    f.authority.commit=async(req,ticket,nonce)=>{
      const result=await before(req,ticket,nonce);
      f.setBinding(mutate(req.binding));
      return result;
    };
    await assert.rejects(f.run(),deny);
    assert.equal(f.events.includes('invoke'),false);
  }
});

test('fresh synchronous readback and final elevation check prevent dispatch',async()=>{
  const f=fixture();
  f.authority.readVerifiedBindingNow=()=>({...proof(),generation:10});
  await assert.rejects(f.run(),deny);
  assert.equal(f.events.includes('invoke'),false);
  const g=fixture();
  let invoked=0;
  await assert.rejects(invokeBrokerEffectOnce(g.authority,op,capability,input,
    ()=>{invoked++;return true;},()=>false),deny);
  assert.equal(invoked,0);
});

test('callback consumes exactly fingerprinted immutable snapshot under async mutation',async()=>{
  const f=fixture(),original={command:'approved',args:['safe']};
  const begin=f.authority.begin.bind(f.authority);
  f.authority.begin=async(req,nonce)=>{
    original.command='tampered';
    original.args.push('unexpected');
    return begin(req,nonce);
  };
  const result=await f.run(op,original) as {command:string;args:string[]};
  assert.deepEqual(result,{command:'approved',args:['safe']});
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.args),true);
  assert.equal(f.lastRequest?.inputSha256,f.commitReceipt?.inputSha256);
});

test('fixture sees independent operation UUID per effect boundary',async()=>{
  const f=fixture();
  assert.deepEqual(await f.run(),input);
  const later='89615b67-516b-411e-948b-37ae22072f41';
  assert.deepEqual(await f.run(later),input);
  assert.equal(f.events.filter(x=>x==='invoke').length,2);
  await assert.rejects(f.run(later),deny);
});

test('Broker HTTP route gates native, injected, installer, updater and no-provider', {
  skip:process.platform!=='win32',
},async()=>{
  const {startPrivilegedBroker}=await import('../src/agent/privileged-broker.js');
  for(const kind of ['windows.firewall.control','windows.environment.set',
    'windows.installer.apply','nexowire.machine_update.apply']) {
    // The machine scope is elevated; a user-scoped environment edit is not.
    // Exercise each classification without weakening the Broker admission gate.
    const privilegedInput=kind==='windows.environment.set'
      ? {...input,scope:'machine'} : input;
    const f=fixture();
    let invoked=0;
    const broker=await startPrivilegedBroker({
      host:'127.0.0.1',port:0,tokens:['fixture-only-broker-token'],
      requireElevation:false, // test-only synthetic server, not deployment
      effectAdmission:f.authority,
      execute:async(_capability,verifiedInput)=>{
        invoked++;
        return {accepted:verifiedInput};
      },
    });
    const send=(operation_id:unknown,payload:unknown=privilegedInput)=>
      fetch(broker.url+'/execute',{method:'POST',
        headers:{authorization:'Bearer fixture-only-broker-token',
          'content-type':'application/json'},
        body:JSON.stringify({capability:kind,input:payload,operation_id})});
    try {
      if(kind==='windows.environment.set'){
        const standard=await send(undefined,input);
        assert.equal(standard.status,400);
        assert.equal((await standard.json() as {error:{code:string}}).error.code,
          'PRIVILEGED_BROKER_NOT_REQUIRED');
        assert.equal(invoked,0);
      }
      for(const bad of [undefined,'bearer-only',null]){
        const denied=await send(bad);
        assert.equal(denied.status,400);
        assert.equal((await denied.json() as {error:{code:string}}).error.code,
          'BROKER_EFFECT_ADMISSION_REQUIRED');
      }
      assert.equal(invoked,0);
      const first=await send(op);
      assert.equal(first.status,200,kind);
      assert.equal((await first.json() as {ok:boolean}).ok,true);
      assert.equal(invoked,1);
      const replay=await send(op);
      assert.equal(replay.status,400);
      assert.equal(invoked,1);
    }finally{await broker.close();}
  }
});
