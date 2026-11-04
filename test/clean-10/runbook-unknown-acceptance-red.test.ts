/**
 * CLEAN-10 mandatory RED acceptance. This must not be softened, skipped or
 * interpreted as a success just because the historical QA-18 unsafe oracle
 * documents that the exploit path exists.
 *
 * Entirely synthetic callbacks and temporary JSON. No OS mutation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../../src/agent/runbooks.js';

test('CLEAN-10 RED: lost-ACK mutation must remain UNKNOWN and cloned runbook must not re-dispatch', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'nw-clean10-runbook-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const stateFile = path.join(root,'runbooks.json');
  const original = new RunbookStore({stateFile});
  await original.initialize();
  const steps = [{
    id:'semantic-mutation', kind:'task_graph' as const,
    task_graph:{jobs:[{id:'synthetic-only',kind:'TEST_NO_OS_EFFECT'}]},
  }];
  let dispatches = 0;
  const callbacks = {
    runTaskGraph:async(input:unknown)=>{
      dispatches++;
      if(dispatches===1) {
        const error = new Error('synthetic ACK lost') as Error & {code:string};
        error.code = 'MUTATION_STATE_UNKNOWN';
        throw error;
      }
      return {data:{ok:true,graphId:(input as Record<string,unknown>).graph_id,
        summary:{total:1,succeeded:1,failed:0}}};
    },
    runAssertions:async()=>({data:{ok:true}}),
  };
  const first = await executeDurableRunbook({
    runbook_id:'clean10-original', steps,
  },original,callbacks) as {data:{
    steps:Array<{status:string,errorCode?:string}>;
  }};
  assert.equal(first.data.steps[0]?.errorCode,'MUTATION_STATE_UNKNOWN');
  assert.equal(dispatches,1);

  const restarted = new RunbookStore({stateFile});
  await restarted.initialize();
  // Same semantic effect but a new runbook ID: a different ID is not
  // independently authenticated authorization to execute another mutation.
  await executeDurableRunbook({
    runbook_id:'clean10-cloned',steps,
    resume:false,retry_unknown:false,retry_failed:false,
  },restarted,callbacks);

  await t.test('error must be recorded UNKNOWN, not retryable FAILED',()=>{
    assert.equal(first.data.steps[0]?.status,'unknown');
  });
  await t.test('new runbook ID must not replay the original uncertain effect',()=>{
    assert.equal(dispatches,1);
  });
});
