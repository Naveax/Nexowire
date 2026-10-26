import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';

test('runbook UNKNOWN native step cannot become success via direct checkpoint save',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-sticky-runbook-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const store=new RunbookStore({stateFile:file});
 await store.initialize();
 const checkpoint=await store.prepare({id:'rb',specHash:'a'.repeat(64),steps:[{id:'native-effect',kind:'task_graph',dependsOn:[]}],
  resume:false,retryUnknown:false,retryFailed:false});
 checkpoint.status='interrupted';
 checkpoint.steps[0]!.status='unknown';
 await store.save(checkpoint);
 const bytes=await readFile(file,'utf8');
 const forged=store.get('rb');
 forged.status='succeeded';
 forged.steps[0]!.status='succeeded';
 await assert.rejects(store.save(forged),
   e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_UNKNOWN_RECONCILIATION_REQUIRED');
 assert.equal(store.get('rb').steps[0]?.status,'unknown');
 assert.equal(await readFile(file,'utf8'),bytes);
});

test('task graph UNKNOWN native job cannot become success via direct checkpoint save',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-sticky-graph-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const store=new TaskGraphStore({stateFile:file});
 await store.initialize();
 const checkpoint=await store.prepare({id:'g',specHash:'a'.repeat(64),jobs:[{id:'native-effect',dependsOn:[]}],
  resume:false,retryUnknown:false,retryFailed:false});
 checkpoint.status='interrupted';
 checkpoint.jobs[0]!.status='unknown';
 await store.save(checkpoint);
 const bytes=await readFile(file,'utf8');
 const forged=store.get('g');
 forged.status='succeeded';
 forged.jobs[0]!.status='succeeded';
 await assert.rejects(store.save(forged),
   e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_UNKNOWN_RECONCILIATION_REQUIRED');
 assert.equal(store.get('g').jobs[0]?.status,'unknown');
 assert.equal(await readFile(file,'utf8'),bytes);
});

test('explicit retryUnknown prepare permits runbook UNKNOWN to change only after re-admission',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-retry-runbook-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new RunbookStore({stateFile:path.join(dir,'state.json')});
 await store.initialize();
 const request={id:'rb',specHash:'c'.repeat(64),steps:[{id:'effect',kind:'task_graph' as const,dependsOn:[]}],
  resume:false,retryUnknown:false,retryFailed:false};
 const cp=await store.prepare(request);
 cp.status='interrupted';cp.steps[0]!.status='unknown';
 await store.save(cp);
 const retry=await store.prepare({...request,resume:true,retryUnknown:true});
 assert.equal(retry.steps[0]?.status,'pending');
 retry.status='succeeded';retry.steps[0]!.status='succeeded';
 await store.save(retry);
 assert.equal(store.get('rb').steps[0]?.status,'succeeded');
});

test('explicit retryUnknown prepare permits graph UNKNOWN to change only after re-admission',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-retry-graph-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new TaskGraphStore({stateFile:path.join(dir,'state.json')});
 await store.initialize();
 const request={id:'g',specHash:'c'.repeat(64),jobs:[{id:'effect',dependsOn:[]}],
  resume:false,retryUnknown:false,retryFailed:false};
 const cp=await store.prepare(request);
 cp.status='interrupted';cp.jobs[0]!.status='unknown';
 await store.save(cp);
 const retry=await store.prepare({...request,resume:true,retryUnknown:true});
 assert.equal(retry.jobs[0]?.status,'pending');
 retry.status='succeeded';retry.jobs[0]!.status='succeeded';
 await store.save(retry);
 assert.equal(store.get('g').jobs[0]?.status,'succeeded');
});

test('runbook cannot claim parent success while leaving a native UNKNOWN step unresolved',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-parent-runbook-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const store=new RunbookStore({stateFile:file});
 await store.initialize();
 const cp=await store.prepare({id:'rb',specHash:'b'.repeat(64),
  steps:[{id:'effect',kind:'task_graph',dependsOn:[]}],resume:false,retryUnknown:false,retryFailed:false});
 cp.status='interrupted';cp.steps[0]!.status='unknown';
 await store.save(cp);
 const bytes=await readFile(file,'utf8');
 await assert.rejects(store.save({...cp,status:'succeeded'}),
  e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_UNKNOWN_RECONCILIATION_REQUIRED');
 assert.equal(await readFile(file,'utf8'),bytes);
});

test('task graph cannot claim parent success while retaining UNKNOWN native job',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexowire-unknown-parent-graph-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const store=new TaskGraphStore({stateFile:file});
 await store.initialize();
 const cp=await store.prepare({id:'g',specHash:'b'.repeat(64),
  jobs:[{id:'effect',dependsOn:[]}],resume:false,retryUnknown:false,retryFailed:false});
 cp.status='interrupted';cp.jobs[0]!.status='unknown';
 await store.save(cp);
 const bytes=await readFile(file,'utf8');
 await assert.rejects(store.save({...cp,status:'succeeded'}),
  e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_UNKNOWN_RECONCILIATION_REQUIRED');
 assert.equal(await readFile(file,'utf8'),bytes);
});
