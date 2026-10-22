/**
 * #33 isolated deterministic PLAN > TOOL > OBSERVE > TEST > FIX > STOP.
 * This is a metadata-only source contract. NO executor, native mutation,
 * filesystem, Git subprocess, grant verification, persistence or external CAS.
 * Emitted intents must never be interpreted as execution permission.
 */
import {createHash} from 'node:crypto';

export type LoopPhase='PLAN'|'TOOL'|'OBSERVE'|'TEST'|'FIX'|'STOP';
export type ToolMode='read_only'|'dry_run'|'mutation';
export type LoopStatus='ACTIVE'|'STOPPED'|'RECONCILE_REQUIRED'|'BLOCKED';
export type LoopReason='COMPLETED'|'CANCELLED'|'BUDGET_EXHAUSTED'|'TEST_FAILED'
  |'SCOPE_MISMATCH'|'GRANT_REVOKED'|'GRANT_EXPIRED'
  |'MUTATION_STATE_UNKNOWN'|'EXTERNAL_CAS_REQUIRED';
export interface LoopIdentity {
  tenantId:string;taskId:string;worktreeId:string;logicalMutationId:string;
  originalRequestId:string;taskSha:string;worktreeSha:string;sourceSha:string;
  ownerEpoch:number;
  grant:{grantId:string;generation:number;scopeSha256:string;
    signedGrantSha256:string;expiresAtMs:number};
}
export interface LoopLimits {
  maxActions:number;maxFixes:number;maxTokens:number;timeoutMs:number;
}
export interface LoopStep {
  id:string;mode:ToolMode;capability:string;reservedTokens:number;
}
export interface LoopPlan {identity:LoopIdentity;limits:LoopLimits;steps:LoopStep[]}
export interface LoopPending {
  intentId:string;stepId:string;attempt:number;mode:'read_only'|'dry_run';
}
export interface LoopCheckpoint extends LoopPlan {
  version:1;immutableSha256:string;startedAtMs:number;deadlineMs:number;
  phase:LoopPhase;status:LoopStatus;reason?:LoopReason;stepIndex:number;
  attempt:number;usedActions:number;usedFixes:number;usedTokens:number;
  pending?:LoopPending;testForIntentId?:string;
}
export interface LoopRuntimeContext {
  nowMs:number;identity:LoopIdentity;cancelled?:boolean;grantRevoked?:boolean;
  externalMutationState?:'none'|'in_progress'|'unknown'|'completed';
  tenantCapacity?:{activeGlobal:number;activeTenant:number;
    maxGlobal:number;maxPerTenant:number};
  evidence?:
    |{kind:'observation';intentId:string;originalRequestId:string;
      logicalMutationId:string;worktreeSha:string;ownerEpoch:number;
      signedGrantSha256:string;result:'ok'|'failed'|'unknown';
      errorCode?:string;tokensUsed:number}
    |{kind:'test';intentId:string;originalRequestId:string;
      logicalMutationId:string;worktreeSha:string;ownerEpoch:number;
      signedGrantSha256:string;passed:boolean;errorCode?:string;tokensUsed:number};
}
export type LoopAction=
  |{kind:'PLAN_REVIEW';stepId:string;canExecuteMutation:false}
  |{kind:'TOOL_INTENT';intent:LoopPending;capability:string;canExecuteMutation:false}
  |{kind:'AWAIT_OBSERVATION';intentId:string;canExecuteMutation:false}
  |{kind:'TEST_REQUEST';intentId:string;canExecuteMutation:false}
  |{kind:'FIX_REVIEW';stepId:string;canExecuteMutation:false}
  |{kind:'WAIT_TENANT_CAPACITY';canExecuteMutation:false}
  |{kind:'STOP';reason:LoopReason;canExecuteMutation:false};
export interface LoopTransition {checkpoint:LoopCheckpoint;action:LoopAction}
const sha=(v:string):string=>createHash('sha256').update(v,'utf8').digest('hex');
const hex=(v:unknown,n:number):boolean=>typeof v==='string'&&
  new RegExp('^[0-9a-f]{'+n+'}$').test(v);
const label=(v:unknown):boolean=>typeof v==='string'&&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
export class TaskLoopError extends Error {
  public readonly code:'INVALID_LOOP_PLAN'|'INVALID_LOOP_CHECKPOINT'|'EVIDENCE_MISMATCH';
  constructor(code:TaskLoopError['code'],message:string){
    super(message);this.code=code;this.name='TaskLoopError';
  }
}
function exactKeys(v:object,keys:readonly string[]):boolean{
  return Object.keys(v).every(k=>keys.includes(k));
}
function validIdentity(i:LoopIdentity):boolean{
  if(!i||typeof i!=='object'||!exactKeys(i,[
    'tenantId','taskId','worktreeId','logicalMutationId','originalRequestId',
    'taskSha','worktreeSha','sourceSha','ownerEpoch','grant']))return false;
  const g=i.grant;
  return [i.tenantId,i.taskId,i.worktreeId,i.logicalMutationId,i.originalRequestId].every(label)&&
    [i.taskSha,i.worktreeSha,i.sourceSha].every(v=>hex(v,40)||hex(v,64))&&
    natural(i.ownerEpoch)&&Boolean(g&&typeof g==='object'&&
      exactKeys(g,['grantId','generation','scopeSha256','signedGrantSha256','expiresAtMs'])&&
      label(g.grantId)&&natural(g.generation)&&
      hex(g.scopeSha256,64)&&hex(g.signedGrantSha256,64)&&
      natural(g.expiresAtMs)&&g.signedGrantSha256!==g.scopeSha256);
}
function validPlan(p:LoopPlan):boolean{
  if(!p||typeof p!=='object'||!validIdentity(p.identity)||
    !p.limits||typeof p.limits!=='object'||!Array.isArray(p.steps)||
    !exactKeys(p.limits,['maxActions','maxFixes','maxTokens','timeoutMs']))return false;
  const b=p.limits;
  if(!natural(b.maxActions)||b.maxActions<1||b.maxActions>64||
    !natural(b.maxFixes)||b.maxFixes>8||
    !natural(b.maxTokens)||b.maxTokens<1||b.maxTokens>1000000||
    !natural(b.timeoutMs)||b.timeoutMs<100||b.timeoutMs>7200000||
    p.steps.length<1||p.steps.length>32)return false;
  const seen=new Set<string>();
  for(const s of p.steps){
    if(!s||typeof s!=='object'||
      !exactKeys(s,['id','mode','capability','reservedTokens'])||
      !label(s.id)||seen.has(s.id)||!label(s.capability)||
      !['read_only','dry_run','mutation'].includes(s.mode)||
      !natural(s.reservedTokens)||s.reservedTokens<1||
      s.reservedTokens>b.maxTokens)return false;
    seen.add(s.id);
  }
  return true;
}
function immutableHash(p:LoopPlan):string{
  const i=p.identity,g=i.grant,b=p.limits;
  return sha(JSON.stringify({
    tenantId:i.tenantId,taskId:i.taskId,worktreeId:i.worktreeId,
    logicalMutationId:i.logicalMutationId,originalRequestId:i.originalRequestId,
    taskSha:i.taskSha,worktreeSha:i.worktreeSha,sourceSha:i.sourceSha,
    ownerEpoch:i.ownerEpoch,grantId:g.grantId,generation:g.generation,
    scopeSha256:g.scopeSha256,signedGrantSha256:g.signedGrantSha256,
    expiresAtMs:g.expiresAtMs,maxActions:b.maxActions,maxFixes:b.maxFixes,
    maxTokens:b.maxTokens,timeoutMs:b.timeoutMs,
    steps:p.steps.map(s=>[s.id,s.mode,s.capability,s.reservedTokens])
  }));
}
export function createTaskLoop(plan:LoopPlan,nowMs:number):LoopCheckpoint{
  if(!validPlan(plan)||!natural(nowMs)||
    nowMs>Number.MAX_SAFE_INTEGER-plan.limits.timeoutMs)
    throw new TaskLoopError('INVALID_LOOP_PLAN','Malformed or over-budget task loop plan.');
  const cloned=structuredClone(plan);
  return {...cloned,version:1,immutableSha256:immutableHash(cloned),
    startedAtMs:nowMs,deadlineMs:nowMs+cloned.limits.timeoutMs,
    phase:'PLAN',status:'ACTIVE',stepIndex:0,attempt:0,
    usedActions:0,usedFixes:0,usedTokens:0};
}
function validated(cp:LoopCheckpoint):void{
  if(!cp||typeof cp!=='object'||!validPlan(cp)||cp.version!==1||
    !hex(cp.immutableSha256,64)||cp.immutableSha256!==immutableHash(cp)||
    !natural(cp.startedAtMs)||!natural(cp.deadlineMs)||
    cp.deadlineMs!==cp.startedAtMs+cp.limits.timeoutMs||
    !natural(cp.stepIndex)||cp.stepIndex>=cp.steps.length||
    !natural(cp.attempt)||!natural(cp.usedActions)||
    cp.usedActions>cp.limits.maxActions||
    !natural(cp.usedFixes)||cp.usedFixes>cp.limits.maxFixes||
    !natural(cp.usedTokens)||cp.usedTokens>cp.limits.maxTokens||
    !['PLAN','TOOL','OBSERVE','TEST','FIX','STOP'].includes(cp.phase)||
    !['ACTIVE','STOPPED','RECONCILE_REQUIRED','BLOCKED'].includes(cp.status)||
    (cp.status==='ACTIVE'&&cp.phase==='STOP')||
    (cp.status!=='ACTIVE'&&cp.phase!=='STOP')||
    (cp.phase==='OBSERVE'&&!cp.pending)||
    (cp.pending&&cp.phase!=='OBSERVE'&&
      !(cp.phase==='STOP'&&cp.status==='RECONCILE_REQUIRED'))||
    (cp.phase==='TEST'&&!cp.testForIntentId)||
    (cp.testForIntentId&&cp.phase!=='TEST'&&
      !(cp.phase==='STOP'&&cp.status==='RECONCILE_REQUIRED'))||
    (cp.pending&&(!hex(cp.pending.intentId,64)||!label(cp.pending.stepId)||
      cp.pending.stepId!==cp.steps[cp.stepIndex]?.id||
      cp.pending.attempt!==cp.attempt||
      cp.pending.mode!==cp.steps[cp.stepIndex]?.mode)))
    throw new TaskLoopError('INVALID_LOOP_CHECKPOINT',
      'Checkpoint invalid or immutable scope changed.');
}
function stopped(cp:LoopCheckpoint,status:LoopStatus,reason:LoopReason):LoopTransition{
  return {checkpoint:{...cp,phase:'STOP',status,reason,
    pending:status==='RECONCILE_REQUIRED'?cp.pending:undefined,
    testForIntentId:status==='RECONCILE_REQUIRED'?cp.testForIntentId:undefined},
    action:{kind:'STOP',reason,canExecuteMutation:false}};
}
function scoped(a:LoopIdentity,b:LoopIdentity):boolean{
  const limits={maxActions:1,maxFixes:0,maxTokens:1,timeoutMs:100};
  const steps:LoopStep[]=[{id:'scope',mode:'read_only',capability:'scope',reservedTokens:1}];
  return immutableHash({identity:a,limits,steps})===
    immutableHash({identity:b,limits,steps});
}
function evidenceValid(cp:LoopCheckpoint,e:NonNullable<LoopRuntimeContext['evidence']>,id:string):boolean{
  return e.intentId===id&&
    e.originalRequestId===cp.identity.originalRequestId&&
    e.logicalMutationId===cp.identity.logicalMutationId&&
    e.worktreeSha===cp.identity.worktreeSha&&
    e.ownerEpoch===cp.identity.ownerEpoch&&
    e.signedGrantSha256===cp.identity.grant.signedGrantSha256&&
    natural(e.tokensUsed)&&e.tokensUsed<=1000000;
}
/** Replaying an OBSERVE checkpoint yields AWAIT_OBSERVATION, not a second
 * TOOL_INTENT. Caller must persist before any separate trusted read-only tool
 * bridge can consume a new intent. This module provides no such bridge. */
export function advanceTaskLoop(saved:LoopCheckpoint,ctx:LoopRuntimeContext):LoopTransition{
  validated(saved);
  const cp=structuredClone(saved);
  if(!ctx||!natural(ctx.nowMs)||!validIdentity(ctx.identity)||
    !scoped(cp.identity,ctx.identity))
    return stopped(cp,'BLOCKED','SCOPE_MISMATCH');
  if(cp.status!=='ACTIVE')
    return {checkpoint:cp,action:{kind:'STOP',
      reason:cp.reason??'SCOPE_MISMATCH',canExecuteMutation:false}};
  if(ctx.grantRevoked)return stopped(cp,'BLOCKED','GRANT_REVOKED');
  if(ctx.nowMs>=cp.identity.grant.expiresAtMs)
    return stopped(cp,'BLOCKED','GRANT_EXPIRED');
  if(ctx.externalMutationState==='unknown'||ctx.externalMutationState==='in_progress')
    return stopped(cp,'RECONCILE_REQUIRED','MUTATION_STATE_UNKNOWN');
  if(ctx.cancelled)return stopped(cp,
    cp.pending?'RECONCILE_REQUIRED':'STOPPED','CANCELLED');
  if(ctx.nowMs>=cp.deadlineMs)return stopped(cp,
    cp.pending?'RECONCILE_REQUIRED':'STOPPED','BUDGET_EXHAUSTED');
  const step=cp.steps[cp.stepIndex]!;
  if(ctx.evidence&&(
    (cp.phase==='OBSERVE'&&ctx.evidence.kind!=='observation')||
    (cp.phase==='TEST'&&ctx.evidence.kind!=='test')||
    (cp.phase!=='OBSERVE'&&cp.phase!=='TEST')))
    throw new TaskLoopError('EVIDENCE_MISMATCH','Unexpected or duplicate evidence.');
  if(cp.phase==='PLAN'){
    cp.phase='TOOL';
    return {checkpoint:cp,action:{kind:'PLAN_REVIEW',
      stepId:step.id,canExecuteMutation:false}};
  }
  if(cp.phase==='TOOL'){
    // Metadata cannot attest a physically independent off-host CAS;
    // mutation always requires reconciliation, never emits TOOL_INTENT.
    if(step.mode==='mutation')
      return stopped(cp,'RECONCILE_REQUIRED','EXTERNAL_CAS_REQUIRED');
    const t=ctx.tenantCapacity;
    if(t){
      if(![t.activeGlobal,t.activeTenant,t.maxGlobal,t.maxPerTenant].every(natural)||
        t.maxGlobal<1||t.maxPerTenant<1)
        return stopped(cp,'BLOCKED','SCOPE_MISMATCH');
      if(t.activeGlobal>=t.maxGlobal||t.activeTenant>=t.maxPerTenant)
        return {checkpoint:cp,action:{kind:'WAIT_TENANT_CAPACITY',
          canExecuteMutation:false}};
    }
    if(cp.usedActions>=cp.limits.maxActions||
      cp.usedTokens+step.reservedTokens>cp.limits.maxTokens)
      return stopped(cp,'STOPPED','BUDGET_EXHAUSTED');
    const attempt=cp.attempt+1;
    const intent:LoopPending={
      intentId:sha(JSON.stringify([cp.immutableSha256,step.id,cp.stepIndex,attempt])),
      stepId:step.id,attempt,mode:step.mode
    };
    cp.phase='OBSERVE';cp.pending=intent;cp.attempt=attempt;
    cp.usedActions++;cp.usedTokens+=step.reservedTokens;
    return {checkpoint:cp,action:{kind:'TOOL_INTENT',
      intent,capability:step.capability,canExecuteMutation:false}};
  }
  if(cp.phase==='OBSERVE'){
    const intent=cp.pending!;
    if(!ctx.evidence)return {checkpoint:cp,
      action:{kind:'AWAIT_OBSERVATION',intentId:intent.intentId,
        canExecuteMutation:false}};
    const e=ctx.evidence;
    if(e.kind!=='observation'||!evidenceValid(cp,e,intent.intentId))
      throw new TaskLoopError('EVIDENCE_MISMATCH',
        'Observation does not match pinned logical intent.');
    if(e.result==='unknown'||e.errorCode==='MUTATION_STATE_UNKNOWN')
      return stopped(cp,'RECONCILE_REQUIRED','MUTATION_STATE_UNKNOWN');
    cp.usedTokens+=e.tokensUsed;
    if(cp.usedTokens>cp.limits.maxTokens){
      cp.usedTokens=cp.limits.maxTokens;
      return stopped(cp,'STOPPED','BUDGET_EXHAUSTED');
    }
    cp.pending=undefined;cp.testForIntentId=intent.intentId;
    cp.phase=e.result==='ok'?'TEST':'FIX';
    if(cp.phase==='TEST')return {checkpoint:cp,
      action:{kind:'TEST_REQUEST',intentId:intent.intentId,canExecuteMutation:false}};
    cp.testForIntentId=undefined;
    return {checkpoint:cp,action:{kind:'FIX_REVIEW',
      stepId:step.id,canExecuteMutation:false}};
  }
  if(cp.phase==='TEST'){
    const id=cp.testForIntentId!;
    if(!ctx.evidence)return {checkpoint:cp,
      action:{kind:'TEST_REQUEST',intentId:id,canExecuteMutation:false}};
    const e=ctx.evidence;
    if(e.kind!=='test'||!evidenceValid(cp,e,id))
      throw new TaskLoopError('EVIDENCE_MISMATCH',
        'Test evidence does not match pinned logical intent.');
    if(e.errorCode==='MUTATION_STATE_UNKNOWN')
      return stopped(cp,'RECONCILE_REQUIRED','MUTATION_STATE_UNKNOWN');
    cp.usedTokens+=e.tokensUsed;
    if(cp.usedTokens>cp.limits.maxTokens){
      cp.usedTokens=cp.limits.maxTokens;
      return stopped(cp,'STOPPED','BUDGET_EXHAUSTED');
    }
    cp.testForIntentId=undefined;
    if(!e.passed){
      cp.phase='FIX';
      return {checkpoint:cp,action:{kind:'FIX_REVIEW',
        stepId:step.id,canExecuteMutation:false}};
    }
    if(cp.stepIndex===cp.steps.length-1)
      return stopped(cp,'STOPPED','COMPLETED');
    cp.stepIndex++;cp.attempt=0;cp.phase='PLAN';
    return {checkpoint:cp,action:{kind:'PLAN_REVIEW',
      stepId:cp.steps[cp.stepIndex]!.id,canExecuteMutation:false}};
  }
  // FIX only schedules a new bounded intent; never executes a command.
  if(cp.usedFixes>=cp.limits.maxFixes)
    return stopped(cp,'STOPPED','TEST_FAILED');
  cp.usedFixes++;cp.phase='TOOL';
  return {checkpoint:cp,action:{kind:'FIX_REVIEW',
    stepId:step.id,canExecuteMutation:false}};
}
