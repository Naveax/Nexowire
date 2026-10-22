import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentLoopCheckpointV1Schema,reviewAgentLoopCheckpoint}
  from '../src/agent/agent-loop-journal-contract.js';

function example(){
  return {
    version:1 as const,taskId:'coding-task-01',stepId:'run-shell-01',
    requestId:randomUUID(),fingerprint:'f'.repeat(64),
    capability:'shell.exec',ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
    ownerEpoch:4,grantGeneration:8,
    sourceSha:'a'.repeat(40),
    state:'RECONCILE_REQUIRED' as const,
    originalErrorCode:'MUTATION_STATE_UNKNOWN',
  };
}
function record(cp:{requestId:string;fingerprint:string;capability:string},
  status:'in_progress'|'unknown'|'succeeded'|'failed'='unknown'){
  return {
    requestId:cp.requestId,fingerprint:cp.fingerprint,
    capability:cp.capability,status,
  };
}
test('UNKNOWN maps to RECONCILE_REQUIRED with immutable request ID and no replay',()=>{
  const cp=example();
  const r=reviewAgentLoopCheckpoint(cp,record(cp));
  assert.equal(r.state,'RECONCILE_REQUIRED');
  assert.equal(r.nextAction,'READ_ONLY_RECONCILIATION');
  assert.equal(r.requestId,cp.requestId);
  assert.equal(r.originalErrorCode,'MUTATION_STATE_UNKNOWN');
  assert.equal(r.mayReplay,false);
  assert.equal(r.mayDispatch,false);
  assert.equal(r.completedVerified,false);
});
test('missing Agent journal row cannot prove never dispatched after rollback',()=>{
  const cp=example();
  const r=reviewAgentLoopCheckpoint(cp);
  assert.equal(r.state,'RECONCILE_REQUIRED');
  assert.equal(r.reason,'JOURNAL_ROW_MISSING');
  assert.equal(r.mayReplay,false);
});
test('in progress after possible dispatch remains read-only reconciliation',()=>{
  const cp=example();
  const r=reviewAgentLoopCheckpoint(cp,{
    ...record(cp,'in_progress'),dispatchedAt:new Date().toISOString(),
  });
  assert.equal(r.state,'RECONCILE_REQUIRED');
  assert.equal(r.mayDispatch,false);
});
test('old requestId cannot be silently replaced during checkpoint resume',()=>{
  const old=AgentLoopCheckpointV1Schema.parse(example());
  const newer={...old,requestId:randomUUID()};
  const r=reviewAgentLoopCheckpoint(newer,undefined,old);
  assert.equal(r.state,'SCOPE_MISMATCH');
  assert.equal(r.nextAction,'STOP');
});
test('owner, device, session and grant epochs are immutable on resume',()=>{
  const old=AgentLoopCheckpointV1Schema.parse(example());
  const changed=[
    {...old,ownerEpoch:old.ownerEpoch+1},
    {...old,grantGeneration:old.grantGeneration+1},
    {...old,deviceEpoch:randomUUID()},
    {...old,sessionEpoch:randomUUID()},
    {...old,ownerId:randomUUID()},
    {...old,deviceId:randomUUID()},
  ];
  for(const cp of changed){
    const r=reviewAgentLoopCheckpoint(cp,undefined,old);
    assert.equal(r.state,'SCOPE_MISMATCH');
    assert.equal(r.mayReplay,false);
  }
});
test('journal fingerprint or capability conflicts fail closed',()=>{
  const cp=example();
  for(const row of [
    {...record(cp),fingerprint:'0'.repeat(64)},
    {...record(cp),capability:'files.write'},
    {...record(cp),requestId:randomUUID()},
  ])assert.equal(reviewAgentLoopCheckpoint(cp,row).nextAction,'STOP');
});
test('local succeeded with verified shell exit is NOT physical completion',()=>{
  const cp={...example(),state:'LOCAL_TERMINAL_NEEDS_PROOF' as const,
    originalErrorCode:undefined};
  const r=reviewAgentLoopCheckpoint(cp,{
    ...record(cp,'succeeded'),evidenceVerified:true,
  });
  assert.equal(r.state,'READ_ONLY_INSPECTION');
  assert.equal(r.reason,'LOCAL_TERMINAL_NOT_INDEPENDENT_PROOF');
  assert.equal(r.completedVerified,false);
});
test('checkpoint forbids raw command, secrets and unsupported statuses',()=>{
  const cp=example();
  assert.equal(AgentLoopCheckpointV1Schema.safeParse(
    {...cp,command:'erase everything'}).success,false);
  assert.equal(AgentLoopCheckpointV1Schema.safeParse(
    {...cp,apiToken:'private'}).success,false);
  assert.equal(AgentLoopCheckpointV1Schema.safeParse(
    {...cp,state:'COMPLETED_VERIFIED'}).success,false);
  assert.equal(AgentLoopCheckpointV1Schema.safeParse(
    {...cp,ownerEpoch:-1}).success,false);
});
test('read-only classifier returns a frozen decision, not a mutation grant',()=>{
  const cp=example();
  const r=reviewAgentLoopCheckpoint(cp,record(cp));
  assert.equal(Object.isFrozen(r),true);
  assert.equal('execute' in r,false);
  assert.equal('token' in r,false);
});
