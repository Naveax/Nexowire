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
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
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

test('capability registry does not classify arbitrary shell task graphs as read-only',()=>{
  assert.equal(isReadOnlyCapability('verify.assertions'),true);
  assert.equal(isReadOnlyCapability('task.graph.run'),false);
  assert.equal(isReadOnlyCapability('shell.exec'),false);
});
test('assertion-only checkpoint with interrupted status safely resumes read-only work',async t=>{
  const f=await fixture(t);
  let reads=0;
  const steps=[{id:'probe',kind:'assertions' as const,
    assertions:{assertions:[{id:'check',kind:'file.exists',path:'none'}]}}];
  const callbacks={...f.callbacks,runAssertions:async()=>{
    reads++;
    return {data:{ok:true,passed:1,failed:0}};
  }};
  await executeDurableRunbook({runbook_id:'read-only-restart',steps},
    f.store,callbacks);
  const interrupted=f.store.get('read-only-restart');
  assert.equal(interrupted.steps[0]?.status,'succeeded');
  interrupted.status='interrupted';
  interrupted.steps[0]!.status='unknown';
  await f.store.save(interrupted);
  const resumed=await executeDurableRunbook({
    runbook_id:'read-only-restart',steps,resume:true,
    retry_unknown:true,
  },f.store,callbacks) as {data:{ok:boolean,summary:{succeeded:number}}};
  assert.equal(resumed.data.ok,true);
  assert.equal(resumed.data.summary.succeeded,1);
  assert.equal(reads,2);
  assert.equal(f.dispatched(),0);
});
test('mixed runbook preserves independent assertions while shell graph fails closed',async t=>{
  const f=await fixture(t);
  let assertions=0;
  const steps=[
    {id:'inspect',kind:'assertions' as const,
      assertions:{assertions:[{id:'verify',kind:'file.exists',path:'none'}]}},
    {id:'compile',kind:'task_graph' as const,
      task_graph:{jobs:[{id:'cmd',command:'echo build'}]}},
    {id:'dependent',kind:'assertions' as const,
      depends_on:['compile'],
      assertions:{assertions:[{id:'after',kind:'file.exists',path:'none'}]}},
  ];
  const callbacks={...f.callbacks,runAssertions:async()=>{
    assertions++;
    return {data:{ok:true,passed:1,failed:0}};
  }};
  const value=await executeDurableRunbook({
    runbook_id:'mixed-readonly-and-shell',steps,
  },f.store,callbacks) as {data:{
    ok:boolean,summary:{succeeded:number,unknown:number,blocked:number},
    steps:Array<{id:string,status:string,errorCode?:string}>}};
  assert.equal(value.data.ok,false);
  assert.equal(value.data.summary.succeeded,1);
  assert.equal(value.data.summary.unknown,1);
  assert.equal(value.data.summary.blocked,1);
  assert.equal(assertions,1);
  assert.equal(f.dispatched(),0);
  assert.equal(value.data.steps.find(x=>x.id==='compile')?.errorCode,
    'RECONCILE_REQUIRED');
  assert.equal(value.data.steps.find(x=>x.id==='dependent')?.status,
    'blocked');
});
test('benign-looking shell output is still not a provably read-only task graph',async t=>{
  const f=await fixture(t);
  const candidateCommands=['echo build','cat README.md','Get-Content README.md'];
  for(const [i,command] of candidateCommands.entries()){
    const result=await executeDurableRunbook({
      runbook_id:'unknown-shell-'+i,
      steps:[{id:'probe',kind:'task_graph',task_graph:{
        jobs:[{id:'inspect-looking',command}],
      }}],
    },f.store,f.callbacks) as {data:{
      ok:boolean,summary:{unknown:number},
      steps:Array<{errorCode?:string}>}};
    assert.equal(result.data.ok,false);
    assert.equal(result.data.summary.unknown,1);
    assert.equal(result.data.steps[0]?.errorCode,'RECONCILE_REQUIRED');
  }
  assert.equal(f.dispatched(),0);
});
test('mixed-runbook retry cannot reset shell UNKNOWN or its original evidence',async t=>{
  const f=await fixture(t);
  const steps=[
    {id:'inspect',kind:'assertions' as const,
      assertions:{assertions:[{id:'check',kind:'file.exists',path:'none'}]}},
    {id:'mutate',kind:'task_graph' as const,
      task_graph:{jobs:[{id:'cmd',command:'echo benign-looking'}]}},
  ];
  await executeDurableRunbook({
    runbook_id:'mixed-original-unknown',steps,
  },f.store,f.callbacks);
  const before=f.store.get('mixed-original-unknown');
  assert.equal(before.steps.find(x=>x.id==='mutate')?.errorCode,
    'RECONCILE_REQUIRED');
  await assert.rejects(executeDurableRunbook({
    runbook_id:'mixed-original-unknown',steps,resume:true,
    retry_unknown:true,
  },f.store,f.callbacks),e=>
    e instanceof RunbookAdmissionRequiredError&&
    e.code==='RECONCILE_REQUIRED');
  const after=f.store.get('mixed-original-unknown');
  assert.deepEqual(after.steps,before.steps);
  assert.equal(after.runCount,before.runCount);
  assert.equal(f.dispatched(),0);
});
