import * as z from 'zod';
import {
  AdminBridgeModeIntentSchema,
  AdminBridgeModeReceiptSchema,
  validateAdminBridgeModeIntent,
  verifyAdminBridgeModeReceipt,
  type AdminBridgeModeIntent,
  type AdminBridgeModeReceipt,
} from '../protocol/admin-bridge-intent.js';

const task = z.strictObject({
  installed: z.literal(true),
  taskName: z.literal('Nexowire Privileged Broker'),
  state: z.enum(['Running','Ready','Disabled','Unknown']),
  /** Independently reverified trusted task owner and exact single action. */
  identityVerified: z.literal(true),
});
const health = z.strictObject({
  expectedVersion:z.string().min(1).max(80),
  version:z.string().nullable(),
  reachable:z.boolean(),
  elevated:z.boolean(),
  ready:z.boolean(),
  status:z.enum([
    'READY','SECRET_UNAVAILABLE','HEALTH_UNAVAILABLE',
    'NOT_ELEVATED','VERSION_MISMATCH',
  ]),
});
const processAudit = z.strictObject({
  /** The protected local Windows observer queried ALL relevant processes. */
  complete:z.boolean(),
  trustedCollector:z.boolean(),
  brokerProcessCount:z.number().int().min(0).max(1000),
  brokerListenerCount:z.number().int().min(0).max(1000),
  listenerPort:z.literal(43112),
  /** Exact signed Broker executable/owner provenance when it is running. */
  brokerProcessImageAndOwnerVerified:z.boolean(),
  /** Independently inspected recovery trigger state, not remote self-report. */
  recoveryTriggerVerified:z.boolean(),
  /** Actual observed recovery trigger enablement, separately from audit success. */
  recoveryTriggerEnabled:z.boolean(),
});
export type LocalBridgeTaskEvidence=z.infer<typeof task>;
export type LocalBridgeHealthEvidence=z.infer<typeof health>;
export type LocalBridgeProcessEvidence=z.infer<typeof processAudit>;

export interface LocalBridgePostconditionCollectors {
  /**
   * These MUST execute within the protected elevated Guardian, not accept
   * JSON from the remote Hub or Agent. They must be independent read-only
   * Windows task, authenticated health and local process/port collectors.
   */
  readonly readTask:()=>Promise<unknown>;
  readonly readHealth:()=>Promise<unknown>;
  readonly readProcessAndPort:()=>Promise<unknown>;
  readonly now:()=>Date;
}

export interface LocalBridgePostconditionResult {
  readonly receipt:AdminBridgeModeReceipt;
  /** Untrusted local self-report until signed by an enrolled protected Guardian. */
  readonly locallyMeasured:boolean;
}

function unsuccessful(
  intent:AdminBridgeModeIntent,
  observedAt:string,
  reason:'TASK_AUDIT_UNAVAILABLE'|'BROKER_HEALTH_UNVERIFIED'|
    'BROKER_PROCESS_AUDIT_UNVERIFIED'|'BROKER_MODE_NOT_APPLIED',
  state:AdminBridgeModeReceipt['taskState'],
):LocalBridgePostconditionResult {
  const receipt=AdminBridgeModeReceiptSchema.parse({
    type:'admin-bridge.mode-receipt',version:1,
    requestId:intent.requestId,deviceId:intent.deviceId,
    credentialBinding:intent.credentialBinding,
    desiredMode:intent.desiredMode,observedAt,
    result:'failed',taskState:state,taskVerified:false,
    brokerHealth:'unverified',failureCode:reason,
  });
  verifyAdminBridgeModeReceipt(receipt,intent);
  return Object.freeze({receipt,locallyMeasured:false});
}

/**
 * Post-transition, strictly read-only outcome measurement. Does NOT run a
 * Scheduled Task, elevate or grant permission. It must be invoked only from a
 * separately authenticated, protected Guardian after a reserved signed command.
 */
export async function measureGuardianBrokerPostcondition(
  rawIntent:unknown,
  collectors:LocalBridgePostconditionCollectors,
):Promise<LocalBridgePostconditionResult> {
  const intent=AdminBridgeModeIntentSchema.parse(rawIntent);
  const sampledAt=collectors.now();
  const when=sampledAt instanceof Date?sampledAt.getTime():Number.NaN;
  if (!Number.isFinite(when) ||
      when < Date.parse(intent.issuedAt) ||
      when >= Date.parse(intent.expiresAt)) {
    throw new Error('GUARDIAN_POSTCONDITION_EXPIRED_OR_INVALID');
  }
  // Validate the entire bounded intent window BEFORE any potentially slow
  // protected OS collector. The matching fields here are from the intent
  // itself: this is temporal/schema hygiene, NOT local owner authorization.
  validateAdminBridgeModeIntent(intent,{
    deviceId:intent.deviceId,ownerAccountId:intent.ownerAccountId,
    credentialBinding:intent.credentialBinding,
    now:new Date(when),hasConsumedRequestId:()=>false,
  });
  // A failing collector can take longer than the approved intent window.
  // Never backdate failure evidence to the clock sampled before the reads.
  // Failure receipts have only the protocol's five-second reporting grace.
  const failed=(
    reason:Parameters<typeof unsuccessful>[2],
    state:Parameters<typeof unsuccessful>[3],
  ):LocalBridgePostconditionResult=>{
    const current=collectors.now();
    const time=current instanceof Date?current.getTime():Number.NaN;
    if(!Number.isFinite(time)||time<when||
        time>Date.parse(intent.expiresAt)+5_000){
      throw new Error('GUARDIAN_POSTCONDITION_FAILURE_CLOCK_UNTRUSTED');
    }
    return unsuccessful(intent,new Date(time).toISOString(),reason,state);
  };
  let taskData:LocalBridgeTaskEvidence;
  try {
    taskData=task.parse(await collectors.readTask());
  } catch {
    return failed('TASK_AUDIT_UNAVAILABLE','Unknown');
  }
  const state=taskData.state;
  let processData:LocalBridgeProcessEvidence;
  try {
    processData=processAudit.parse(await collectors.readProcessAndPort());
  } catch {
    return failed(
      'BROKER_PROCESS_AUDIT_UNVERIFIED',state);
  }
  if (!processData.complete || !processData.trustedCollector) {
    return failed(
      'BROKER_PROCESS_AUDIT_UNVERIFIED',state);
  }

  let observedHealth:LocalBridgeHealthEvidence|undefined;
  if (intent.desiredMode === 'off') {
    // An unauthenticated health timeout is NOT proof that Broker stopped.
    const allGone=state==='Disabled' &&
      processData.brokerProcessCount===0 &&
      processData.brokerListenerCount===0 &&
      processData.recoveryTriggerVerified &&
      !processData.recoveryTriggerEnabled;
    if (!allGone) {
      return failed('BROKER_MODE_NOT_APPLIED',state);
    }
  } else {
    if(state!=='Running' ||
        processData.brokerProcessCount!==1 ||
        processData.brokerListenerCount!==1 ||
        !processData.brokerProcessImageAndOwnerVerified ||
        (intent.desiredMode==='auto' &&
          (!processData.recoveryTriggerVerified ||
           !processData.recoveryTriggerEnabled))) {
      return failed('BROKER_MODE_NOT_APPLIED',state);
    }
    try {
      observedHealth=health.parse(await collectors.readHealth());
    } catch {
      return failed(
        'BROKER_HEALTH_UNVERIFIED',state);
    }
    if (!observedHealth.ready ||
        observedHealth.status!=='READY' ||
        !observedHealth.reachable ||
        !observedHealth.elevated ||
        !observedHealth.version ||
        observedHealth.version!==observedHealth.expectedVersion) {
      return failed(
        'BROKER_HEALTH_UNVERIFIED',state);
    }
  }
  // Read the independent task and port inventory AGAIN immediately before
  // any applied receipt. A task can change while the first process/health
  // probe is running; one early snapshot must never certify a later state.
  let finalTask:LocalBridgeTaskEvidence;
  try {
    finalTask=task.parse(await collectors.readTask());
  } catch {
    return failed('TASK_AUDIT_UNAVAILABLE','Unknown');
  }
  let finalProcess:LocalBridgeProcessEvidence;
  try {
    finalProcess=processAudit.parse(await collectors.readProcessAndPort());
  } catch {
    return failed(
      'BROKER_PROCESS_AUDIT_UNVERIFIED',finalTask.state);
  }
  if (!finalProcess.complete || !finalProcess.trustedCollector) {
    return failed(
      'BROKER_PROCESS_AUDIT_UNVERIFIED',finalTask.state);
  }
  if (JSON.stringify(taskData)!==JSON.stringify(finalTask) ||
      JSON.stringify(processData)!==JSON.stringify(finalProcess)) {
    return failed(
      'BROKER_MODE_NOT_APPLIED',finalTask.state);
  }

  // A previously healthy broker can fail after the first authenticated
  // probe while task/process inventories still look unchanged. ON/AUTO must
  // not stamp "authenticated-ready" using that stale first health sample.
  // OFF still proves absence from independent process/port inventory only.
  if (intent.desiredMode!=='off') {
    let finalHealth:LocalBridgeHealthEvidence;
    try {
      finalHealth=health.parse(await collectors.readHealth());
    } catch {
      return failed(
        'BROKER_HEALTH_UNVERIFIED',finalTask.state);
    }
    if (!observedHealth ||
        JSON.stringify(observedHealth)!==JSON.stringify(finalHealth)) {
      return failed(
        'BROKER_HEALTH_UNVERIFIED',finalTask.state);
    }
  }

  // Long-running collectors can outlive the signed owner-approved window.
  // Do not stamp success with the earlier clock sample.
  const completedAt=collectors.now();
  const completedTime=completedAt.getTime();
  if (!Number.isFinite(completedTime) ||
      completedTime<when ||
      completedTime<Date.parse(intent.issuedAt) ||
      completedTime>=Date.parse(intent.expiresAt)) {
    throw new Error('GUARDIAN_POSTCONDITION_EXPIRED_OR_INVALID');
  }
  const receipt=AdminBridgeModeReceiptSchema.parse({
    type:'admin-bridge.mode-receipt',version:1,
    requestId:intent.requestId,deviceId:intent.deviceId,
    credentialBinding:intent.credentialBinding,
    desiredMode:intent.desiredMode,observedAt:completedAt.toISOString(),
    result:'applied',taskState:finalTask.state,taskVerified:true,
    brokerHealth:intent.desiredMode==='off'?'absent':'authenticated-ready',
    failureCode:null,
  });
  verifyAdminBridgeModeReceipt(receipt,intent);
  return Object.freeze({receipt,locallyMeasured:true});
}
