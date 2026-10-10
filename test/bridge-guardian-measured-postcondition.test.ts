import test from 'node:test';
import assert from 'node:assert/strict';
import {
  measureGuardianBrokerPostcondition,
  type LocalBridgePostconditionCollectors,
} from '../src/agent/bridge-guardian-measured-postcondition.js';

const intent=(desiredMode:'auto'|'on'|'off'='on')=>({
  type:'admin-bridge.mode-intent' as const,version:1 as const,
  requestId:'11111111-1111-4111-8111-111111111111',
  deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:'a'.repeat(64),desiredMode,
  issuedAt:'2026-10-10T15:00:00.000Z',
  expiresAt:'2026-10-10T15:02:00.000Z',
});
const task=(state:'Running'|'Disabled'|'Ready'='Running')=>({
  installed:true,taskName:'Nexowire Privileged Broker',
  identityVerified:true,state,
});
const processState=(running=true,trigger=true)=>({
  complete:true,trustedCollector:true,
  brokerProcessCount:running?1:0,
  brokerListenerCount:running?1:0,
  listenerPort:43112,
  brokerProcessImageAndOwnerVerified:running,
  recoveryTriggerVerified:trigger,
});
const health=()=>({
  expectedVersion:'1.0.5',version:'1.0.5',
  reachable:true,elevated:true,ready:true,status:'READY',
});

function collectors(
  overrides:Partial<LocalBridgePostconditionCollectors>={},
):LocalBridgePostconditionCollectors {
  return {
    now:()=>new Date('2026-10-10T15:01:00.000Z'),
    readTask:async()=>task(),
    readProcessAndPort:async()=>processState(),
    readHealth:async()=>health(),
    ...overrides,
  };
}

test('ON requires canonical running task, protected process, listener and authenticated healthy Broker',async()=>{
  const result=await measureGuardianBrokerPostcondition(intent('on'),collectors());
  assert.equal(result.locallyMeasured,true);
  assert.equal(result.receipt.result,'applied');
  assert.equal(result.receipt.taskState,'Running');
  assert.equal(result.receipt.brokerHealth,'authenticated-ready');
  assert.equal(Object.isFrozen(result),true);
});

test('OFF requires disabled task AND independent absence of all broker processes and 43112 listeners',async()=>{
  const good=await measureGuardianBrokerPostcondition(intent('off'),collectors({
    readTask:async()=>task('Disabled'),
    readProcessAndPort:async()=>processState(false),
    readHealth:async()=>{throw new Error('OFF_MUST_NOT_INFER_FROM_HEALTH_TIMEOUT')},
  }));
  assert.equal(good.receipt.result,'applied');
  assert.equal(good.receipt.brokerHealth,'absent');
  assert.equal(good.locallyMeasured,true);
  for(const evidence of [
    task('Running'),
    task('Ready'),
  ]) {
    const notOff=await measureGuardianBrokerPostcondition(intent('off'),collectors({
      readTask:async()=>evidence,
      readProcessAndPort:async()=>processState(false),
    }));
    assert.equal(notOff.receipt.result,'failed');
  }
  for(const active of [
    {...processState(false),brokerListenerCount:1},
    {...processState(false),brokerProcessCount:1},
    {...processState(false),complete:false},
    {...processState(false),trustedCollector:false},
  ]) {
    const notOff=await measureGuardianBrokerPostcondition(intent('off'),collectors({
      readTask:async()=>task('Disabled'),
      readProcessAndPort:async()=>active,
    }));
    assert.equal(notOff.receipt.result,'failed');
    assert.equal(notOff.locallyMeasured,false);
  }
});

test('ON fails closed when task identity, live Broker or process provenance is untrusted',async()=>{
  const cases:Partial<LocalBridgePostconditionCollectors>[]=[
    {readTask:async()=>({...task(),taskName:'Foreign task'})},
    {readTask:async()=>({...task(),identityVerified:false})},
    {readTask:async()=>task('Ready')},
    {readTask:async()=>{throw new Error('ACCESS_DENIED')}},
    {readProcessAndPort:async()=>({...processState(),complete:false})},
    {readProcessAndPort:async()=>({...processState(),trustedCollector:false})},
    {readProcessAndPort:async()=>({...processState(),brokerProcessImageAndOwnerVerified:false})},
    {readProcessAndPort:async()=>({...processState(),brokerListenerCount:0})},
    {readProcessAndPort:async()=>({...processState(),brokerProcessCount:2})},
    {readProcessAndPort:async()=>({...processState(),listenerPort:0})},
    {readProcessAndPort:async()=>{throw new Error('AUDIT_DENIED')}},
    {readHealth:async()=>({...health(),elevated:false})},
    {readHealth:async()=>({...health(),ready:false})},
    {readHealth:async()=>({...health(),version:'wrong'})},
    {readHealth:async()=>{throw new Error('INVALID_SECRET')}},
  ];
  for(const overrides of cases) {
    const answer=await measureGuardianBrokerPostcondition(intent('on'),collectors(overrides));
    assert.equal(answer.receipt.result,'failed');
    assert.equal(answer.locallyMeasured,false);
    assert.match(answer.receipt.failureCode??'',/^[A-Z_]+$/);
  }
});

test('AUTO additionally needs independently verified recovery trigger',async()=>{
  const noTrigger=await measureGuardianBrokerPostcondition(intent('auto'),collectors({
    readProcessAndPort:async()=>processState(true,false),
  }));
  assert.equal(noTrigger.receipt.result,'failed');
  const withTrigger=await measureGuardianBrokerPostcondition(intent('auto'),collectors());
  assert.equal(withTrigger.receipt.result,'applied');
});

test('receipt cannot be measured past the short-lived command expiry or before issue',async()=>{
  for(const date of [
    '2026-10-10T15:02:00.000Z','2026-10-10T14:59:59.000Z',
  ]) {
    let called=false;
    await assert.rejects(measureGuardianBrokerPostcondition(intent(),collectors({
      now:()=>new Date(date),
      readTask:async()=>{called=true;return task()},
    })),/GUARDIAN_POSTCONDITION_EXPIRED_OR_INVALID/);
    assert.equal(called,false);
  }
});

test('OFF cannot claim success when the task or listener changes before the final read',async()=>{
  for(const variant of ['task-restarted','process-restarted','listener-reappears'] as const){
    let tasks=0,probes=0;
    const result=await measureGuardianBrokerPostcondition(intent('off'),collectors({
      readTask:async()=>++tasks===1?task('Disabled'):
        variant==='task-restarted'?task('Running'):task('Disabled'),
      readProcessAndPort:async()=>{
        probes++;
        if(probes===1)return processState(false);
        if(variant==='process-restarted')
          return {...processState(false),brokerProcessCount:1};
        if(variant==='listener-reappears')
          return {...processState(false),brokerListenerCount:1};
        return processState(false);
      },
    }));
    assert.equal(result.receipt.result,'failed',variant);
    assert.equal(result.locallyMeasured,false,variant);
    assert.equal(tasks,2);
    assert.equal(probes,2);
  }
});

test('ON rejects a task disappearing or failing the second authenticated process inventory',async()=>{
  for(const broken of ['changed-task','untrusted-inventory'] as const){
    let tasks=0,probes=0;
    const answer=await measureGuardianBrokerPostcondition(intent('on'),collectors({
      readTask:async()=>++tasks===1?task('Running'):broken==='changed-task'?
        task('Ready'):task('Running'),
      readProcessAndPort:async()=>++probes===1?processState():
        broken==='untrusted-inventory'?
          {...processState(),trustedCollector:false}:processState(),
    }));
    assert.equal(answer.receipt.result,'failed');
    assert.equal(answer.locallyMeasured,false);
  }
});

test('time expiry during slow collector never generates an applied receipt',async()=>{
  let reads=0;
  await assert.rejects(measureGuardianBrokerPostcondition(intent('on'),collectors({
    now:()=>new Date(++reads===1?
      '2026-10-10T15:01:59.000Z':'2026-10-10T15:02:00.000Z'),
  })),/GUARDIAN_POSTCONDITION_EXPIRED_OR_INVALID/);
  assert.equal(reads,2);
});

test('applied receipt uses final clock sample after independent second read',async()=>{
  let reads=0;
  const result=await measureGuardianBrokerPostcondition(intent('off'),collectors({
    now:()=>new Date(++reads===1?
      '2026-10-10T15:01:00.000Z':'2026-10-10T15:01:07.000Z'),
    readTask:async()=>task('Disabled'),
    readProcessAndPort:async()=>processState(false),
  }));
  assert.equal(result.receipt.result,'applied');
  assert.equal(result.receipt.observedAt,'2026-10-10T15:01:07.000Z');
  assert.equal(reads,2);
});

test('failed evidence is a failed receipt, never forged applied success',async()=>{
  const answer=await measureGuardianBrokerPostcondition(intent(),collectors({
    readHealth:async()=>({...health(),status:'NOT_ELEVATED'}),
  }));
  assert.equal(answer.receipt.result,'failed');
  assert.equal(answer.receipt.taskVerified,false);
  assert.equal(answer.receipt.brokerHealth,'unverified');
  assert.notEqual(answer.receipt.failureCode,null);
});
