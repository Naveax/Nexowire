/**
 * #06 independent cross-entry negative QA on ACTUAL #826 executor APIs.
 *
 * This is intentionally an UNSAFE negative proof, not a mitigation:
 * #826 denies runbook.task_graph callbacks, but direct task.graph.run
 * remains a separate public executor capability with fresh graph_id.
 *
 * The commands ONLY print an inert marker in disposable GitHub CI/temporary
 * directories. No Native Agent, Broker, shell mutation, user files, VM, or
 * real external CAS/owner privilege is involved. PASS != safe replay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../src/agent/executors.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {TaskGraphStore} from '../src/agent/task-graph-store.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('#06 NEGATIVE: direct task.graph.run alias still runs an inert graph after #826 runbook UNKNOWN',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nx06-826-alias-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const runbooks=new RunbookStore({stateFile:path.join(root,'runbooks.json')});
  const graphs=new TaskGraphStore({stateFile:path.join(root,'graphs.json')});
  await runbooks.initialize();
  await graphs.initialize();
  let runbookCallbackCount=0;
  const step={id:'same-semantic-step',kind:'task_graph' as const,
    task_graph:{jobs:[{id:'same-semantic-job',command:'not-executed'}]}};
  const first=await executeDurableRunbook({
    runbook_id:'original-runbook-id',steps:[step],
  },runbooks,{
    runTaskGraph:async()=>{
      runbookCallbackCount++;
      throw Object.assign(new Error('synthetic lost ACK'),{
        code:'MUTATION_STATE_UNKNOWN'});
    },
    runAssertions:async()=>({data:{ok:true}}),
  }) as {data:{ok:boolean;steps:Array<{status:string;errorCode?:string}>}};
  assert.equal(first.data.ok,false);
  assert.equal(first.data.steps[0]?.status,'unknown');
  assert.equal(first.data.steps[0]?.errorCode,'RECONCILE_REQUIRED');
  assert.equal(runbookCallbackCount,0,
    '#826 correctly denies direct runbook callback');

  // Use the separate, existing executeCapability API, not a test mock.
  // Two fresh graph IDs have no pointer to the original UNKNOWN runbook,
  // immutable logicalMutationId, owner generation, worktreeId or sourceSha.
  const policy=new PathPolicy([root]);
  const shell=process.platform==='win32'?'pwsh':'bash';
  const observed:string[]=[];
  for(const graph_id of ['repaired-session-graph-a','renamed-session-graph-b']){
    const result=await executeCapability('task.graph.run',{
      graph_id,ui_target:'headless',max_parallel:1,
      total_timeout_ms:20_000,
      jobs:[{id:'same-semantic-job',shell,cwd:root,
        command:'node -e "console.log(\'INERT_SOURCE_ONLY_MARKER\')"'}],
    },policy,{taskGraphs:graphs}) as {data:{
      ok:boolean;graphId?:string;
      results:Array<{status:string;stdout?:string}>}};
    assert.equal(result.data.ok,true,graph_id);
    assert.equal(result.data.graphId,graph_id);
    assert.equal(result.data.results[0]?.status,'succeeded');
    assert.match(result.data.results[0]?.stdout??'',/INERT_SOURCE_ONLY_MARKER/);
    observed.push(graph_id);
  }
  assert.equal(observed.length,2,
    'UNSAFE NEGATIVE: second API accepts both fresh graph aliases');
  assert.notEqual(observed[0],observed[1]);
  assert.equal(runbooks.get('original-runbook-id').steps[0]?.status,'unknown');
  assert.equal(runbooks.get('original-runbook-id').steps[0]?.errorCode,
    'RECONCILE_REQUIRED');
  assert.equal(runbookCallbackCount,0);
});
