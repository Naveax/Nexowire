import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';

test('runbook prepare rejects duplicate nested step IDs before journal admission',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-duplicate-step-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=path.join(dir,'runbooks.json');
 const store=new RunbookStore({stateFile:f});
 await store.initialize();
 await assert.rejects(store.prepare({id:'rb',specHash:'a'.repeat(64),
  steps:[{id:'repeat',kind:'task_graph',dependsOn:[]},
         {id:'repeat',kind:'assertions',dependsOn:[]}],
  resume:false,retryFailed:false,retryUnknown:false}),
  e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_DUPLICATE_STEP_ID');
 assert.equal(store.list().length,0);
});

test('task graph prepare rejects duplicate nested job IDs before journal admission',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-duplicate-job-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=path.join(dir,'graphs.json');
 const store=new TaskGraphStore({stateFile:f});
 await store.initialize();
 await assert.rejects(store.prepare({id:'g',specHash:'a'.repeat(64),
  jobs:[{id:'repeat',dependsOn:[]},{id:'repeat',dependsOn:[]}],
  resume:false,retryFailed:false,retryUnknown:false}),
  e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_DUPLICATE_JOB_ID');
 assert.equal(store.list().length,0);
});

test('runbook restore fails closed on nested duplicate steps without erasing UNKNOWN',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-duplicate-step-restore-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=path.join(dir,'runbooks.json');
 const s=new RunbookStore({stateFile:f});await s.initialize();
 await s.prepare({id:'rb',specHash:'a'.repeat(64),steps:[{id:'first',kind:'task_graph',dependsOn:[]}],
 resume:false,retryUnknown:false,retryFailed:false});
 const payload=JSON.parse(await readFile(f,'utf8'));
 payload.runbooks[0].steps[0].status='unknown';
 payload.runbooks[0].steps.push({...payload.runbooks[0].steps[0],status:'succeeded'});
 const altered=JSON.stringify(payload);
 await writeFile(f,altered);
 const restored=new RunbookStore({stateFile:f});
 await assert.rejects(restored.initialize(),
 e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_JOURNAL_DUPLICATE_STEP_ID');
 assert.equal(restored.list().length,0);
 assert.equal(await readFile(f,'utf8'),altered);
});

test('task graph restore fails closed on nested duplicate jobs without erasing UNKNOWN',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-duplicate-job-restore-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=path.join(dir,'graphs.json');
 const s=new TaskGraphStore({stateFile:f});await s.initialize();
 await s.prepare({id:'g',specHash:'a'.repeat(64),jobs:[{id:'first',dependsOn:[]}],
 resume:false,retryUnknown:false,retryFailed:false});
 const payload=JSON.parse(await readFile(f,'utf8'));
 payload.graphs[0].jobs[0].status='unknown';
 payload.graphs[0].jobs.push({...payload.graphs[0].jobs[0],status:'succeeded'});
 const altered=JSON.stringify(payload);
 await writeFile(f,altered);
 const restored=new TaskGraphStore({stateFile:f});
 await assert.rejects(restored.initialize(),
 e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_JOURNAL_DUPLICATE_JOB_ID');
 assert.equal(restored.list().length,0);
 assert.equal(await readFile(f,'utf8'),altered);
});
