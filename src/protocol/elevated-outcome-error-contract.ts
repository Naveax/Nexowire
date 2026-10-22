import * as z from 'zod';

/**
 * Error Contract #02: SOURCE-ONLY reconciliation of an elevated result.
 *
 * These are untrusted observations, NOT Windows token / signed-receipt /
 * consent verifiers. This module never dispatches, retries, accepts a
 * physical postcondition, or converts an ACK into successful execution.
 */
const identity=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const guid=z.string().uuid();
const stamp=z.string().datetime({offset:true});
const sha256=z.string().regex(/^[a-f0-9]{64}$/);

export const ElevatedExpectedOperationSchema=z.strictObject({
  requestId:guid,
  operationId:guid,
  deviceId:identity,
  ownerAccountId:identity,
  ownerEpoch:z.number().int().positive(),
  action:z.enum(['core.shell.exec','hyperv.vm.start','hyperv.vm.stop']),
  vmId:guid.optional(),
  issuedAt:stamp,
}).superRefine((v,ctx)=>{
  if((v.action.startsWith('hyperv.vm.'))!==Boolean(v.vmId)){
    ctx.addIssue({code:'custom',message:'ELEVATED_TARGET_SHAPE_MISMATCH'});
  }
});

export const ElevatedUntrustedObservationSchema=z.strictObject({
  // A transport ACK never proves the action executed or had an effect.
  ack:z.strictObject({
    requestId:guid,operationId:guid,transportOk:z.boolean(),
    exitCode:z.number().int().nullable().optional(),
  }).optional(),
  // State readback is reported, but cannot self-attest physical provenance.
  vmReadback:z.strictObject({
    requestId:guid,operationId:guid,deviceId:identity,
    ownerAccountId:identity,ownerEpoch:z.number().int().positive(),
    vmId:guid,state:z.enum(['Running','Off','Unknown']),
    observedAt:stamp,
  }).optional(),
  // A claim of immutable target-state observation, NOT a trusted witness.
  // The SHA is caller data: only a separately authenticated native issuer
  // and independently read physical target can establish its provenance.
  immutableVmEffect:z.strictObject({
    requestId:guid,operationId:guid,deviceId:identity,
    ownerAccountId:identity,ownerEpoch:z.number().int().positive(),
    capability:z.enum(['hyperv.vm.start','hyperv.vm.stop']),
    vmId:guid,state:z.enum(['Running','Off','Unknown']),
    stateSha256:sha256,observedAt:stamp,
  }).optional(),
});

// A trusted *external* verifier needs to supply these decisions. No caller
// can derive them from consent.exe, UI flags, PowerShell GetCurrentProcess,
// broker health HTTP 401, a stale VM state, or self-asserted signed=true.
// Even if all are "verified", the missing physical effect verifier means
// this source-only function still cannot certify execution.
export const ElevatedExternalGatesSchema=z.strictObject({
  ownerEpoch:z.enum(['verified','missing','stale']),
  coreGrant:z.enum(['verified','missing','revoked']),
  brokerHighToken:z.enum(['verified','missing']),
  physicalBootstrap:z.enum(['verified','missing']),
});

export type ElevatedExpectedOperation=z.infer<typeof ElevatedExpectedOperationSchema>;
export type ElevatedExternalGates=z.infer<typeof ElevatedExternalGatesSchema>;
export type ElevatedReconciliationReason=
  | 'INVALID_EXPECTED_OPERATION' | 'FORGED_OR_INVALID_OBSERVATION'
  | 'OWNER_EPOCH_NOT_CURRENT' | 'CORE_GRANT_NOT_CURRENT'
  | 'BROKER_HIGH_TOKEN_WITNESS_MISSING' | 'INITIAL_PHYSICAL_UAC_PROOF_MISSING'
  | 'ACK_REQUEST_ID_MISMATCH' | 'ACK_TRANSPORT_UNCONFIRMED'
  | 'POSTCONDITION_MISSING' | 'POSTCONDITION_NOT_APPLICABLE'
  | 'POSTCONDITION_IDENTITY_MISMATCH' | 'POSTCONDITION_STALE'
  | 'POSTCONDITION_CAPABILITY_MISMATCH' | 'POSTCONDITION_RECEIPT_INCONSISTENT'
  | 'POSTCONDITION_STATE_MISMATCH' | 'POSTCONDITION_NATIVE_ATTESTATION_MISSING';

export interface ElevatedReconciliationResult {
  contractVersion:2;
  // Even matching data is only an unattested candidate, NOT physical proof.
  status:'unknown';
  code:'MUTATION_STATE_UNKNOWN';
  denialSource:'undetermined';
  reason:ElevatedReconciliationReason;
  observedAt:'task_verification';
  retrySafety:'reconcile_first';
  dispatchState:'unknown';
  effectVerified:false;
  automaticallyRetryable:false;
  requiresPerCommandUac:false;
  requestId:string|null;
  operationId:string|null;
}

/** Unknown after possible dispatch always requires independent reconciliation. */
export function reconcileElevatedOutcomeEvidence(
  rawExpected:unknown,rawObservation:unknown,rawExternalGates:unknown,
):ElevatedReconciliationResult {
  const expected=ElevatedExpectedOperationSchema.safeParse(rawExpected);
  const observations=ElevatedUntrustedObservationSchema.safeParse(rawObservation);
  const gates=ElevatedExternalGatesSchema.safeParse(rawExternalGates);
  const req=expected.success?expected.data:null;
  const base=(reason:ElevatedReconciliationReason):ElevatedReconciliationResult=>({
    contractVersion:2,status:'unknown',code:'MUTATION_STATE_UNKNOWN',
    denialSource:'undetermined',reason,observedAt:'task_verification',
    retrySafety:'reconcile_first',dispatchState:'unknown',
    effectVerified:false,automaticallyRetryable:false,
    requiresPerCommandUac:false,requestId:req?.requestId??null,
    operationId:req?.operationId??null,
  });
  if(!req)return base('INVALID_EXPECTED_OPERATION');
  if(!observations.success||!gates.success)return base('FORGED_OR_INVALID_OBSERVATION');
  const gate=gates.data,observed=observations.data;
  if(gate.ownerEpoch!=='verified')return base('OWNER_EPOCH_NOT_CURRENT');
  if(gate.coreGrant!=='verified')return base('CORE_GRANT_NOT_CURRENT');
  if(gate.brokerHighToken!=='verified')return base('BROKER_HIGH_TOKEN_WITNESS_MISSING');
  if(gate.physicalBootstrap!=='verified')return base('INITIAL_PHYSICAL_UAC_PROOF_MISSING');
  if(observed.ack&&(observed.ack.requestId!==req.requestId||
      observed.ack.operationId!==req.operationId))return base('ACK_REQUEST_ID_MISMATCH');
  // A negative or missing transport ACK cannot be promoted by a cached VM
  // state. The remote side effect remains UNKNOWN, never automatically rerun.
  if(observed.ack?.transportOk===false)return base('ACK_TRANSPORT_UNCONFIRMED');
  // A VM Running receipt cannot possibly substantiate a shell command; only
  // an independently attested command-specific postcondition could do that.
  if(req.action==='core.shell.exec'&&
      (observed.vmReadback||observed.immutableVmEffect)){
    return base('POSTCONDITION_NOT_APPLICABLE');
  }
  const candidate=observed.immutableVmEffect;
  // A signed-looking, SHA-labelled VM receipt cannot cross from StartVM to
  // StopVM or from a foreign owner/device/request. Even perfect matching
  // content cannot self-attest that the target was actually observed.
  if(candidate){
    if(candidate.capability!==req.action){
      return base('POSTCONDITION_CAPABILITY_MISMATCH');
    }
    if(candidate.requestId!==req.requestId||
        candidate.operationId!==req.operationId||
        candidate.deviceId!==req.deviceId||
        candidate.ownerAccountId!==req.ownerAccountId||
        candidate.ownerEpoch!==req.ownerEpoch||candidate.vmId!==req.vmId){
      return base('POSTCONDITION_IDENTITY_MISMATCH');
    }
    if(Date.parse(candidate.observedAt)<=Date.parse(req.issuedAt)){
      return base('POSTCONDITION_STALE');
    }
    const desired=req.action==='hyperv.vm.start'?'Running':'Off';
    if(candidate.state!==desired){
      return base('POSTCONDITION_STATE_MISMATCH');
    }
    if(observed.vmReadback&&(
      observed.vmReadback.state!==candidate.state||
      observed.vmReadback.vmId!==candidate.vmId||
      observed.vmReadback.requestId!==candidate.requestId||
      observed.vmReadback.operationId!==candidate.operationId||
      observed.vmReadback.ownerEpoch!==candidate.ownerEpoch||
      observed.vmReadback.deviceId!==candidate.deviceId||
      observed.vmReadback.ownerAccountId!==candidate.ownerAccountId)){
      return base('POSTCONDITION_RECEIPT_INCONSISTENT');
    }
  }
  const post=observed.vmReadback;
  if(!post&&!candidate)return base('POSTCONDITION_MISSING');
  if(!post)return base('POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  if(post.requestId!==req.requestId||post.operationId!==req.operationId||
      post.deviceId!==req.deviceId||post.ownerAccountId!==req.ownerAccountId||
      post.ownerEpoch!==req.ownerEpoch||post.vmId!==req.vmId){
    return base('POSTCONDITION_IDENTITY_MISMATCH');
  }
  const when=Date.parse(post.observedAt),issued=Date.parse(req.issuedAt);
  if(!Number.isFinite(when)||!Number.isFinite(issued)||when<=issued){
    return base('POSTCONDITION_STALE');
  }
  const target=req.action==='hyperv.vm.start'?'Running':
    req.action==='hyperv.vm.stop'?'Off':null;
  if(!target||post.state!==target)return base('POSTCONDITION_STATE_MISMATCH');
  // External cryptographic authentication, broker token image trust and a
  // physical fresh VM readback must be proven OUTSIDE this module.
  return base('POSTCONDITION_NATIVE_ATTESTATION_MISSING');
}
