import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';

test('runbook save cannot insert an unprepared new native ID past capacity',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-runbook-save-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const stateFile=path.join(root,'runbooks.json');
 const store=new RunbookStore({stateFile,maxEntries:1});
 await store.initialize();
 const original=await store.prepare({id:'original',specHash:'a'.repeat(64),
  steps:[{id:'native',kind:'task_graph',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false});
 original.status='interrupted';original.steps[0]!.status='unknown';
 await store.save(original);
 const snapshot=await readFile(stateFile,'utf8');
 await assert.rejects(store.save({...original,id:'injected',status:'succeeded'}),
  e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_NOT_PREPARED');
 assert.equal(store.list().length,1);
 assert.equal(store.get('original').steps[0]?.status,'unknown');
 assert.equal(await readFile(stateFile,'utf8'),snapshot);
});

test('task-graph save cannot insert an unprepared new native ID past capacity',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-graph-save-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const stateFile=path.join(root,'graphs.json');
 const store=new TaskGraphStore({stateFile,maxEntries:1});
 await store.initialize();
 const original=await store.prepare({id:'original',specHash:'a'.repeat(64),
  jobs:[{id:'native',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false});
 original.status='interrupted';original.jobs[0]!.status='unknown';
 await store.save(original);
 const snapshot=await readFile(stateFile,'utf8');
 await assert.rejects(store.save({...original,id:'injected',status:'succeeded'}),
  e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_NOT_PREPARED');
 assert.equal(store.list().length,1);
 assert.equal(store.get('original').jobs[0]?.status,'unknown');
 assert.equal(await readFile(stateFile,'utf8'),snapshot);
});
