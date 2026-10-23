/** #33 source-only hostile test fixtures. No shell, network, Agent or VM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceTaskLoop,createTaskLoop,TaskLoopError} from '../src/coding/task-loop-engine.js';
import type {LoopCheckpoint,LoopIdentity,LoopPlan,LoopRuntimeContext} from '../src/coding/task-loop-engine.js';
const t0=1_800_000_000_000;
const H=(c:string)=>c.repeat(64);
const C=(c:string)=>c.repeat(40);
const identity=(tenantId='tenant-A'):LoopIdentity=>({
  tenantId,taskId:'task-1',worktreeId:'wt-1',
  logicalMutationId:'logical-effect-1',originalRequestId:'request-original-1',
  taskSha:H('a'),worktreeSha:C('b'),sourceSha:C('c'),ownerEpoch:7,
  grant:{grantId:'grant-1',generation:2,scopeSha256:H('d'),
    signedGrantSha256:H('e'),expiresAtMs:t0+20000}
});
const plan=(mode:'read_only'|'dry_run'|'mutation'='read_only',tenant='tenant-A'):LoopPlan=>({
  identity:identity(tenant),limits:{maxActions:4,maxFixes:1,maxTokens:100,timeoutMs:10000},
  steps:[{id:'step-1',mode,capability:'workspace.inspect',reservedTokens:10}]
});
const context=(cp:LoopCheckpoint,extra:Partial<LoopRuntimeContext>={}):LoopRuntimeContext=>({
  nowMs:t0+1,identity:structuredClone(cp.identity),...extra
});
const evidence=(cp:LoopCheckpoint,result:'ok'|'failed'|'unknown'='ok'):
  NonNullable<LoopRuntimeContext['evidence']>=>({
    kind:'observation',intentId:cp.pending!.intentId,
    originalRequestId:cp.identity.originalRequestId,
    logicalMutationId:cp.identity.logicalMutationId,
    worktreeSha:cp.identity.worktreeSha,ownerEpoch:cp.identity.ownerEpoch,
    signedGrantSha256:cp.identity.grant.signedGrantSha256,result,tokensUsed:3
  });
const proof=(cp:LoopCheckpoint,passed=true):
  NonNullable<LoopRuntimeContext['evidence']>=>({
    kind:'test',intentId:cp.testForIntentId!,
    originalRequestId:cp.identity.originalRequestId,
    logicalMutationId:cp.identity.logicalMutationId,
    worktreeSha:cp.identity.worktreeSha,ownerEpoch:cp.identity.ownerEpoch,
    signedGrantSha256:cp.identity.grant.signedGrantSha256,passed,tokensUsed:5
  });
function issue(cp:LoopCheckpoint){
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  const r=advanceTaskLoop(cp,context(cp));
  assert.equal(r.action.kind,'TOOL_INTENT');
  assert.equal(r.action.canExecuteMutation,false);
  return r.checkpoint;
}
test('PLAN > read-only TOOL > OBSERVE > TEST > STOP, metadata only',()=>{
  let cp=issue(createTaskLoop(plan(),t0));
  assert.equal(cp.phase,'OBSERVE');assert.equal(cp.usedActions,1);
  cp=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp)})).checkpoint;
  assert.equal(cp.phase,'TEST');
  cp=advanceTaskLoop(cp,context(cp,{evidence:proof(cp)})).checkpoint;
  assert.equal(cp.status,'STOPPED');assert.equal(cp.reason,'COMPLETED');
  assert.equal(cp.usedTokens,18);
  assert.doesNotMatch(JSON.stringify(cp),/stdout|password|shellCommand/);
});
test('restore never redispatches awaiting read-only/dry-run intent',()=>{
  for(const mode of ['read_only','dry_run'] as const){
    const cp=issue(createTaskLoop(plan(mode),t0));
    const restored=JSON.parse(JSON.stringify(cp)) as LoopCheckpoint;
    for(let n=0;n<3;n++){
      const r=advanceTaskLoop(restored,context(restored));
      assert.equal(r.action.kind,'AWAIT_OBSERVATION');
      assert.deepEqual(r.checkpoint,restored);
    }
  }
});
test('#781 hostile cloned runbook alias cannot execute mutation with same logical ID',()=>{
  for(const id of ['runbook-A','runbook-B']){
    const p=plan('mutation');p.identity.taskId=id;
    let cp=createTaskLoop(p,t0);
    cp=advanceTaskLoop(cp,context(cp)).checkpoint;
    const r=advanceTaskLoop(cp,context(cp));
    assert.equal(r.checkpoint.status,'RECONCILE_REQUIRED');
    assert.equal(r.checkpoint.reason,'EXTERNAL_CAS_REQUIRED');
    assert.equal(r.action.kind,'STOP');
    assert.equal(r.action.canExecuteMutation,false);
  }
});
test('lost ACK UNKNOWN retains immutable request, operation and receipt for reconciliation',()=>{
  const cp=issue(createTaskLoop(plan(),t0));
  const r=advanceTaskLoop(cp,context(cp,{
    evidence:{...evidence(cp,'failed'),errorCode:'MUTATION_STATE_UNKNOWN'}
  }));
  assert.equal(r.checkpoint.status,'RECONCILE_REQUIRED');
  assert.equal(r.checkpoint.reason,'MUTATION_STATE_UNKNOWN');
  assert.equal(r.checkpoint.pending?.intentId,cp.pending?.intentId);
  assert.equal(r.checkpoint.identity.originalRequestId,'request-original-1');
  assert.equal(r.checkpoint.identity.logicalMutationId,'logical-effect-1');
  const again=advanceTaskLoop(r.checkpoint,context(r.checkpoint));
  assert.equal(again.action.kind,'STOP');
  assert.equal(again.checkpoint.pending?.intentId,cp.pending?.intentId);
});
test('external UNKNOWN/in-progress inventory blocks preview and dispatch',()=>{
  for(const state of ['unknown','in_progress'] as const){
    const cp=createTaskLoop(plan(),t0);
    const r=advanceTaskLoop(cp,context(cp,{externalMutationState:state}));
    assert.equal(r.checkpoint.status,'RECONCILE_REQUIRED');
    assert.equal(r.checkpoint.reason,'MUTATION_STATE_UNKNOWN');
  }
});
test('owner epoch, signed grant generation, scope and SHA drift fail closed',()=>{
  for(const mutate of [
    (i:LoopIdentity)=>{i.ownerEpoch++},
    (i:LoopIdentity)=>{i.grant.generation++},
    (i:LoopIdentity)=>{i.grant.signedGrantSha256=H('f')},
    (i:LoopIdentity)=>{i.worktreeSha=C('d')},
    (i:LoopIdentity)=>{i.sourceSha=C('d')},
    (i:LoopIdentity)=>{i.taskSha=H('b')},
    (i:LoopIdentity)=>{i.originalRequestId='cloned-request'},
    (i:LoopIdentity)=>{i.logicalMutationId='cloned-effect'},
    (i:LoopIdentity)=>{i.tenantId='tenant-B'}
  ]){
    const cp=createTaskLoop(plan(),t0);
    const ctx=context(cp);mutate(ctx.identity);
    const r=advanceTaskLoop(cp,ctx);
    assert.equal(r.checkpoint.status,'BLOCKED');
    assert.equal(r.checkpoint.reason,'SCOPE_MISMATCH');
  }
});
test('grant revoke, expire, cancellation and in-flight cancellation',()=>{
  const cp=createTaskLoop(plan(),t0);
  assert.equal(advanceTaskLoop(cp,context(cp,{grantRevoked:true})).checkpoint.reason,
    'GRANT_REVOKED');
  assert.equal(advanceTaskLoop(cp,context(cp,{nowMs:t0+20000})).checkpoint.reason,
    'GRANT_EXPIRED');
  assert.equal(advanceTaskLoop(cp,context(cp,{cancelled:true})).checkpoint.status,
    'STOPPED');
  const pending=issue(cp);
  const r=advanceTaskLoop(pending,context(pending,{cancelled:true}));
  assert.equal(r.checkpoint.status,'RECONCILE_REQUIRED');
  assert.equal(r.checkpoint.pending?.intentId,pending.pending?.intentId);
});
test('deadline is not reset by JSON checkpoint resume',()=>{
  const cp=issue(createTaskLoop(plan(),t0));
  const restored=JSON.parse(JSON.stringify(cp)) as LoopCheckpoint;
  const r=advanceTaskLoop(restored,context(restored,{nowMs:t0+10000}));
  assert.equal(r.checkpoint.status,'RECONCILE_REQUIRED');
  assert.equal(r.checkpoint.reason,'BUDGET_EXHAUSTED');
  assert.equal(r.checkpoint.deadlineMs,t0+10000);
});
test('tenant-A saturated capacity waits; tenant-B can proceed fairly',()=>{
  const pa=plan('read_only','tenant-A'),pb=plan('read_only','tenant-B');
  const a=advanceTaskLoop(createTaskLoop(pa,t0),{
    nowMs:t0+1,identity:pa.identity}).checkpoint;
  const b=advanceTaskLoop(createTaskLoop(pb,t0),{
    nowMs:t0+1,identity:pb.identity}).checkpoint;
  const waiting=advanceTaskLoop(a,context(a,{
    tenantCapacity:{activeGlobal:1,activeTenant:1,maxGlobal:2,maxPerTenant:1}
  }));
  assert.equal(waiting.action.kind,'WAIT_TENANT_CAPACITY');
  assert.equal(waiting.checkpoint.usedActions,0);
  const next=advanceTaskLoop(b,context(b,{
    tenantCapacity:{activeGlobal:1,activeTenant:0,maxGlobal:2,maxPerTenant:1}
  }));
  assert.equal(next.action.kind,'TOOL_INTENT');
  assert.equal(next.checkpoint.usedActions,1);
});
test('TEST failure enters FIX, bounded to one retry without execution',()=>{
  let cp=issue(createTaskLoop(plan('dry_run'),t0));
  cp=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp)})).checkpoint;
  cp=advanceTaskLoop(cp,context(cp,{evidence:proof(cp,false)})).checkpoint;
  assert.equal(cp.phase,'FIX');
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  assert.equal(cp.phase,'TOOL');assert.equal(cp.usedFixes,1);
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  assert.equal(cp.attempt,2);assert.equal(cp.usedActions,2);
  cp=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp,'failed')})).checkpoint;
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  assert.equal(cp.reason,'TEST_FAILED');
});
test('action and token limits stop previews',()=>{
  const p=plan();p.limits.maxActions=1;
  let cp=issue(createTaskLoop(p,t0));
  cp=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp,'failed')})).checkpoint;
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  assert.equal(cp.reason,'BUDGET_EXHAUSTED');
  const q=plan();q.limits.maxTokens=12;
  let c=issue(createTaskLoop(q,t0));
  c=advanceTaskLoop(c,context(c,{evidence:evidence(c)})).checkpoint;
  assert.equal(c.reason,'BUDGET_EXHAUSTED');
});
test('wrong logical ID, forged observation and late replay rejected',()=>{
  const cp=issue(createTaskLoop(plan(),t0));
  const forged={...evidence(cp),logicalMutationId:'unrelated-effect'};
  assert.throws(()=>advanceTaskLoop(cp,context(cp,{evidence:forged})),
    (e:unknown)=>e instanceof TaskLoopError&&e.code==='EVIDENCE_MISMATCH');
  const tested=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp)})).checkpoint;
  assert.throws(()=>advanceTaskLoop(tested,context(tested,{evidence:evidence(cp)})),
    /Unexpected or duplicate evidence/);
});
test('reject command/secret fields, duplicate steps, invalid budgets',()=>{
  const p=plan();(p.steps[0] as unknown as Record<string,unknown>).shellCommand='unsafe';
  assert.throws(()=>createTaskLoop(p,t0));
  const q=plan();q.limits.maxActions=65;
  assert.throws(()=>createTaskLoop(q,t0));
  const d=plan();d.steps.push({...d.steps[0]!});
  assert.throws(()=>createTaskLoop(d,t0));
});
test('immutable checkpoint changes and altered deadline detected before resume',()=>{
  const cp=createTaskLoop(plan(),t0);
  for(const mutate of [
    (c:LoopCheckpoint)=>{c.identity.worktreeSha=C('f')},
    (c:LoopCheckpoint)=>{c.identity.grant.scopeSha256=H('c')},
    (c:LoopCheckpoint)=>{c.deadlineMs+=10000}
  ]){
    const restored=structuredClone(cp);mutate(restored);
    assert.throws(()=>advanceTaskLoop(restored,context(restored)),
      (e:unknown)=>e instanceof TaskLoopError&&e.code==='INVALID_LOOP_CHECKPOINT');
  }
});

test('#33 NEXT4 UNKNOWN checkpoint survives cancel and cloned reconnect authority',()=>{
  const original=issue(createTaskLoop(plan('dry_run'),t0));
  const unknown=advanceTaskLoop(original,context(original,{
    evidence:{...evidence(original,'unknown'),errorCode:'MUTATION_STATE_UNKNOWN'}
  })).checkpoint;
  assert.equal(unknown.status,'RECONCILE_REQUIRED');
  const changed=structuredClone(unknown.identity);
  changed.ownerEpoch++;
  changed.originalRequestId='forged-new-request';
  changed.worktreeSha='f'.repeat(40);
  const after=advanceTaskLoop(JSON.parse(JSON.stringify(unknown)),context(unknown,{
    identity:changed,cancelled:true,grantRevoked:true,
    externalMutationState:'none'
  }));
  assert.deepEqual(after.checkpoint,unknown);
  assert.equal(after.action.kind,'STOP');
  assert.equal(after.action.canExecuteMutation,false);
  assert.equal(after.checkpoint.reason,'MUTATION_STATE_UNKNOWN');
  assert.equal(after.checkpoint.pending?.intentId,original.pending?.intentId);
});

test('#33 NEXT4 cancelled terminal cannot be reset by reconnect epoch drift',()=>{
  const cp=createTaskLoop(plan(),t0);
  const cancelled=advanceTaskLoop(cp,context(cp,{cancelled:true})).checkpoint;
  const authority=structuredClone(cancelled.identity);
  authority.ownerEpoch++;
  const result=advanceTaskLoop(cancelled,context(cancelled,{identity:authority}));
  assert.deepEqual(result.checkpoint,cancelled);
  assert.equal(result.checkpoint.reason,'CANCELLED');
  assert.equal(result.action.kind,'STOP');
});

test('#33 NEXT4 exhausted budget beats repeat tenant wait and cannot propose tools',()=>{
  const p=plan('read_only');
  p.limits.maxActions=1;
  let cp=issue(createTaskLoop(p,t0));
  cp=advanceTaskLoop(cp,context(cp,{evidence:evidence(cp,'failed')})).checkpoint;
  assert.equal(cp.phase,'FIX');
  cp=advanceTaskLoop(cp,context(cp)).checkpoint;
  assert.equal(cp.phase,'TOOL');
  const saturated={
    activeGlobal:2,activeTenant:1,maxGlobal:2,maxPerTenant:1
  };
  let result=advanceTaskLoop(cp,context(cp,{tenantCapacity:saturated}));
  assert.equal(result.action.kind,'STOP');
  assert.equal(result.checkpoint.reason,'BUDGET_EXHAUSTED');
  assert.equal(result.checkpoint.usedActions,1);
  for(let i=0;i<5;i++){
    result=advanceTaskLoop(result.checkpoint,context(result.checkpoint,{
      tenantCapacity:saturated
    }));
    assert.equal(result.action.kind,'STOP');
    assert.equal(result.checkpoint.usedActions,1);
    assert.equal(result.checkpoint.pending,undefined);
    assert.equal(result.action.canExecuteMutation,false);
  }
});
