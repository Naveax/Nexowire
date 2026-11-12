import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskLoop,advanceTaskLoop} from '../src/coding/task-loop-engine.js';
import type {LoopCheckpoint} from '../src/coding/task-loop-engine.js';
import {reviewCodingLoopCrossOwner} from '../src/coding/task-loop-integration-review.js';
import type {CodingLoopControllerInput} from '../src/coding/task-loop-integration-review.js';

const T=1_800_000_000_000;
const h=(s:string)=>s.repeat(64),git=(s:string)=>s.repeat(40);
function fixture():CodingLoopControllerInput{
  const identity={
    tenantId:'tenantA',taskId:'task1',worktreeId:'33333333-3333-4333-8333-333333333333',
    logicalMutationId:'44444444-4444-4444-8444-444444444444',originalRequestId:'55555555-5555-4555-8555-555555555555',
    taskSha:h('a'),worktreeSha:git('b'),sourceSha:git('c'),ownerEpoch:7,
    grant:{grantId:'grant1',generation:3,scopeSha256:h('d'),
      signedGrantSha256:h('e'),expiresAtMs:T+100_000}
  };
  const loop=createTaskLoop({
    identity,limits:{maxActions:4,maxFixes:1,maxTokens:120,timeoutMs:10000},
    steps:[{id:'inspect',mode:'read_only',capability:'workspace.inspect',
      reservedTokens:10}]
  },T);
  return {loop,
    worker:{identity:{
      ownerAccountId:'11111111-1111-4111-8111-111111111111',deviceId:'22222222-2222-4222-8222-222222222222',
      taskId:'task1',worktreeId:'33333333-3333-4333-8333-333333333333',sourceSha:git('c'),
      stepId:'inspect',logicalMutationId:'44444444-4444-4444-8444-444444444444',
      originalRequestId:'55555555-5555-4555-8555-555555555555',ownerEpoch:7
    },mutationState:'not_sent'},
    checkpoint:{scope:{
      ownerId:'11111111-1111-4111-8111-111111111111',deviceId:'22222222-2222-4222-8222-222222222222',taskId:'task1',
      worktreeId:'33333333-3333-4333-8333-333333333333',sourceSha:git('c'),ownerEpoch:7,
      grantGeneration:3,signedGrantScopeDigest:h('f')
    },mutation:{
      logicalMutationId:'44444444-4444-4444-8444-444444444444',requestId:'55555555-5555-4555-8555-555555555555',
      state:'PLANNED',pendingUnknown:false
    },cancelled:false},
    quota:{binding:{
      ownerId:'11111111-1111-4111-8111-111111111111',deviceId:'22222222-2222-4222-8222-222222222222',
      logicalOperationId:'44444444-4444-4444-8444-444444444444',logicalMutationSha256:h('1'),
      ownerEpoch:7,grantGeneration:3
    },state:'NEVER_DISPATCHED'},
    worktree:{taskId:'task1',worktreeId:'33333333-3333-4333-8333-333333333333',sourceSha:git('c'),
      worktreeSha:git('b'),ownerEpoch:7,ownerGeneration:9}
  };
}
const clone=()=>structuredClone(fixture());
test('#33 NEXT2 fully matching #718/#819/#815 metadata is NOT a CAS permit',()=>{
  const f=fixture();const d=reviewCodingLoopCrossOwner(f);
  assert.equal(d.state,'BLOCKED');
  assert.equal(d.reason,'OFFHOST_CAS_NOT_PROVEN');
  assert.equal(d.mayDispatch,false);assert.equal(d.mayResumeTool,false);
  assert.equal(d.mayReplayMutation,false);
  assert.equal(d.mayClaimCompletedVerified,false);
});
test('missing checkpoint/lease/quota/worktree projection is not implicit authorization',()=>{
  for(const key of ['worker','checkpoint','quota','worktree'] as const){
    const f=clone();delete f[key];
    const d=reviewCodingLoopCrossOwner(f);
    assert.equal(d.reason,'CROSS_OWNER_PROJECTION_MISSING');
    assert.equal(d.mayDispatch,false);
  }
});
test('cloned runbook/original request and logicalMutationId aliases are rejected',()=>{
  for(const mutate of [
    (f:CodingLoopControllerInput)=>{f.worker!.identity.originalRequestId='clone-request'},
    (f:CodingLoopControllerInput)=>{f.checkpoint!.mutation.requestId='clone-request'},
    (f:CodingLoopControllerInput)=>{f.quota!.binding.logicalOperationId='clone-effect'},
    (f:CodingLoopControllerInput)=>{f.worker!.identity.logicalMutationId='clone-effect'},
  ]){
    const f=clone();mutate(f);
    assert.equal(reviewCodingLoopCrossOwner(f).reason,'CROSS_OWNER_SCOPE_MISMATCH');
  }
});
test('fresh owner epoch and grant generation must match all independent views',()=>{
  for(const mutate of [
    (f:CodingLoopControllerInput)=>{f.worker!.identity.ownerEpoch++},
    (f:CodingLoopControllerInput)=>{f.quota!.binding.grantGeneration++},
    (f:CodingLoopControllerInput)=>{f.checkpoint!.scope.grantGeneration++},
    (f:CodingLoopControllerInput)=>{f.worktree!.ownerEpoch++}
  ]){
    const f=clone();mutate(f);
    assert.equal(reviewCodingLoopCrossOwner(f).reason,'CROSS_OWNER_SCOPE_MISMATCH');
  }
});
test('Git sourceSha and worktree SHA drift never silently remap',()=>{
  for(const mutate of [
    (f:CodingLoopControllerInput)=>{f.worker!.identity.sourceSha=git('a')},
    (f:CodingLoopControllerInput)=>{f.checkpoint!.scope.sourceSha=git('a')},
    (f:CodingLoopControllerInput)=>{f.worktree!.worktreeSha=git('a')},
    (f:CodingLoopControllerInput)=>{f.worktree!.sourceSha=git('a')},
  ]){
    const f=clone();mutate(f);
    assert.equal(reviewCodingLoopCrossOwner(f).reason,'CROSS_OWNER_SCOPE_MISMATCH');
  }
});
test('#42 LOST_ACK beats healthy #718 NEVER_DISPATCHED claim',()=>{
  for(const s of ['dispatch_pending','ack_lost','journal_unknown'] as const){
    const f=clone();f.worker!.mutationState=s;
    const d=reviewCodingLoopCrossOwner(f);
    assert.equal(d.state,'RECONCILE_REQUIRED');
    assert.equal(d.reason,'MUTATION_STATE_UNKNOWN');
    assert.equal(d.originalRequestId,'55555555-5555-4555-8555-555555555555');
    assert.equal(d.logicalMutationId,'44444444-4444-4444-8444-444444444444');
  }
});
test('#34 UNKNOWN or #718 ambiguous dispatch stays RECONCILE_REQUIRED',()=>{
  for(const mutate of [
    (f:CodingLoopControllerInput)=>{f.checkpoint!.mutation.pendingUnknown=true},
    (f:CodingLoopControllerInput)=>{f.checkpoint!.mutation.state='RECONCILE_REQUIRED'},
    (f:CodingLoopControllerInput)=>{f.quota!.state='MUTATION_UNKNOWN'},
    (f:CodingLoopControllerInput)=>{f.quota!.state='DISPATCHED'},
  ]){
    const f=clone();mutate(f);
    assert.equal(reviewCodingLoopCrossOwner(f).state,'RECONCILE_REQUIRED');
  }
});
test('loop UNKNOWN terminal cannot be reclassified by newly healthy worker',()=>{
  const f=clone(),step=advanceTaskLoop(f.loop,{identity:f.loop.identity,nowMs:T+1});
  const cp=advanceTaskLoop(step.checkpoint,{
    identity:step.checkpoint.identity,nowMs:T+2,
    externalMutationState:'unknown'
  }).checkpoint;
  f.loop=cp;
  assert.equal(reviewCodingLoopCrossOwner(f).state,'RECONCILE_REQUIRED');
});
test('local cancellation or sealed approval withdrawal cannot grant admission',()=>{
  const f=clone();f.checkpoint!.cancelled=true;
  assert.equal(reviewCodingLoopCrossOwner(f).reason,'REVOKED_OR_CANCELLED');
});
test('fake/missing generation and forged local COMPLETED metadata remain denial',()=>{
  const f=clone();f.worktree!.ownerGeneration=0;
  assert.equal(reviewCodingLoopCrossOwner(f).reason,
    'WORKTREE_OWNER_GENERATION_NOT_ATOMICALLY_BOUND');
  const g=clone();
  (g.loop as LoopCheckpoint).status='STOPPED';
  (g.loop as LoopCheckpoint).reason='COMPLETED';
  assert.equal(reviewCodingLoopCrossOwner(g).mayClaimCompletedVerified,false);
  assert.equal(reviewCodingLoopCrossOwner(g).mayDispatch,false);
});

test('#33 NEXT4 persisted UNKNOWN survives clone + cancellation after reconnect',()=>{
  const f=clone();
  const started=advanceTaskLoop(f.loop,{
    identity:f.loop.identity,nowMs:T+1
  }).checkpoint;
  f.loop=advanceTaskLoop(started,{
    identity:started.identity,nowMs:T+2,
    externalMutationState:'unknown'
  }).checkpoint;
  f.checkpoint!.cancelled=true;
  f.worker!.identity.originalRequestId='cloned-request';
  f.worker!.identity.ownerEpoch++;
  f.quota!.binding.logicalOperationId='cloned-logical';
  f.worktree!.sourceSha=git('e');
  const decision=reviewCodingLoopCrossOwner(f);
  assert.equal(decision.reason,'MUTATION_STATE_UNKNOWN');
  assert.equal(decision.state,'RECONCILE_REQUIRED');
  assert.equal(decision.originalRequestId,
    '55555555-5555-4555-8555-555555555555');
  assert.equal(decision.mayReplayMutation,false);
  assert.equal(decision.mayDispatch,false);
});

test('#33 NEXT4 persisted CANCELLED terminal survives missing reconnect projections',()=>{
  const f=clone();
  f.loop=advanceTaskLoop(f.loop,{
    identity:f.loop.identity,nowMs:T+1,cancelled:true
  }).checkpoint;
  delete f.worker;
  delete f.quota;
  const decision=reviewCodingLoopCrossOwner(f);
  assert.equal(decision.reason,'REVOKED_OR_CANCELLED');
  assert.equal(decision.state,'BLOCKED');
  assert.equal(decision.mayResumeTool,false);
  assert.equal(decision.mayDispatch,false);
});
