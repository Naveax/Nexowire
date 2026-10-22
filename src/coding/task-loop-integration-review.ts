/**
 * #33 NEXT2: pure cross-owner coding-loop admission NEGATIVE.
 *
 * #42 worker reconnect, #34 sealed task checkpoint and #14 artifact quota
 * are on independent DRAFT branches and cannot provide a native dispatch
 * permit. This reader accepts only their *structural projections* so #33
 * never imports unmerged owner files or pretends a local receipt is trusted.
 *
 * NO callbacks, stores, re-dispatch, process launch, CAS adapter or effects.
 */
import type {LoopCheckpoint} from './task-loop-engine.js';

/** Subset of #42 WorkerLeaseCheckpoint. Not an authenticated service readback. */
export interface WorkerLeaseProjection {
  identity: {
    ownerAccountId:string; deviceId:string; taskId:string; worktreeId:string;
    sourceSha:string; stepId:string; logicalMutationId:string;
    originalRequestId:string; ownerEpoch:number;
  };
  mutationState:'not_sent'|'dispatch_pending'|'ack_lost'|'journal_unknown';
}
/** Subset of #34 SecureTaskCheckpoint. AES-GCM != rollback-external CAS. */
export interface SealedCheckpointProjection {
  scope: {
    ownerId:string; deviceId:string; taskId:string; worktreeId:string;
    sourceSha:string; ownerEpoch:number; grantGeneration:number;
    signedGrantScopeDigest:string;
  };
  mutation: {
    logicalMutationId:string; requestId:string;
    state:'PLANNED'|'RESERVED'|'DISPATCH_MAY_HAVE_OCCURRED'|
      'RECONCILE_REQUIRED'|'LOCAL_TERMINAL_NEEDS_PROOF';
    pendingUnknown:boolean;
  };
  cancelled:boolean;
}
/**
 * Subset of #718 #14 STAGING artifact logical admission, NOT coding quota.
 * logicalMutationSha256 is a semantic effect digest: it is NOT a substitute
 * for logicalMutationId or sourceSha (a Git commit SHA).
 */
export interface ArtifactQuotaProjection {
  binding: {
    ownerId:string; deviceId:string; logicalOperationId:string;
    logicalMutationSha256:string; ownerEpoch:number; grantGeneration:number;
  };
  state:'NEVER_DISPATCHED'|'MUTATION_UNKNOWN'|'DISPATCHED';
}
export interface CodingLoopControllerInput {
  loop:LoopCheckpoint;
  worker?:WorkerLeaseProjection;
  checkpoint?:SealedCheckpointProjection;
  quota?:ArtifactQuotaProjection;
  /** From a separate read-only workspace inventory; NOT an OS sandbox. */
  worktree?: {
    taskId:string;worktreeId:string;sourceSha:string;worktreeSha:string;
    ownerEpoch:number;ownerGeneration:number;
  };
}
export type CodingLoopControllerReason =
  |'CROSS_OWNER_PROJECTION_MISSING'
  |'CROSS_OWNER_SCOPE_MISMATCH'
  |'MUTATION_STATE_UNKNOWN'
  |'REVOKED_OR_CANCELLED'
  |'WORKTREE_OWNER_GENERATION_NOT_ATOMICALLY_BOUND'
  |'OFFHOST_CAS_NOT_PROVEN';
export interface CodingLoopControllerDecision {
  readonly state:'BLOCKED'|'RECONCILE_REQUIRED';
  readonly reason:CodingLoopControllerReason;
  readonly mayDispatch:false;
  readonly mayReplayMutation:false;
  readonly mayResumeTool:false;
  readonly mayClaimCompletedVerified:false;
  readonly originalRequestId:string|null;
  readonly logicalMutationId:string|null;
}
const sha=(value:unknown,len:number):boolean=>
  typeof value==='string'&&new RegExp('^[0-9a-f]{'+len+'}$').test(value);
const id=(value:unknown):value is string=>
  typeof value==='string'&&value.length>0&&value.length<=256;
const epoch=(value:unknown):value is number=>
  Number.isSafeInteger(value)&&(value as number)>=0;
const asObject=(v:unknown):v is Record<string,unknown>=>
  Boolean(v&&typeof v==='object'&&!Array.isArray(v));
function decide(
  loop:LoopCheckpoint|undefined,
  reason:CodingLoopControllerReason,
  state:'BLOCKED'|'RECONCILE_REQUIRED'='BLOCKED',
):CodingLoopControllerDecision {
  return Object.freeze({
    state,reason,mayDispatch:false,mayReplayMutation:false,
    mayResumeTool:false,mayClaimCompletedVerified:false,
    originalRequestId:id(loop?.identity?.originalRequestId)
      ?loop.identity.originalRequestId:null,
    logicalMutationId:id(loop?.identity?.logicalMutationId)
      ?loop.identity.logicalMutationId:null,
  });
}
/**
 * Every outcome is DENY. No consumer may interpret all matching local
 * projections or a "NEVER_DISPATCHED" staging quota claim as a new permit.
 * #587 requires independently authoritative atomic commit-vs-revoke, plus
 * protected native effect readback, before ANY mutating controller exists.
 */
export function reviewCodingLoopCrossOwner(
  input:CodingLoopControllerInput,
):CodingLoopControllerDecision {
  const l=input?.loop, i=l?.identity;
  const w=input?.worker, c=input?.checkpoint, q=input?.quota, t=input?.worktree;
  if(!asObject(i)||!asObject(i.grant)||
     !asObject(w)||!asObject(w.identity)||
     !asObject(c)||!asObject(c.scope)||!asObject(c.mutation)||
     !asObject(q)||!asObject(q.binding)||
     !asObject(t))
    return decide(l,'CROSS_OWNER_PROJECTION_MISSING');
  const wi=w.identity, cs=c.scope, m=c.mutation, qb=q.binding;
  // The projections are client/local state, never a verified signer/owner.
  // Guard all commonly named fields before any outcome classification.
  if(![
    i.tenantId,i.taskId,i.worktreeId,i.originalRequestId,
    i.logicalMutationId,wi.ownerAccountId,wi.deviceId,cs.ownerId,cs.deviceId
  ].every(id)||
     ![i.ownerEpoch,wi.ownerEpoch,cs.ownerEpoch,cs.grantGeneration,
       qb.ownerEpoch,qb.grantGeneration,t.ownerEpoch,t.ownerGeneration].every(epoch)||
     !sha(i.sourceSha,40)&&!sha(i.sourceSha,64)||
     !sha(i.worktreeSha,40)&&!sha(i.worktreeSha,64)||
     !sha(qb.logicalMutationSha256,64)||
     !sha(cs.signedGrantScopeDigest,64)||
     wi.ownerAccountId!==cs.ownerId||wi.deviceId!==cs.deviceId||
     qb.ownerId!==cs.ownerId||qb.deviceId!==cs.deviceId||
     wi.taskId!==i.taskId||cs.taskId!==i.taskId||t.taskId!==i.taskId||
     wi.worktreeId!==i.worktreeId||cs.worktreeId!==i.worktreeId||
     t.worktreeId!==i.worktreeId||
     wi.sourceSha!==i.sourceSha||cs.sourceSha!==i.sourceSha||
     t.sourceSha!==i.sourceSha||t.worktreeSha!==i.worktreeSha||
     wi.stepId!==l?.steps?.[l.stepIndex]?.id||
     wi.logicalMutationId!==i.logicalMutationId||
     m.logicalMutationId!==i.logicalMutationId||
     // #718 logicalOperationId must be mapped by an external owner adapter;
     // simply changing originRunbookId may NOT mint a new logical effect.
     qb.logicalOperationId!==i.logicalMutationId||
     wi.originalRequestId!==i.originalRequestId||
     m.requestId!==i.originalRequestId||
     wi.ownerEpoch!==i.ownerEpoch||cs.ownerEpoch!==i.ownerEpoch||
     qb.ownerEpoch!==i.ownerEpoch||t.ownerEpoch!==i.ownerEpoch||
     cs.grantGeneration!==i.grant.generation||
     qb.grantGeneration!==i.grant.generation)
    return decide(l,'CROSS_OWNER_SCOPE_MISMATCH');
  // UNKNOWN is sticky even with a healthy new WSS lease or quota readback.
  if(l.status==='RECONCILE_REQUIRED'||
     l.reason==='MUTATION_STATE_UNKNOWN'||
     w.mutationState!=='not_sent'||
     m.pendingUnknown||
     m.state==='DISPATCH_MAY_HAVE_OCCURRED'||
     m.state==='RECONCILE_REQUIRED'||
     q.state!=='NEVER_DISPATCHED')
    return decide(l,'MUTATION_STATE_UNKNOWN','RECONCILE_REQUIRED');
  if(c.cancelled||l.status==='STOPPED'&&l.reason==='CANCELLED')
    return decide(l,'REVOKED_OR_CANCELLED');
  // No immutable owner-generation binding currently exists on LoopIdentity
  // or on #34/#42, and #718 is artifact-specific STAGING admission only.
  // An untrusted ownerGeneration or locally sealed checkpoint proves nothing.
  if(!epoch(t.ownerGeneration)||t.ownerGeneration===0)
    return decide(l,'WORKTREE_OWNER_GENERATION_NOT_ATOMICALLY_BOUND');
  return decide(l,'OFFHOST_CAS_NOT_PROVEN');
}
