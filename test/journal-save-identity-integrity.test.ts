import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';

test('runbook save cannot rewrite existing spec hash or ordered durable step identities',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nxw-runbook-immutable-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const stateFile=path.join(dir,'state.json');
 const store=new RunbookStore({stateFile});
 await store.initialize();
 const prepared=await store.prepare({
  id:'immutable-rb',specHash:'a'.repeat(64),
  steps:[{id:'step-1',kind:'task_graph',dependsOn:[]}],
  resume:false,retryFailed:false,retryUnknown:false,
 });
 const bytes=await readFile(stateFile,'utf8');
 for(const modified of [
  {...prepared,specHash:'b'.repeat(64)},
  {...prepared,steps:[{...prepared.steps[0]!,id:'other-step'}]},
  {...prepared,steps:[{...prepared.steps[0]!,kind:'assertions' as const}]},
 ]){
  await assert.rejects(store.save(modified),
    e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_SPEC_MISMATCH');
  assert.equal(store.get(prepared.id).specHash,prepared.specHash);
  assert.equal(store.get(prepared.id).steps[0]?.id,'step-1');
  assert.equal(await readFile(stateFile,'utf8'),bytes);
 }
});

test('task graph save cannot rewrite existing spec hash or ordered durable job identities',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nxw-graph-immutable-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const stateFile=path.join(dir,'state.json');
 const store=new TaskGraphStore({stateFile});
 await store.initialize();
 const prepared=await store.prepare({
  id:'immutable-graph',specHash:'a'.repeat(64),
  jobs:[{id:'job-1',dependsOn:[]}],
  resume:false,retryFailed:false,retryUnknown:false,
 });
 const bytes=await readFile(stateFile,'utf8');
 for(const modified of [
  {...prepared,specHash:'b'.repeat(64)},
  {...prepared,jobs:[{...prepared.jobs[0]!,id:'other-job'}]},
 ]){
  await assert.rejects(store.save(modified),
    e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_SPEC_MISMATCH');
  assert.equal(store.get(prepared.id).specHash,prepared.specHash);
  assert.equal(store.get(prepared.id).jobs[0]?.id,'job-1');
  assert.equal(await readFile(stateFile,'utf8'),bytes);
 }
});
