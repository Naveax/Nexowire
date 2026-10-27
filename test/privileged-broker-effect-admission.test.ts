import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeBrokerEffectOnce,
  type BrokerExternalEffectAdmission,
  type BrokerVerifiedEffectBinding,
  type BrokerEffectRequest,
} from '../src/agent/privileged-broker-effect-admission.js';

const op = 'de935b67-516b-411e-948b-37ae22072f41';
const capability = 'windows.firewall.control';
const input = {action:'enable',name:'only-fixture'};
const proof = (): BrokerVerifiedEffectBinding => ({
  ownerId:'owner_1',deviceId:'device_1',sessionId:'session_1',
  ownerEpoch:4,deviceEpoch:8,sessionEpoch:6,generation:9,
  highTokenProofId:'kernel_proof_opaque_v1',expiresAtMs:Date.now()+30_000,
});
type Phase = 'initial' | 'begin' | 'commit' | 'readback' | 'sync' | 'invoke';
function fixture() {
  const events: Phase[]=[];
  let current=proof();
  const admitted=new Set<string>();
  let ticketCount=0;
  let last:BrokerEffectRequest | undefined;
  const authority:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>{
      events.push(last?'readback':'initial'); return current;
    },
    begin:async(request)=>{
      events.push('begin');last=request;
      if(admitted.has(request.operationId))return null;
      return {state:'RESERVED',operationId:request.operationId,
        ticket:'only_a_nonproduction_test_fixture_ticket_012345'};
    },
    commit:async(request,ticket)=>{
      events.push('commit');ticketCount++;
      if(admitted.has(request.operationId))return null;
      admitted.add(request.operationId);
      return {state:'COMMITTED',operationId:request.operationId,ticket};
    },
    readVerifiedBindingNow:()=>{events.push('sync');return current;},
  };
  const run=(id:unknown=op)=>invokeBrokerEffectOnce(authority,id,capability,input,
    ()=>{events.push('invoke');return 'fixture-result';},()=>true);
  return {authority,events,run,mutate:(v:BrokerVerifiedEffectBinding)=>{current=v;},
    admitted,ticketCount};
}

test('no external CAS port, no stable operation ID, or invalid proof fails closed',async()=>{
  let invoked=0;
  for(const id of [op,undefined,'caller-can-retry',{}]){
    await assert.rejects(invokeBrokerEffectOnce(undefined,id,capability,input,
      ()=>{invoked++;return 'unsafe';},()=>true),
      (err:unknown)=>!!err&&typeof err==='object'&&'code' in err&&
        err.code==='BROKER_EFFECT_ADMISSION_REQUIRED');
  }
  const f=fixture();
  await assert.rejects(f.run('not-uuid'),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(invoked,0);assert.deepEqual(f.events,[]);
});

test('fixture CAS sequence is begin/commit/recheck/sync then exactly one callback',async()=>{
  const f=fixture();
  assert.equal(await f.run(),'fixture-result');
  assert.deepEqual(f.events,['initial','begin','commit','readback','sync','invoke']);
  assert.equal(f.ticketCount,1);
  await assert.rejects(f.run(),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(f.events.filter(x=>x==='invoke').length,1);
});

test('lost ACK denies without callback and same operation cannot replay',async()=>{
  const f=fixture();
  f.authority.commit=async(req,ticket)=>{
    f.admitted.add(req.operationId);
    throw new Error('COMMIT_LOST_ACK');
  };
  let effects=0;
  await assert.rejects(invokeBrokerEffectOnce(f.authority,op,capability,input,
    ()=>{effects++;return true;},()=>true),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  await assert.rejects(invokeBrokerEffectOnce(f.authority,op,capability,input,
    ()=>{effects++;return true;},()=>true),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(effects,0);
});

test('revoke, epoch rollover, stale HIGH and expiry after async commit deny',async()=>{
  for(const mutate of [
    (b:BrokerVerifiedEffectBinding)=>({...b,sessionEpoch:b.sessionEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,ownerEpoch:b.ownerEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,deviceEpoch:b.deviceEpoch+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,generation:b.generation+1}),
    (b:BrokerVerifiedEffectBinding)=>({...b,highTokenProofId:'kernel_proof_replaced'}),
    (b:BrokerVerifiedEffectBinding)=>({...b,expiresAtMs:Date.now()-1}),
  ]){
    const f=fixture(),original=f.authority.commit.bind(f.authority);
    f.authority.commit=async(req,ticket)=>{const result=await original(req,ticket);
      f.mutate(mutate(req.binding));return result;};
    await assert.rejects(f.run(),/BROKER_EFFECT_ADMISSION_REQUIRED/);
    assert.equal(f.events.includes('invoke'),false);
  }
});

test('fresh sync readback rejects changes after last async verification',async()=>{
  const f=fixture();
  f.authority.readVerifiedBindingNow=()=>{f.events.push('sync');
    return {...proof(),ownerEpoch:10};};
  await assert.rejects(f.run(),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(f.events.includes('invoke'),false);
});

test('stale elevation proof at synchronous callback edge denies',async()=>{
  const f=fixture();
  let invoked=false;
  await assert.rejects(invokeBrokerEffectOnce(f.authority,op,capability,input,
    ()=>{invoked=true;},()=>false),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(invoked,false);
});

test('external CAS RESERVED/COMMITTED forged or unknown ACK cannot authorize',async()=>{
  const f=fixture();
  f.authority.begin=async()=>null;
  await assert.rejects(f.run(),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(f.events.includes('invoke'),false);
  const g=fixture();
  g.authority.commit=async()=>null;
  await assert.rejects(g.run(),/BROKER_EFFECT_ADMISSION_REQUIRED/);
  assert.equal(g.events.includes('invoke'),false);
});

test('provider-side errors are redacted, no callback fallback',async()=>{
  const f=fixture();
  f.authority.readVerifiedBinding=async()=>{throw new Error('sensitive OS path');};
  await assert.rejects(f.run(),
    (e:unknown)=>e instanceof Error&&e.message==='BROKER_EFFECT_ADMISSION_REQUIRED');
  assert.equal(f.events.includes('invoke'),false);
});

test('Broker HTTP route fences native/injected callback, installer and update before dispatch', {
  skip:process.platform !== 'win32',
},async()=>{
  const {startPrivilegedBroker}=await import('../src/agent/privileged-broker.js');
  const kinds=[
    'windows.firewall.control',
    'windows.installer.apply',
    'nexowire.machine_update.apply',
  ];
  for(const kind of kinds) {
    const f=fixture();
    let callbackCount=0;
    const broker=await startPrivilegedBroker({
      host:'127.0.0.1',port:0,tokens:['fixture-only-broker-token'],
      requireElevation:false, // non-production synthetic test server
      effectAdmission:f.authority,
      execute:async()=>{callbackCount++;return {executed:true};},
    });
    try {
      const send=(operation_id?:unknown)=>
        fetch(broker.url+'/execute',{
          method:'POST',
          headers:{authorization:'Bearer fixture-only-broker-token',
            'content-type':'application/json'},
          body:JSON.stringify({capability:kind,input,operation_id}),
        });
      const missing=await send();
      assert.equal(missing.status,400);
      assert.equal((await missing.json() as {error?:{code:string}}).error?.code,
        'BROKER_EFFECT_ADMISSION_REQUIRED');
      assert.equal(callbackCount,0);

      const first=await send(op);
      assert.equal(first.status,200,kind);
      assert.equal((await first.json() as {ok:boolean}).ok,true);
      assert.equal(callbackCount,1);

      const duplicate=await send(op);
      assert.equal(duplicate.status,400);
      assert.equal((await duplicate.json() as {error?:{code:string}}).error?.code,
        'BROKER_EFFECT_ADMISSION_REQUIRED');
      assert.equal(callbackCount,1,'same operation ID cannot replay '+kind);

      assert.deepEqual(f.events.slice(0,6),
        ['initial','begin','commit','readback','sync','invoke']);
    } finally {
      await broker.close();
    }
  }
});
