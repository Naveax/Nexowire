/**
 * #01 UNSAFE SOURCE NEGATIVE (not a fix):
 * TaskGraphStore TTL treats INTERRUPTED/UNKNOWN records as expendable,
 * even when only task.graph.list or task.artifact.list is requested.
 *
 * All storage is disposable TEMP JSON. We never issue task.graph.run,
 * launch a process, perform native operations or claim off-host CAS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {TaskGraphStore} from '../src/agent/task-graph-store.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeCapability} from '../src/agent/executors.js';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx01-ttl-unknown-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const stateFile=path.join(root,'graph-journal.json');
  const store=new TaskGraphStore({stateFile,retentionMs:5});
  await store.initialize();
  const graphId='unknown-original-effect';
  const graph=await store.prepare({
    id:graphId,specHash:'a'.repeat(64),
    jobs:[{id:'possibly-dispatched',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  graph.status='interrupted';
  graph.jobs[0]!.status='unknown';
  graph.jobs[0]!.attempts=1;
  graph.jobs[0]!.startedAt='2026-10-23T08:00:00.000Z';
  await store.save(graph);
  // This tuple is illustrative untrusted local metadata, NOT a
  // durable/externally verified binding in the current TaskGraphStore.
  const original=Object.freeze({
    logicalMutationId:randomUUID(),
    requestId:randomUUID(),
    sourceSha:'a'.repeat(40),
    worktreeId:randomUUID(),
    ownerEpoch:7,grantGeneration:8,
  });
  const policy=new PathPolicy([root]);
  return {root,stateFile,store,policy,graphId,original};
}

test('UNSAFE SOURCE NEGATIVE: task.graph.list TTL evicts original UNKNOWN and next metadata write overwrites disk evidence',async t=>{
  const f=await fixture(t);
  const initial=f.store.get(f.graphId);
  assert.equal(initial.status,'interrupted');
  assert.equal(initial.jobs[0]?.status,'unknown');
  assert.equal(initial.jobs[0]?.attempts,1);

  // The current persisted checkpoint has no immutable original identity;
  // local IDs/epoch cannot substitute for the #587 external tombstone.
  for(const field of ['logicalMutationId','requestId','ownerEpoch',
    'sourceSha','worktreeId','grantGeneration'] as const){
    assert.equal(Object.hasOwn(initial,field),false);
    assert.ok(f.original[field]!==undefined);
  }

  await delay(40); // Expire only the disposable 5-ms TTL.
  assert.equal(f.store.get(f.graphId).jobs[0]?.status,'unknown');
  const listed=await executeCapability('task.graph.list',{},
    f.policy,{taskGraphs:f.store}) as {data:Array<{id:string}>};
  assert.equal(listed.data.some(x=>x.id===f.graphId),false,
    'source defect: inspection pruned unresolved UNKNOWN');
  assert.throws(()=>f.store.get(f.graphId),(e:unknown)=>
    typeof e==='object'&&e!==null&&'code' in e&&
    e.code==='TASK_GRAPH_NOT_FOUND');

  // The initial read does not rewrite the JSON immediately, but
  // a later unrelated LOCAL checkpoint write now permanently drops it.
  const before=JSON.parse(await fs.readFile(f.stateFile,'utf8')) as {
    graphs:Array<{id:string}>
  };
  assert.equal(before.graphs.some(x=>x.id===f.graphId),true);
  await f.store.prepare({
    id:'unrelated-local-metadata',specHash:'b'.repeat(64),
    jobs:[{id:'unrelated',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  }); // No shell, no real mutation.
  const after=JSON.parse(await fs.readFile(f.stateFile,'utf8')) as {
    graphs:Array<{id:string}>
  };
  assert.equal(after.graphs.some(x=>x.id===f.graphId),false,
    'source defect: later metadata persistence dropped original UNKNOWN');
  assert.equal(after.graphs.some(x=>x.id==='unrelated-local-metadata'),true);
});

test('UNSAFE SOURCE NEGATIVE: task.artifact.list TTL also evicts UNKNOWN without a graph mutation command',async t=>{
  const f=await fixture(t);
  await delay(40);
  assert.equal(f.store.get(f.graphId).jobs[0]?.status,'unknown');
  const response=await executeCapability('task.artifact.list',{},
    f.policy,{taskGraphs:f.store}) as {data:{artifacts:unknown[]}};
  assert.deepEqual(response.data.artifacts,[]);
  assert.throws(()=>f.store.get(f.graphId),(e:unknown)=>
    typeof e==='object'&&e!==null&&'code' in e&&
    e.code==='TASK_GRAPH_NOT_FOUND');
});

test('local TTL cannot prove original logicalMutationId/requestId or ownerEpoch after absence',async t=>{
  const f=await fixture(t);
  await delay(40);
  // Absence from list/get only means local cache expiry, NOT no native effect.
  await executeCapability('task.graph.list',{},
    f.policy,{taskGraphs:f.store});
  assert.throws(()=>f.store.get(f.graphId),(e:unknown)=>
    typeof e==='object'&&e!==null&&'code' in e&&
    e.code==='TASK_GRAPH_NOT_FOUND');
  assert.equal(typeof f.original.logicalMutationId,'string');
  assert.equal(typeof f.original.requestId,'string');
  assert.equal(f.original.ownerEpoch,7);
  // The graph was not safely reconciled; NEVER create a fresh requestId
  // or interpret missing local state as authorization to dispatch.
});
