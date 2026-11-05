/**
 * #18 P0 hostile SOURCE-only NEGATIVE against EXISTING executeDurableRunbook,
 * not a claim that #780 P1 coding-loop worker has shipped.
 *
 * Historical QA-18 attack reproduced FAILED + cloned-runbook redispatch
 * before CLEAN-10. This is now the same adversarial scenario asserted as a
 * safe regression: UNKNOWN is durable and the cloned runbook cannot dispatch.
 * Only in-memory callbacks and temporary JSON are used, never OS mutations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';

test('#18 CLEAN-10 regression: lost native ACK stays UNKNOWN and cloned runbook never dispatches',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'nexowire-qa18-loop-unknown-'));
 t.after(async()=>rm(root,{force:true,recursive:true}));
 const stateFile=path.join(root,'disposable-runbooks.json');
 const store=new RunbookStore({stateFile});
 await store.initialize();
 // Synthetic logical operation: no commands/payloads, only an in-memory
 // counter increment to model a mutation that might already have executed.
 const steps=[{
  id:'single-logical-native-effect',
  kind:'task_graph' as const,
  task_graph:{jobs:[{id:'logical-effect',kind:'TEST_NO_OS_EFFECT'}]},
 }];
 let syntheticNativeDispatches=0;
 let authorityReadbacks=0;
 let currentOwnerEpoch=7;
 const inputs:string[]=[];
 const callbacks={
  runTaskGraph:async(input:unknown)=>{
   const request=input as Record<string,unknown>;
   inputs.push(String(request.graph_id));
   syntheticNativeDispatches++;
   // Callback is deliberately the only dependency available in the
   // existing runbook API: there is no independent authority-readback or
   // current-owner-epoch verifier in executeDurableRunbook options.
   if(syntheticNativeDispatches===1){
    throw Object.assign(new Error('synthetic OS effect sent; ACK lost'),{
     code:'MUTATION_STATE_UNKNOWN',
    });
   }
   return {data:{ok:true,graphId:request.graph_id,
    summary:{total:1,succeeded:1,failed:0}}};
  },
  runAssertions:async()=>({data:{ok:true}}),
 };
 const first=await executeDurableRunbook({
  runbook_id:'qa18-original-task',
  steps,
 },store,callbacks) as {data:{
  ok:boolean,summary:{failed:number;unknown:number},
  steps:Array<{status:string;errorCode?:string}>,
 }};
 assert.equal(first.data.ok,false);
 assert.equal(syntheticNativeDispatches,1);
 // Regression must classify the unacknowledged effect UNKNOWN, not retryable.
 assert.equal(first.data.steps[0]?.errorCode,'MUTATION_STATE_UNKNOWN');
 assert.equal(first.data.steps[0]?.status,'unknown');
 assert.equal(first.data.summary.failed,0);
 assert.equal(first.data.summary.unknown,1);

 // Restart persistence (disposable JSON only), then rotate the external
 // runbook ID to clone the SAME logical operation. Source validation keys
 // checkpoints by runbook_id, not logical-operation identity / requestId.
 const restarted=new RunbookStore({stateFile});
 await restarted.initialize();
 assert.equal(restarted.get('qa18-original-task').steps[0]?.status,'unknown');
 currentOwnerEpoch++; // Would require an independent CAS comparison.
 assert.equal(currentOwnerEpoch,8);
 const cloned=await executeDurableRunbook({
  runbook_id:'qa18-cloned-task',
  steps, // unchanged semantic mutation / worker plan
  resume:false,retry_unknown:false,retry_failed:false,
 },restarted,callbacks) as {data:{ok:boolean;summary:{succeeded:number}}};
 assert.equal(cloned.data.ok,false,
  'A new runbook_id cannot authorize the same uncertain native effect');
 assert.equal(syntheticNativeDispatches,1,
  'CLEAN-10 permanent reservation must block a cloned runbook');
 assert.equal(authorityReadbacks,0,
  'No independent authority readback occurred and no second dispatch is allowed');
 assert.equal(inputs.length,1,'Only the first graph reached its callback');
 assert.equal(restarted.get('qa18-original-task').steps[0]?.status,'unknown',
  'Old forensic UNKNOWN must survive a separate clone attempt');
});
