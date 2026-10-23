import * as z from 'zod';
import {
  BrowserMicroScenarioPlanV1Schema,
  reviewBrowserMicroScenarioPlan,
} from './browser-micro-scenario-contract.js';

/**
 * #08 / #402 / #780: inert post-navigation observation contract.
 * No external authority is conveyed by caller-supplied CDP/stop metadata.
 * No BrowserManager method, native GUI input, or retry is performed here.
 */
const uuid=z.string().uuid();
export const BrowserMicroNavigationObservationV1Schema=z.strictObject({
  version:z.literal(1),
  requestId:uuid,logicalMutationId:uuid,
  browserSessionId:uuid,targetId:z.string().min(1).max(256),
  navigationStepId:z.string().min(1).max(64),
  /** Lost response after Page.navigate is a possible mutation, not failure proof. */
  ackState:z.enum([
    'NOT_DISPATCHED_VERIFIED','ACK_VERIFIED',
    'ACK_LOST_OR_UNKNOWN','DISPATCH_MAY_HAVE_OCCURRED',
  ]),
  /** Source observation only; must not be confused with an authenticated receipt. */
  finalUrl:z.string().min(1).max(2048).optional(),
  /** UNKNOWN blocks new steps just as a known stop request does. */
  emergencyStop:z.enum(['CLEAR_SOURCE_ONLY','REQUESTED','UNKNOWN']),
});
export type BrowserMicroNavigationObservationV1=
  Readonly<z.infer<typeof BrowserMicroNavigationObservationV1Schema>>;

export type BrowserMicroNavigationBoundaryDecision=Readonly<{
  status:'STOP'|'RECONCILE_REQUIRED'|'SOURCE_OBSERVATION_MATCHED_NO_AUTHORITY';
  reason:'EMERGENCY_STOP_OR_UNKNOWN'|'NAVIGATION_ACK_UNKNOWN'|
    'JOURNAL_UNKNOWN'|'TARGET_OR_REQUEST_CHANGED'|'NOT_A_NAVIGATION_STEP'|
    'NAVIGATION_NOT_DISPATCHED'|'FINAL_ORIGIN_MISMATCH'|
    'NO_AUTHENTICATED_EFFECT_RECEIPT';
  requestId:string;logicalMutationId:string;navigationStepId:string;
  canDispatch:false;canAdvance:false;canReplay:false;
  evidenceVerified:false;physicalStopVerified:false;
}>;

/**
 * A completed Page.navigate can redirect outside the statically allowed URL.
 * Its final URL must be checked from a separately authenticated future CDP
 * readback before ANY wait/assert/snapshot, never from an RPC boolean.
 * The actual current owner lease, target PID+creation FILETIME, native stop
 * and effect receipt are provider responsibilities. Even matching readbacks
 * cannot grant authority or make a lost-ACK navigation replayable.
 */
export function reviewBrowserMicroNavigationBoundary(
  planInput:unknown,observationInput:unknown,
):BrowserMicroNavigationBoundaryDecision{
  const plan=BrowserMicroScenarioPlanV1Schema.parse(planInput);
  const observed=BrowserMicroNavigationObservationV1Schema.parse(observationInput);
  const result=(
    status:BrowserMicroNavigationBoundaryDecision['status'],
    reason:BrowserMicroNavigationBoundaryDecision['reason'],
  ):BrowserMicroNavigationBoundaryDecision=>Object.freeze({
    status,reason,requestId:plan.requestId,
    logicalMutationId:plan.logicalMutationId,
    navigationStepId:observed.navigationStepId,
    canDispatch:false,canAdvance:false,canReplay:false,
    evidenceVerified:false,physicalStopVerified:false,
  });
  // Stop first, including when a later status/readback claims success.
  if(observed.emergencyStop!=='CLEAR_SOURCE_ONLY')
    return result('STOP','EMERGENCY_STOP_OR_UNKNOWN');
  const planReview=reviewBrowserMicroScenarioPlan(planInput);
  if(planReview.status==='RECONCILE_REQUIRED')
    return result('RECONCILE_REQUIRED','JOURNAL_UNKNOWN');
  if(observed.ackState==='ACK_LOST_OR_UNKNOWN'||
      observed.ackState==='DISPATCH_MAY_HAVE_OCCURRED')
    return result('RECONCILE_REQUIRED','NAVIGATION_ACK_UNKNOWN');
  if(observed.requestId!==plan.requestId||
      observed.logicalMutationId!==plan.logicalMutationId||
      observed.browserSessionId!==plan.browserSessionId||
      observed.targetId!==plan.targetId)
    return result('STOP','TARGET_OR_REQUEST_CHANGED');
  if(!plan.steps.some(step=>step.id===observed.navigationStepId&&step.op==='navigate'))
    return result('STOP','NOT_A_NAVIGATION_STEP');
  if(observed.ackState==='NOT_DISPATCHED_VERIFIED')
    return result('STOP','NAVIGATION_NOT_DISPATCHED');
  // ACK is not a completed-navigation or final-origin attestation.
  const final=observed.finalUrl;
  let allowed=false;
  if(final){
    try{
      const url=new URL(final);
      const origin=new URL(plan.allowedOrigin);
      allowed=url.origin===origin.origin&&
        !url.username&&!url.password&&
        (url.protocol==='https:'||
         url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));
    }catch{/* malformed post-navigation readback remains denied */}
  }
  if(!allowed)return result('STOP','FINAL_ORIGIN_MISMATCH');
  return result('SOURCE_OBSERVATION_MATCHED_NO_AUTHORITY',
    'NO_AUTHENTICATED_EFFECT_RECEIPT');
}
