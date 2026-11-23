import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeBrokerEffectOnce,type BrokerExternalEffectAdmission}
  from '../../src/agent/privileged-broker-effect-admission.js';
import {CoreConsoleAdmission} from '../../src/agent/core-console-admission.js';
import {prepareCoreWindowsMutation}
  from '../../src/agent/core-windows-mutation-dispatch.js';

// Deliberately load AI-03's root-level suites: the repository's legacy
// npm test glob (test/**/*.test.ts) otherwise omits direct test/*.test.ts.
// This is scoped coverage, not a replacement for AI-08 full test discovery.
import '../core-console-admission.test.js';
import '../privileged-broker-effect-admission.test.js';

const id='de935b67-516b-411e-948b-37ae22072f41';
const denied=(code:string)=>(e:unknown)=>e instanceof Error &&
  'code' in e && e.code===code;

test('AI-03 discoverable smoke: Broker input never executes a getter or enters CAS',async()=>{
  let inspected=0,getters=0,effects=0;
  const authority:BrokerExternalEffectAdmission={
    readVerifiedBinding:async()=>{inspected++;return null;},
    begin:async()=>null,commit:async()=>null,
    verifyReceipt:async()=>false,readVerifiedBindingNow:()=>null,
  };
  const malicious=Object.defineProperty({action:'enable'},'detail',{
    enumerable:true,get(){getters++;return 'attack';},
  });
  await assert.rejects(invokeBrokerEffectOnce(authority,id,
    'windows.firewall.control',malicious,
    ()=>{effects++;return true;},()=>true),
  denied('BROKER_EFFECT_ADMISSION_REQUIRED'));
  assert.equal(getters,0);
  assert.equal(inspected,0);
  assert.equal(effects,0);
});

test('AI-03 discoverable smoke: CORE console blocks custom toJSON before native provider',async()=>{
  let serialized=0;
  const raw={action:'click',toJSON(){serialized++;return {action:'click'};}};
  const controller=new CoreConsoleAdmission();
  await assert.rejects(controller.execute(
    'windows.pointer.click',raw,id,'full'),
  denied('CORE_CONSOLE_INPUT_NOT_CANONICAL'));
  assert.equal(serialized,0);
});

test('AI-03 discoverable smoke: ordinary JSON snapshots remain immutable and faithful',()=>{
  const original={kind:'safe',data:{points:[1,2,3]}};
  const p=prepareCoreWindowsMutation('windows.pointer.click',original);
  assert.deepEqual(JSON.parse(JSON.stringify(p.input)),original);
  assert.equal(Object.isFrozen(p.input),true);
  assert.equal(Object.isFrozen((p.input as typeof original).data.points),true);
  original.data.points.push(4);
  assert.deepEqual(JSON.parse(JSON.stringify(p.input)),{kind:'safe',data:{points:[1,2,3]}});
});
