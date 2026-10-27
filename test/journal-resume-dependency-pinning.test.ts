import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';
test('runbook resume rejects rewritten kind or dependency with same asserted hash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nxw-resume-runbook-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'j.json');
 const s=new RunbookStore({stateFile:file});await s.initialize();
 const orig={id:'rb',specHash:'a'.repeat(64),steps:[
  {id:'first',kind:'task_graph' as const,dependsOn:[]},
  {id:'second',kind:'assertions' as const,dependsOn:['first']}],
  resume:false,retryFailed:false,retryUnknown:false};
 await s.prepare(orig);
 const bytes=await readFile(file,'utf8');
 for(const steps of [
  [{...orig.steps[0]!,kind:'assertions' as const},orig.steps[1]!],
  [orig.steps[0]!,{...orig.steps[1]!,dependsOn:[]}],
 ]){
  await assert.rejects(s.prepare({...orig,resume:true,steps}),
   e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_SPEC_MISMATCH');
  assert.equal(s.get('rb').runCount,1);
  assert.equal(await readFile(file,'utf8'),bytes);
 }
});
test('task graph resume rejects changed dependencies despite same asserted spec hash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nxw-resume-graph-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'j.json');
 const s=new TaskGraphStore({stateFile:file});await s.initialize();
 const orig={id:'g',specHash:'a'.repeat(64),jobs:[
  {id:'first',dependsOn:[]},{id:'second',dependsOn:['first']}],
  resume:false,retryFailed:false,retryUnknown:false};
 await s.prepare(orig);
 const bytes=await readFile(file,'utf8');
 await assert.rejects(s.prepare({...orig,resume:true,
  jobs:[orig.jobs[0]!,{...orig.jobs[1]!,dependsOn:[]}]}),
  e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_SPEC_MISMATCH');
 assert.equal(s.get('g').runCount,1);
 assert.equal(await readFile(file,'utf8'),bytes);
});
