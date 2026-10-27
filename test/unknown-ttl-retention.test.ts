import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TaskGraphStore,TaskGraphStoreError} from '../src/agent/task-graph-store.js';
import {RunbookStore,RunbookStoreError} from '../src/agent/runbook-store.js';

test('UNKNOWN task graph survives local TTL, read-only lists, checkpoint write, restart and prune denial',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nwx-ttl-graph-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'graph.json');
  const store=new TaskGraphStore({stateFile:file,retentionMs:5});
  await store.initialize();
  const checkpoint=await store.prepare({
    id:'original-mutation',specHash:'a'.repeat(64),
    jobs:[{id:'possible-effect',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  checkpoint.status='interrupted';
  checkpoint.jobs[0]!.status='unknown';
  checkpoint.jobs[0]!.attempts=1;
  checkpoint.jobs[0]!.startedAt='2026-10-23T08:00:00Z';
  await store.save(checkpoint);
  const before=store.get(checkpoint.id);
  const bytes=await readFile(file,'utf8');
  await delay(40);
  for(let i=0;i<2;i++){
    assert.ok(store.list().some(graph=>graph.id===checkpoint.id));
    assert.deepEqual(store.listArtifacts({graphId:checkpoint.id}),[]);
    assert.deepEqual(store.get(checkpoint.id),before);
    assert.equal(await readFile(file,'utf8'),bytes);
  }
  await assert.rejects(store.prune({olderThanMs:1}),e=>
    e instanceof TaskGraphStoreError&&e.code==='RECONCILE_REQUIRED');
  await store.prepare({id:'unrelated-read-only-metadata',specHash:'b'.repeat(64),
    jobs:[{id:'pending',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false});
  const reloaded=new TaskGraphStore({stateFile:file,retentionMs:5});
  await reloaded.initialize();
  assert.deepEqual(reloaded.get(checkpoint.id),before);
  const persisted=JSON.parse(await readFile(file,'utf8')) as {graphs:Array<{id:string}>};
  assert.ok(persisted.graphs.some(g=>g.id===checkpoint.id));
});

test('UNKNOWN runbook survives local TTL, list, unrelated save, restart and prune denial',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nwx-ttl-runbook-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'runbook.json');
  const store=new RunbookStore({stateFile:file,retentionMs:5});
  await store.initialize();
  const checkpoint=await store.prepare({id:'original-runbook',specHash:'c'.repeat(64),
    steps:[{id:'native-capable-step',kind:'task_graph',dependsOn:[],taskGraphId:'original-graph'}],
    resume:false,retryFailed:false,retryUnknown:false});
  checkpoint.status='interrupted';
  checkpoint.steps[0]!.status='unknown';
  checkpoint.steps[0]!.attempts=1;
  checkpoint.steps[0]!.errorCode='RECONCILE_REQUIRED';
  await store.save(checkpoint);
  const before=store.get(checkpoint.id);
  const bytes=await readFile(file,'utf8');
  await delay(40);
  for(let i=0;i<2;i++){
    assert.ok(store.list().some(entry=>entry.id===checkpoint.id));
    assert.deepEqual(store.get(checkpoint.id),before);
    assert.equal(await readFile(file,'utf8'),bytes);
  }
  await assert.rejects(store.prune({olderThanMs:1}),e=>
    e instanceof RunbookStoreError&&e.code==='RECONCILE_REQUIRED');
  await store.prepare({id:'unrelated-assertions',specHash:'d'.repeat(64),
    steps:[{id:'inspect',kind:'assertions',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false});
  const restored=new RunbookStore({stateFile:file,retentionMs:5});
  await restored.initialize();
  assert.deepEqual(restored.get(checkpoint.id),before);
  const persisted=JSON.parse(await readFile(file,'utf8')) as {runbooks:Array<{id:string}>};
  assert.ok(persisted.runbooks.some(g=>g.id===checkpoint.id));
});

test('bounded task graph journal denies new IDs at capacity while retaining the original UNKNOWN',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nwx-graph-cap-'));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const stateFile=path.join(dir,'graphs.json');
  assert.throws(()=>new TaskGraphStore({stateFile,maxEntries:0}),/CAPACITY_CONFIG_INVALID/);
  const store=new TaskGraphStore({stateFile,maxEntries:1,retentionMs:1});
  await store.initialize();
  const original=await store.prepare({id:'first-mutating-graph',specHash:'e'.repeat(64),
    jobs:[{id:'unknown-native-step',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false});
  original.status='interrupted';original.jobs[0]!.status='unknown';original.jobs[0]!.attempts=1;
  await store.save(original);
  const snapshot=await readFile(stateFile,'utf8');
  await delay(10);
  await assert.rejects(store.prepare({id:'second-graph',specHash:'f'.repeat(64),
    jobs:[{id:'new-step',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false}),e=>
      e instanceof TaskGraphStoreError&&e.code==='TASK_GRAPH_JOURNAL_CAPACITY_REACHED');
  assert.equal(await readFile(stateFile,'utf8'),snapshot,'full journal must remain byte-identical');
  assert.equal(store.list().length,1);
  assert.equal(store.get('first-mutating-graph').jobs[0]?.status,'unknown');
  const rebooted=new TaskGraphStore({stateFile,maxEntries:1});
  await rebooted.initialize();
  assert.equal(rebooted.get('first-mutating-graph').jobs[0]?.status,'unknown');
});

test('bounded runbook journal rejects new work without erasing a previously UNKNOWN mutation',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'nwx-runbook-cap-'));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const stateFile=path.join(dir,'runbooks.json');
  assert.throws(()=>new RunbookStore({stateFile,maxEntries:65537}),/CAPACITY_CONFIG_INVALID/);
  const store=new RunbookStore({stateFile,maxEntries:1,retentionMs:1});
  await store.initialize();
  const original=await store.prepare({id:'first-mutating-runbook',specHash:'a'.repeat(64),
    steps:[{id:'unknown-native-step',kind:'task_graph',taskGraphId:'a-graph',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false});
  original.status='interrupted';original.steps[0]!.status='unknown';original.steps[0]!.attempts=1;
  await store.save(original);
  const snapshot=await readFile(stateFile,'utf8');
  await delay(10);
  await assert.rejects(store.prepare({id:'second-runbook',specHash:'b'.repeat(64),
    steps:[{id:'assertion',kind:'assertions',dependsOn:[]}],resume:false,retryFailed:false,retryUnknown:false}),e=>
      e instanceof RunbookStoreError&&e.code==='RUNBOOK_JOURNAL_CAPACITY_REACHED');
  assert.equal(await readFile(stateFile,'utf8'),snapshot,'rejected reservation cannot modify trusted history');
  assert.equal(store.list().length,1);
  assert.equal(store.get('first-mutating-runbook').steps[0]?.status,'unknown');
  const rebooted=new RunbookStore({stateFile,maxEntries:1});
  await rebooted.initialize();
  assert.equal(rebooted.get('first-mutating-runbook').steps[0]?.status,'unknown');
});
