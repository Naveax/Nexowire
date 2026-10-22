import * as z from 'zod';

/**
 * #09 / #780 metadata-only plan. This is NOT a CDP executor, browser
 * authorization, current task sandbox, external Journal, or Access grant.
 * A valid shape must never be converted into a launch or elevated token.
 */
const uuid=z.string().uuid();
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const gitSha=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const stepId=z.string().min(1).max(64);
const navigate=z.strictObject({
  op:z.literal('navigate'),id:stepId,url:z.string().min(1).max(2048),
  timeoutMs:z.number().int().min(1_000).max(15_000),
});
const wait=z.strictObject({
  op:z.literal('wait'),id:stepId,readyState:z.enum(['interactive','complete']),
  timeoutMs:z.number().int().min(100).max(10_000),
});
const assertText=z.strictObject({
  op:z.literal('assert'),id:stepId,selector:z.string().min(1).max(512),
  expectedText:z.string().min(1).max(1_024),
  textMode:z.enum(['exact','contains']),
});
const screenshot=z.strictObject({
  op:z.literal('screenshot'),id:stepId,
  maxBytes:z.number().int().min(65_536).max(2_097_152),
});
export const BrowserMicroScenarioPlanV1Schema=z.strictObject({
  version:z.literal(1),
  taskId:z.string().min(1).max(128),
  logicalMutationId:uuid,requestId:uuid,
  ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  /** Identifiers for protected owner sources, NOT proof of those sources. */
  taskGrantId:uuid,worktreeGrantId:uuid,sandboxId:uuid,
  worktreeBaseSha:gitSha,worktreeDiffSha:sha,
  /** Align with #795 canonical semantic/worktree/preimage grant binding. */
  semanticEffectSha256:sha,worktreeIdentitySha256:sha,
  preimageSha256:sha,baseSha256:sha,
  browserSessionId:uuid,targetId:z.string().min(1).max(256),
  allowedOrigin:z.string().min(1).max(512),
  maxDurationMs:z.number().int().min(1_000).max(60_000),
  maxEvidenceBytes:z.number().int().min(65_536).max(4_194_304),
  /** No raw script, click, setValue, UAC, CORE or free-form CDP method. */
  steps:z.array(z.discriminatedUnion('op',[
    navigate,wait,assertText,screenshot,
  ])).min(1).max(8),
  journalState:z.enum(['PLANNED','RECONCILE_REQUIRED','MUTATION_STATE_UNKNOWN']),
  originalErrorCode:z.string().min(1).max(128).optional(),
});
export type BrowserMicroScenarioPlanV1=
  Readonly<z.infer<typeof BrowserMicroScenarioPlanV1Schema>>;
export interface BrowserMicroScenarioSourceReview {
  readonly status:'SOURCE_PLAN_ONLY'|'RECONCILE_REQUIRED';
  readonly logicalMutationId:string;
  readonly requestId:string;
  readonly stepCount:number;
  readonly originalErrorCode?:string;
  readonly safeNextAction:
    'VERIFY_CURRENT_OWNER_WORKTREE_SANDBOX_GRANT'|'READ_ONLY_RECONCILIATION';
  readonly canDispatch:false;
  readonly canReplay:false;
  readonly canElevate:false;
  readonly evidenceVerified:false;
  readonly physicalStopVerified:false;
}

function validUrl(url:string):URL {
  const u=new URL(url);
  if(u.username||u.password||u.protocol!=='https:'&&u.protocol!=='http:'||
      (u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))){
    throw new Error('BROWSER_MICRO_SCENARIO_ORIGIN_DENIED');
  }
  return u;
}
/** Static bounded review ONLY: even a positive result lacks OS authorization. */
export function reviewBrowserMicroScenarioPlan(input:unknown):
    BrowserMicroScenarioSourceReview {
  const plan=BrowserMicroScenarioPlanV1Schema.parse(input);
  const base=validUrl(plan.allowedOrigin);
  if(base.href!==base.origin+'/'||plan.steps.length>8)
    throw new Error('BROWSER_MICRO_SCENARIO_ORIGIN_DENIED');
  let navigating=false;
  let timeBudget=0;
  let screenshotBudget=0;
  const ids=new Set<string>();
  for(const step of plan.steps){
    if(ids.has(step.id))throw new Error('BROWSER_MICRO_SCENARIO_DUPLICATE_STEP');
    ids.add(step.id);
    if(step.op==='navigate'){
      const u=validUrl(step.url);
      if(u.origin!==base.origin)throw new Error('BROWSER_MICRO_SCENARIO_ORIGIN_DENIED');
      navigating=true;
      timeBudget+=step.timeoutMs;
    }else if(step.op==='wait'){
      if(!navigating)throw new Error('BROWSER_MICRO_SCENARIO_WAIT_WITHOUT_NAVIGATION');
      timeBudget+=step.timeoutMs;
    }else if(step.op==='assert'){
      if(!navigating)throw new Error('BROWSER_MICRO_SCENARIO_ASSERT_WITHOUT_NAVIGATION');
      timeBudget+=2_000;
    }else if(step.op==='screenshot'){
      if(!navigating)throw new Error('BROWSER_MICRO_SCENARIO_CAPTURE_WITHOUT_NAVIGATION');
      screenshotBudget+=step.maxBytes;
      timeBudget+=5_000;
    }
  }
  if(timeBudget>plan.maxDurationMs||
      screenshotBudget>plan.maxEvidenceBytes){
    throw new Error('BROWSER_MICRO_SCENARIO_BUDGET_EXCEEDED');
  }
  const unknown=plan.journalState!=='PLANNED'||
    plan.originalErrorCode==='MUTATION_STATE_UNKNOWN';
  return Object.freeze({
    status:unknown?'RECONCILE_REQUIRED' as const:'SOURCE_PLAN_ONLY' as const,
    logicalMutationId:plan.logicalMutationId,requestId:plan.requestId,
    stepCount:plan.steps.length,
    ...(plan.originalErrorCode?{originalErrorCode:plan.originalErrorCode}:{}),
    safeNextAction:unknown?'READ_ONLY_RECONCILIATION' as const:
      'VERIFY_CURRENT_OWNER_WORKTREE_SANDBOX_GRANT' as const,
    canDispatch:false as const,canReplay:false as const,
    canElevate:false as const,evidenceVerified:false as const,
    physicalStopVerified:false as const,
  });
}

/**
 * A screenshot SHA is only metadata until an independently authenticated
 * capture receipt is bound to the exact CDP target, task and request.
 */
export const BrowserScenarioScreenshotRefSchema=z.strictObject({
  taskId:z.string().min(1).max(128),requestId:uuid,
  browserSessionId:uuid,targetId:z.string().min(1).max(256),
  stepId,sha256:sha,mimeType:z.literal('image/png'),
  bytes:z.number().int().positive().max(4_194_304),
  width:z.number().int().positive().max(16_384),
  height:z.number().int().positive().max(16_384),
});
export function reviewBrowserMicroScenarioScreenshotRef(
  planInput:unknown,referenceInput:unknown,
):Readonly<{status:'SOURCE_METADATA_ONLY';evidenceVerified:false;
  canDispatch:false}>{
  const plan=BrowserMicroScenarioPlanV1Schema.parse(planInput);
  const evidence=BrowserScenarioScreenshotRefSchema.parse(referenceInput);
  if(evidence.taskId!==plan.taskId||
      evidence.requestId!==plan.requestId||
      evidence.browserSessionId!==plan.browserSessionId||
      evidence.targetId!==plan.targetId||
      evidence.bytes>plan.maxEvidenceBytes||
      !plan.steps.some(step=>step.op==='screenshot'&&
        step.id===evidence.stepId&&evidence.bytes<=step.maxBytes)){
    throw new Error('BROWSER_MICRO_SCENARIO_EVIDENCE_SCOPE_MISMATCH');
  }
  return Object.freeze({status:'SOURCE_METADATA_ONLY' as const,
    evidenceVerified:false as const,canDispatch:false as const});
}

/**
 * #09 read-only API compatibility shape for #795's
 * readAuthenticatedTaskBinding and #783's immutable Journal identity.
 * This object is untrusted source data until the independent owners
 * install authenticated providers. It NEVER permits a CDP step.
 */
export const BrowserMicroScenarioStepReadbackV1Schema=z.strictObject({
  taskBinding:z.strictObject({
    taskId:z.string().min(1).max(128),logicalMutationId:uuid,
    ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
    ownerEpoch:z.number().int().positive().safe(),
    grantGeneration:z.number().int().positive().safe(),
    semanticEffectSha256:sha,worktreeIdentitySha256:sha,
    preimageSha256:sha,baseSha256:sha,diffSha256:sha,
    gitRootWithinApprovedScope:z.boolean(),
    gitMetadataWithinApprovedScope:z.boolean(),
    mutationState:z.enum([
      'NOT_DISPATCHED_VERIFIED','MUTATION_STATE_UNKNOWN',
      'COMPLETED_VERIFIED','UNVERIFIED',
    ]),
  }),
  /** Independent owner-epoch/revoke high-water readback, not user approval. */
  ownerFence:z.strictObject({
    ownerEpoch:z.number().int().positive().safe(),
    grantGeneration:z.number().int().positive().safe(),
    revoking:z.boolean(),revoked:z.boolean(),
  }),
  journal:z.strictObject({
    logicalMutationId:uuid,requestId:uuid,
    state:z.enum([
      'PLANNED','RECONCILE_REQUIRED','MUTATION_STATE_UNKNOWN',
      'DISPATCH_MAY_HAVE_OCCURRED',
    ]),
  }),
  browserSessionId:uuid,targetId:z.string().min(1).max(256),
});
export type BrowserMicroScenarioStepReadbackV1=
  Readonly<z.infer<typeof BrowserMicroScenarioStepReadbackV1Schema>>;
export type BrowserMicroScenarioStepBoundaryReview=Readonly<{
  status:'STOP'|'RECONCILE_REQUIRED'|'SOURCE_SCOPE_MATCHED_NO_AUTHORITY';
  reason:'OWNER_REVOKED'|'OWNER_OR_WORKTREE_CHANGED'|
    'EFFECT_UNKNOWN_RECONCILE'|'INVALID_STEP'|'SOURCE_ONLY_NO_CURRENT_GRANT';
  logicalMutationId:string;requestId:string;nextStepId:string;
  canDispatch:false;canReplay:false;canAdvance:false;
  evidenceVerified:false;
}>;

/**
 * Compare the original immutable plan with per-step *source* readbacks.
 * Matching booleans cannot attest an external CAS grant or kernel sandbox;
 * even full equality must NOT call BrowserManager or CDP.
 */
export function reviewBrowserMicroScenarioStepBoundary(
  originalPlan:unknown,nextStepId:string,currentReadback:unknown,
):BrowserMicroScenarioStepBoundaryReview{
  const plan=BrowserMicroScenarioPlanV1Schema.parse(originalPlan);
  const current=BrowserMicroScenarioStepReadbackV1Schema.parse(currentReadback);
  const result=(status:BrowserMicroScenarioStepBoundaryReview['status'],
    reason:BrowserMicroScenarioStepBoundaryReview['reason'])=>
    Object.freeze({
      status,reason,logicalMutationId:plan.logicalMutationId,
      requestId:plan.requestId,nextStepId,
      canDispatch:false as const,canReplay:false as const,
      canAdvance:false as const,evidenceVerified:false as const,
    });
  if(!plan.steps.some(s=>s.id===nextStepId))
    return result('STOP','INVALID_STEP');
  const b=current.taskBinding;
  if(plan.journalState!=='PLANNED'||
      plan.originalErrorCode==='MUTATION_STATE_UNKNOWN'||
      current.journal.state!=='PLANNED'||
      b.mutationState==='MUTATION_STATE_UNKNOWN'||
      b.mutationState==='UNVERIFIED'){
    return result('RECONCILE_REQUIRED','EFFECT_UNKNOWN_RECONCILE');
  }
  if(current.ownerFence.revoking||current.ownerFence.revoked){
    return result('STOP','OWNER_REVOKED');
  }
  if(b.taskId!==plan.taskId||
      b.logicalMutationId!==plan.logicalMutationId||
      b.ownerId!==plan.ownerId||b.deviceId!==plan.deviceId||
      b.deviceEpoch!==plan.deviceEpoch||
      b.sessionEpoch!==plan.sessionEpoch||
      b.ownerEpoch!==plan.ownerEpoch||
      b.grantGeneration!==plan.grantGeneration||
      current.ownerFence.ownerEpoch!==plan.ownerEpoch||
      current.ownerFence.grantGeneration!==plan.grantGeneration||
      b.semanticEffectSha256!==plan.semanticEffectSha256||
      b.worktreeIdentitySha256!==plan.worktreeIdentitySha256||
      b.preimageSha256!==plan.preimageSha256||
      b.baseSha256!==plan.baseSha256||
      b.diffSha256!==plan.worktreeDiffSha||
      !b.gitRootWithinApprovedScope||
      !b.gitMetadataWithinApprovedScope||
      current.browserSessionId!==plan.browserSessionId||
      current.targetId!==plan.targetId||
      current.journal.logicalMutationId!==plan.logicalMutationId||
      current.journal.requestId!==plan.requestId){
    return result('STOP','OWNER_OR_WORKTREE_CHANGED');
  }
  if(b.mutationState!=='NOT_DISPATCHED_VERIFIED')
    return result('STOP','SOURCE_ONLY_NO_CURRENT_GRANT');
  // Equality is only a *shape* match, never current signed CAS or CDP auth.
  return result('SOURCE_SCOPE_MATCHED_NO_AUTHORITY',
    'SOURCE_ONLY_NO_CURRENT_GRANT');
}
