import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';

const COUNT=1001; // exceeds the historic 1,000 state parser cap, stays below default 4,096 admission cap
const stamp='2026-10-26T08:00:00.000Z';
function fixtures(){
 const graphs=Array.from({length:COUNT},(_,i)=>({
  id:'graph-'+i,specHash:'a'.repeat(64),status:'interrupted',createdAt:stamp,updatedAt:stamp,
  runCount:1,jobs:[{id:'native-effect',status:'unknown',dependsOn:[],attempts:1,startedAt:stamp}],
 }));
 const runbooks=Array.from({length:COUNT},(_,i)=>({
  id:'runbook-'+i,specHash:'b'.repeat(64),status:'interrupted',createdAt:stamp,updatedAt:stamp,
  runCount:1,steps:[{id:'unknown-effect',kind:'task_graph',taskGraphId:'graph-'+i,
   status:'unknown',dependsOn:[],attempts:1,startedAt:stamp}],
 }));
 return {graphs,runbooks};
}

test('runbook persists and restores >1000 UNKNOWN entries under default configured admission cap',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-schema-runbook-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'runbooks.json');
 const state={version:1,runbooks:fixtures().runbooks};
 const bytes=JSON.stringify(state);
 await writeFile(file,bytes);
 const store=new RunbookStore({stateFile:file});
 await store.initialize();
 assert.equal(store.list().length,COUNT);
 assert.equal(store.get('runbook-1000').steps[0]?.status,'unknown');
 assert.equal(await readFile(file,'utf8'),bytes,'read-only recovery must preserve all unknown bytes');
 // A lower configured cap cannot force a previously recorded UNKNOWN to disappear.
 const smaller=new RunbookStore({stateFile:file,maxEntries:1000});
 await smaller.initialize();
 assert.equal(smaller.list().length,COUNT);
 await assert.rejects(smaller.prepare({id:'fresh-native',specHash:'b'.repeat(64),
  steps:[{id:'new-effect',kind:'task_graph',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false}),
  (error:unknown)=>error instanceof RunbookStoreError&&error.code==='RUNBOOK_JOURNAL_CAPACITY_REACHED');
 assert.equal(await readFile(file,'utf8'),bytes);
});

test('task graph persists and restores >1000 UNKNOWN entries under default configured admission cap',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-schema-graph-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'graphs.json');
 const state={version:1,graphs:fixtures().graphs};
 const bytes=JSON.stringify(state);
 await writeFile(file,bytes);
 const store=new TaskGraphStore({stateFile:file});
 await store.initialize();
 assert.equal(store.list().length,COUNT);
 assert.equal(store.get('graph-1000').jobs[0]?.status,'unknown');
 assert.equal(await readFile(file,'utf8'),bytes,'read-only recovery must preserve all unknown bytes');
 const smaller=new TaskGraphStore({stateFile:file,maxEntries:1000});
 await smaller.initialize();
 assert.equal(smaller.list().length,COUNT);
 await assert.rejects(smaller.prepare({id:'fresh-native',specHash:'a'.repeat(64),
  jobs:[{id:'new-effect',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false}),
  (error:unknown)=>error instanceof TaskGraphStoreError&&error.code==='TASK_GRAPH_JOURNAL_CAPACITY_REACHED');
 assert.equal(await readFile(file,'utf8'),bytes);
});

test('runbook duplicate durable IDs fail closed before a later record can overwrite UNKNOWN',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-duplicate-runbook-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'runbook.json');
 const unknown=fixtures().runbooks[0]!;
 const forged={...unknown,status:'succeeded',steps:[{...unknown.steps[0]!,status:'succeeded'}]};
 const bytes=JSON.stringify({version:1,runbooks:[unknown,forged]});
 await writeFile(file,bytes);
 const store=new RunbookStore({stateFile:file});
 await assert.rejects(store.initialize(),e=>e instanceof RunbookStoreError&&e.code==='RUNBOOK_JOURNAL_DUPLICATE_ID');
 assert.equal(store.list().length,0,'no partial journal accepted after duplicate-id denial');
 assert.equal(await readFile(file,'utf8'),bytes,'original UNKNOWN history must be retained byte-identically');
});

test('task graph duplicate durable IDs fail closed before a later record can overwrite UNKNOWN',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nxw-duplicate-graph-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'graph.json');
 const unknown=fixtures().graphs[0]!;
 const forged={...unknown,status:'succeeded',jobs:[{...unknown.jobs[0]!,status:'succeeded'}]};
 const bytes=JSON.stringify({version:1,graphs:[unknown,forged]});
 await writeFile(file,bytes);
 const store=new TaskGraphStore({stateFile:file});
 await assert.rejects(store.initialize(),e=>e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_JOURNAL_DUPLICATE_ID');
 assert.equal(store.list().length,0);
 assert.equal(await readFile(file,'utf8'),bytes);
});
