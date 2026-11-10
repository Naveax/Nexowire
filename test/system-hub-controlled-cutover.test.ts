import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecoverableSystemHubCutover,SystemCutoverFailed,type SystemCutoverOperations} from '../src/hub/system-cutover-orchestrator.js';
const phases=['preflight','armRecovery','quiesceLegacy','copyProtectedState',
  'issueReceipt','installSystemHub','verifySystemHub','commit'] as const;
function setup(fail?:string,rollbackFails=false){
  const events:string[]=[];
  const ops={} as SystemCutoverOperations;
  for(const key of phases){
    ops[key]=async()=>{
      events.push(key);
      if(key===fail)throw new Error('FI_'+key);
    };
  }
  ops.rollback=async()=>{events.push('rollback');if(rollbackFails)throw new Error('FI_rollback')};
  return {ops,events};
}
test('cutover never stops the writer without preflight and durable recovery',async()=>{
  const {ops,events}=setup('preflight');
  await assert.rejects(runRecoverableSystemHubCutover(ops),/FI_preflight/);
  assert.deepEqual(events,['preflight']);
});
test('cutover executes ordered, recoverable physical steps',async()=>{
  const {ops,events}=setup();
  const result=await runRecoverableSystemHubCutover(ops);
  assert.deepEqual(events,[...phases]);
  assert.equal(result.physicalRebootAccepted,false);
});
for(const phase of phases.slice(1)){
  test('failure at '+phase+' invokes exactly one rollback',async()=>{
    const {ops,events}=setup(phase);
    await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>
      error instanceof SystemCutoverFailed && !error.rollbackFailed);
    assert.equal(events.at(-1),'rollback');
    assert.equal(events.filter(event=>event==='rollback').length,1);
    assert.equal(events.includes('commit'),phase==='commit');
    assert.equal(events.includes('verifySystemHub'),phases.indexOf(phase)>=6);
  });
}
test('rollback failure remains explicit, never presented as recovered',async()=>{
  const {ops,events}=setup('copyProtectedState',true);
  await assert.rejects(runRecoverableSystemHubCutover(ops),(error:unknown)=>
    error instanceof SystemCutoverFailed&&error.rollbackFailed&&
    error.cause instanceof AggregateError);
  assert.equal(events.at(-1),'rollback');
});
