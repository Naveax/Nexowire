/**
 * #01 actual executeDurableRunbook source boundary. All callbacks are
 * synthetic counters; no Agent/Broker/Hub/OS/VM, network or real CAS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook,RunbookAdmissionRequiredError}
  from '../src/agent/runbooks.js';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp(path.join(os.tmpdir(),'nx01-runbook-deny-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new RunbookStore({stateFile:path.join(root,'runbook.json')});
  await store.initialize();
  let dispatches=0;
  const callbacks={
    runTaskGraph:async()=>{
      dispatches++;
      throw Object.assign(new Error('synthetic native ACK lost'),
        {code:'MUTATION_STATE_UNKNOWN'});
    },
    runAssertions:async()=>({data:{ok:true,passed:1,failed:0}}),
  };
  const steps=[{id:'logical-mutation',kind:'task_graph' as const,
    task_graph:{jobs:[{id:'write',kind:'shell.exec',
      command:'not-executed'}]}}];
  return {store,steps,callbacks,dispatched:()=>dispatches};
}
test('actual runbook pre-dispatch fails closed without external authority',async t=>{
  const f=await fixture(t);
  const value=await executeDurableRunbook({
    runbook_id:'original-runbook',steps:f.steps,
  },f.store,f.callbacks) as {data:{
    ok:boolean;summary:{unknown:number;failed:number};
    steps:Array<{status:string;errorCode?:string}>}};
  assert.equal(value.data.ok,false);
  assert.equal(value.data.summary.unknown,1);
  assert.equal(value.data.summary.failed,0);
  assert.equal(value.data.steps[0]?.status,'unknown');
  assert.equal(value.data.steps[0]?.errorCode,'RECONCILE_REQUIRED');
  assert.equal(f.dispatched(),0);
  assert.equal(f.store.get('original-runbook').steps[0]?.errorCode,
    'RECONCILE_REQUIRED');
});
test('cloned runbook_id cannot re-dispatch synthetic effect after UNKNOWN',async t=>{
  const f=await fixture(t);
  for(const runbook_id of ['original-task','clone-of-same-task']){
    const value=await executeDurableRunbook({
      runbook_id,steps:f.steps,resume:false,retry_unknown:false,
    },f.store,f.callbacks) as {data:{
      ok:boolean;summary:{unknown:number};
      steps:Array<{errorCode?:string}>}};
    assert.equal(value.data.ok,false);
    assert.equal(value.data.summary.unknown,1);
    assert.equal(value.data.steps[0]?.errorCode,'RECONCILE_REQUIRED');
  }
  assert.equal(f.dispatched(),0);
  assert.notEqual(f.store.get('original-task').steps[0]?.taskGraphId,
    f.store.get('clone-of-same-task').steps[0]?.taskGraphId);
});
test('retry_unknown cannot reset original UNKNOWN provenance before admission',async t=>{
  const f=await fixture(t);
  await executeDurableRunbook({
    runbook_id:'persisted-unknown',steps:f.steps,
  },f.store,f.callbacks);
  const before=f.store.get('persisted-unknown');
  await assert.rejects(executeDurableRunbook({
    runbook_id:'persisted-unknown',steps:f.steps,
    resume:true,retry_unknown:true,
  },f.store,f.callbacks),e=>
    e instanceof RunbookAdmissionRequiredError&&
    e.code==='RECONCILE_REQUIRED');
  const after=f.store.get('persisted-unknown');
  assert.equal(after.runCount,before.runCount);
  assert.equal(after.steps[0]?.status,'unknown');
  assert.equal(after.steps[0]?.errorCode,'RECONCILE_REQUIRED');
  assert.equal(f.dispatched(),0);
});
test('retry_failed cannot erase a historical lost-ACK errorCode',async t=>{
  const f=await fixture(t);
  await executeDurableRunbook({
    runbook_id:'historical-unknown',steps:f.steps,
  },f.store,f.callbacks);
  const existing=f.store.get('historical-unknown');
  existing.steps[0]!.status='failed';
  existing.steps[0]!.errorCode='MUTATION_STATE_UNKNOWN';
  existing.status='failed';
  await f.store.save(existing);
  await assert.rejects(executeDurableRunbook({
    runbook_id:'historical-unknown',steps:f.steps,
    resume:true,retry_failed:true,
  },f.store,f.callbacks),e=>
    e instanceof RunbookAdmissionRequiredError&&
    e.code==='RECONCILE_REQUIRED');
  assert.equal(f.store.get('historical-unknown').steps[0]?.errorCode,
    'MUTATION_STATE_UNKNOWN');
  assert.equal(f.dispatched(),0);
});
test('pure assertions remain read-only and need no native CAS dispatch',async t=>{
  const f=await fixture(t);
  const value=await executeDurableRunbook({
    runbook_id:'read-only-assertions',steps:[{
      id:'verify',kind:'assertions',
      assertions:{assertions:[{kind:'file.exists',path:'none'}]},
    }],
  },f.store,f.callbacks) as {data:{ok:boolean;summary:{succeeded:number}}};
  assert.equal(value.data.ok,true);
  assert.equal(value.data.summary.succeeded,1);
  assert.equal(f.dispatched(),0);
});
