/**
 * #01 delegated direct executor seam QA. No OS command is executed:
 * the tested path must fail before TaskGraphStore.prepare or process spawn.
 * Only disposable temp graph JSON is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {TaskGraphStore} from '../src/agent/task-graph-store.js';
import {RunbookAdmissionRequiredError}
  from '../src/agent/runbooks.js';

async function isolated(t:{after:(fn:()=>Promise<void>)=>void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx01-direct-graph-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const policy=new PathPolicy([root]);
  const store=new TaskGraphStore({stateFile:path.join(root,'graphs.json')});
  await store.initialize();
  const command="node -e \"require('fs').writeFileSync('marker.txt','effect')\"";
  return {root,policy,store,command};
}
async function denied(work:{
  policy:PathPolicy;store:TaskGraphStore;command:string;
},graphId:string,retry=false) {
  await assert.rejects(executeCapability('task.graph.run',{
    graph_id:graphId,
    ...(retry?{resume:true,retry_unknown:true}:{}),
    jobs:[{id:'mutating-command',command:work.command}],
  },work.policy,{taskGraphs:work.store}),e=>
    e instanceof RunbookAdmissionRequiredError&&
    e.code==='RECONCILE_REQUIRED');
}
test('direct task.graph.run cannot bypass runbook admission or create a file',async t=>{
  const work=await isolated(t);
  await denied(work,'direct-shell');
  assert.deepEqual(work.store.list(),[]);
  await assert.rejects(fs.stat(path.join(work.root,'marker.txt')),
    {code:'ENOENT'});
});
test('cloned graph IDs cannot generate a second dispatch or checkpoint',async t=>{
  const work=await isolated(t);
  await denied(work,'first-runbook-graph');
  await denied(work,'cloned-runbook-graph');
  assert.deepEqual(work.store.list(),[]);
  await assert.rejects(fs.stat(path.join(work.root,'marker.txt')),
    {code:'ENOENT'});
});
test('direct retry_unknown cannot reset a persisted UNKNOWN job before admission',async t=>{
  const work=await isolated(t);
  const initial=await work.store.prepare({
    id:'unknown-graph',specHash:'a'.repeat(64),
    jobs:[{id:'mutating-command',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  initial.status='interrupted';
  initial.jobs[0]!.status='unknown';
  initial.jobs[0]!.attempts=1;
  initial.jobs[0]!.startedAt='2026-10-23T00:00:00.000Z';
  await work.store.save(initial);
  const before=work.store.get('unknown-graph');
  await denied(work,'unknown-graph',true);
  assert.deepEqual(work.store.get('unknown-graph'),before);
  assert.equal(work.store.get('unknown-graph').jobs[0]?.status,'unknown');
  assert.equal(work.store.get('unknown-graph').runCount,1);
  await assert.rejects(fs.stat(path.join(work.root,'marker.txt')),
    {code:'ENOENT'});
});
test('read-only task.graph.get remains available without native admission',async t=>{
  const work=await isolated(t);
  const seeded=await work.store.prepare({
    id:'read-only-status',specHash:'b'.repeat(64),
    jobs:[{id:'inspect',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  seeded.status='interrupted';
  seeded.jobs[0]!.status='unknown';
  await work.store.save(seeded);
  const response=await executeCapability(
    'task.graph.get',{graph_id:'read-only-status'},
    work.policy,{taskGraphs:work.store}
  ) as {data:{id:string;jobs:Array<{status:string}>}};
  assert.equal(response.data.id,'read-only-status');
  assert.equal(response.data.jobs[0]?.status,'unknown');
  assert.equal(work.store.get('read-only-status').jobs[0]?.status,'unknown');
});
test('benign-looking direct shell still has no trusted read-only exception',async t=>{
  const work=await isolated(t);
  for(const [i,command] of [
    'echo status','cat README.md','Get-Content README.md',
  ].entries()){
    await denied({...work,command},'benign-but-unsafe-'+i);
  }
  assert.deepEqual(work.store.list(),[]);
});

test('list/get/artifact metadata remain read-only on a recovered UNKNOWN graph',async t=>{
  const work=await isolated(t);
  const seeded=await work.store.prepare({
    id:'read-only-unknown-inspection',
    specHash:'c'.repeat(64),
    jobs:[{id:'unresolved-job',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  seeded.status='interrupted';
  seeded.jobs[0]!.status='unknown';
  seeded.jobs[0]!.attempts=2;
  seeded.jobs[0]!.startedAt='2026-10-23T09:00:00.000Z';
  await work.store.save(seeded);
  const before=work.store.get(seeded.id);

  for(let i=0;i<3;i++){
    const listed=await executeCapability('task.graph.list',{},
      work.policy,{taskGraphs:work.store}) as {data:Array<{
        id:string;status:string;
        jobs:Array<{status:string;attempts:number}>
      }>};
    const entry=listed.data.find(x=>x.id===seeded.id);
    assert.equal(entry?.status,'interrupted');
    assert.equal(entry?.jobs[0]?.status,'unknown');
    assert.equal(entry?.jobs[0]?.attempts,2);

    const fetched=await executeCapability('task.graph.get',
      {graph_id:seeded.id},work.policy,{taskGraphs:work.store}) as {
        data:{id:string;jobs:Array<Record<string,unknown>>;
          progress:{completionEvidence:string;progressVerified:boolean}}
      };
    assert.equal(fetched.data.id,seeded.id);
    assert.equal(fetched.data.jobs[0]?.status,'unknown');
    assert.equal('command' in fetched.data.jobs[0]!,false);
    assert.equal('stdout' in fetched.data.jobs[0]!,false);
    assert.equal(fetched.data.progress.progressVerified,false);
    assert.equal(fetched.data.progress.completionEvidence,
      'persisted_job_status_not_application_result');

    const artifacts=await executeCapability('task.artifact.list',
      {graph_id:seeded.id},work.policy,{taskGraphs:work.store}) as {
        data:{artifacts:unknown[]}
      };
    assert.deepEqual(artifacts.data.artifacts,[]);
  }
  assert.deepEqual(work.store.get(seeded.id),before);
  await assert.rejects(fs.stat(path.join(work.root,'marker.txt')),
    {code:'ENOENT'});
});
test('read-only graph inspection remains available after denied direct mutation',async t=>{
  const work=await isolated(t);
  const seeded=await work.store.prepare({
    id:'earlier-unresolved',specHash:'d'.repeat(64),
    jobs:[{id:'original-unknown',dependsOn:[]}],
    resume:false,retryFailed:false,retryUnknown:false,
  });
  seeded.status='interrupted';
  seeded.jobs[0]!.status='unknown';
  seeded.jobs[0]!.attempts=1;
  await work.store.save(seeded);
  const before=work.store.get(seeded.id);

  await denied(work,'cloned-execution-attempt');
  const response=await executeCapability('task.graph.get',
    {graph_id:seeded.id},work.policy,{taskGraphs:work.store}) as {
      data:{id:string;status:string;jobs:Array<{status:string}>}
    };
  assert.equal(response.data.status,'interrupted');
  assert.equal(response.data.jobs[0]?.status,'unknown');
  assert.deepEqual(work.store.get(seeded.id),before);
  assert.deepEqual(work.store.list().map(x=>x.id),[seeded.id]);
});
