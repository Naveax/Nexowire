import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runRecoverableSystemHubCutover,
  SystemCutoverFailed,
  type SystemCutoverOperations,
} from '../../src/hub/system-cutover-orchestrator.js';

const steps=[
  'preflight','armRecovery','confirmRecoveryBeforeQuiesce',
  'quiesceLegacy','copyProtectedState','issueReceipt',
  'installSystemHub','verifySystemHub','commit',
] as const;

type Step=typeof steps[number];
function disposableAdapter(failure:Step,failRecovery=false){
  const events:string[]=[];
  const operations={} as SystemCutoverOperations;
  for(const step of steps){
    operations[step]=async()=>{
      events.push(step);
      if(step===failure)throw new Error('FI_'+step);
    };
  }
  operations.rollback=async()=>{
    events.push('rollback');
    if(failRecovery)throw new Error('FI_rollback');
  };
  return {operations,events};
}

test('UNKNOWN commit cannot automatically replay the legacy Hub writer',async()=>{
  const {operations,events}=disposableAdapter('commit',true);
  await assert.rejects(runRecoverableSystemHubCutover(operations),(failure:unknown)=>
    failure instanceof SystemCutoverFailed&&
    failure.failedStep==='commit'&&
    failure.rollbackAttempted===false&&
    failure.rollbackFailed===false);
  assert.deepEqual(events,[...steps]);
});

test('pre-commit failure requests independent rollback at most once',async()=>{
  for(const failedStep of [
    'quiesceLegacy','copyProtectedState','issueReceipt',
    'installSystemHub','verifySystemHub',
  ] as const){
    const {operations,events}=disposableAdapter(failedStep);
    await assert.rejects(runRecoverableSystemHubCutover(operations),(failure:unknown)=>
      failure instanceof SystemCutoverFailed&&
      failure.rollbackAttempted===true&&
      failure.rollbackFailed===false);
    assert.equal(events.filter(event=>event==='rollback').length,1);
    assert.equal(events.at(-1),'rollback');
  }
});

test('interrupted recovery never gets labelled as completed rollback',async()=>{
  const {operations,events}=disposableAdapter('copyProtectedState',true);
  await assert.rejects(runRecoverableSystemHubCutover(operations),(failure:unknown)=>
    failure instanceof SystemCutoverFailed&&
    failure.failedStep==='copy-protected-state'&&
    failure.rollbackFailed===true&&
    failure.cause instanceof AggregateError);
  assert.equal(events.filter(event=>event==='rollback').length,1);
});
