/**
 * #18 P0 hostile SOURCE-only NEGATIVE against EXISTING executeDurableRunbook,
 * not a claim that #780 P1 coding-loop worker has shipped.
 *
 * A mock callback says "OS effect may have happened, ACK lost" and raises
 * MUTATION_STATE_UNKNOWN. The actual runbook marks that step FAILED, then
 * accepts the same logical task under a different runbook_id after restart.
 * Both dispatched callbacks are synthetic counters; no shell, Broker, Hub,
 * database, network, real native effect or VM is touched.
 *
 * UNSAFE NEGATIVE test PASS != safe implementation. #587 is production NO-GO.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';

test('#18 NEGATIVE: lost native ACK can be misclassified FAILED and cloned runbook_id re-dispatches without owner-epoch readback',async t=>{
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
 // REAL SOURCE NEGATIVE: errorCode survives but security-critical UNKNOWN
 // is classified FAILED rather than requiring explicit reconciliation.
 assert.equal(first.data.steps[0]?.errorCode,'MUTATION_STATE_UNKNOWN');
 assert.equal(first.data.steps[0]?.status,'failed');
 assert.equal(first.data.summary.failed,1);
 assert.equal(first.data.summary.unknown,0);

 // Restart persistence (disposable JSON only), then rotate the external
 // runbook ID to clone the SAME logical operation. Source validation keys
 // checkpoints by runbook_id, not logical-operation identity / requestId.
 const restarted=new RunbookStore({stateFile});
 await restarted.initialize();
 assert.equal(restarted.get('qa18-original-task').steps[0]?.status,'failed');
 currentOwnerEpoch++; // Would require an independent CAS comparison.
 assert.equal(currentOwnerEpoch,8);
 const cloned=await executeDurableRunbook({
  runbook_id:'qa18-cloned-task',
  steps, // unchanged semantic mutation / worker plan
  resume:false,retry_unknown:false,retry_failed:false,
 },restarted,callbacks) as {data:{ok:boolean;summary:{succeeded:number}}};
 assert.equal(cloned.data.ok,true,
  'UNSAFE: cloned ID is a fresh runbook without reconciliation');
 assert.equal(cloned.data.summary.succeeded,1);
 assert.equal(syntheticNativeDispatches,2,
  'UNSAFE: same logical mutating callback dispatched twice after lost ACK');
 assert.equal(authorityReadbacks,0,
  'No authenticated authority readback interface was invoked');
 assert.notEqual(inputs[0],inputs[1],
  'Changing runbook_id generates a different task graph ID');
 assert.equal(restarted.get('qa18-original-task').steps[0]?.status,'failed',
  'Old forensic step is not correlated with new cloned runbook');
});
