/**
 * Isolated S3 crash/restart assessment: NEVER executes recovery, starts a
 * service, sets ACLs or claims a VM snapshot restoration.
 *
 * A local journal may be rolled back WITH the installer tree. It is not a
 * trusted authority: an independent off-host monotonic checkpoint and native
 * file-handle/process attestation are required for automatic recovery.
 */
import {createHash} from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const CRASH_PHASES = [
  'signed_stage_ready',
  'service_stop_started',
  'target_cutover_started',
  'target_start_started',
  'health_pending',
  'rollback_cutover_started',
  'rollback_start_started',
  'awaiting_external_acceptance',
] as const;
export type CrashPhase = typeof CRASH_PHASES[number];
export interface S3CrashRecord {
  schemaVersion:1;
  transactionId:string;
  ownerAccountId:string;
  deviceId:string;
  oldAgentVersion:string;
  targetAgentVersion:string;
  hubVersion:string;
  oldArtifactSha256:string;
  targetArtifactSha256:string;
  installerHelperSha256:string;
  sequence:number;
  phase:CrashPhase;
}
export interface S3RecoveryPins {
  transactionId:string;
  ownerAccountId:string;
  deviceId:string;
  oldAgentVersion:string;
  targetAgentVersion:string;
  hubVersion:string;
  oldArtifactSha256:string;
  targetArtifactSha256:string;
  installerHelperSha256:string;
  /** Obtained from an *independent* authoritative monotonic system. */
  minimumIndependentSequence:number;
}
export type CrashAssessment = {
  disposition:'NO_AUTOMATIC_RESTART_OR_ROLLBACK';
  status:'invalid'|'stale_or_rollback'|'unverified_local_checkpoint'|'interrupted_after_stop';
  productionAccepted:false;
  resumeAllowed:false;
  rollbackAllowed:false;
  /** Useful for displaying a bounded reason, never an assertion of safety. */
  reason:string;
};
const sha=(s:string)=>SHA.test(s);
const equals=(a:unknown,b:unknown)=>a===b;
function validSemver(s:string):boolean{
  return VERSION.test(s)&&s.split('.').every(x=>Number.isSafeInteger(Number(x)));
}
export function assessS3CrashRecovery(
  untrustedJournal:unknown, pins:S3RecoveryPins,
):CrashAssessment{
  const blocked=(status:CrashAssessment['status'],reason:string):CrashAssessment=>({
    disposition:'NO_AUTOMATIC_RESTART_OR_ROLLBACK',status,reason,
    productionAccepted:false,resumeAllowed:false,rollbackAllowed:false,
  });
  if(!untrustedJournal||typeof untrustedJournal!=='object'||Array.isArray(untrustedJournal)||
     !pins||typeof pins!=='object')return blocked('invalid','missing_record_or_pins');
  const j=untrustedJournal as Record<string,unknown>;
  const expectedKeys=[
    'schemaVersion','transactionId','ownerAccountId','deviceId',
    'oldAgentVersion','targetAgentVersion','hubVersion','oldArtifactSha256',
    'targetArtifactSha256','installerHelperSha256','sequence','phase',
  ];
  if(Object.keys(j).sort().join(',')!==expectedKeys.sort().join(',')||
      j.schemaVersion!==1||
      typeof j.transactionId!=='string'||!ID.test(j.transactionId)||
      typeof j.ownerAccountId!=='string'||!ID.test(j.ownerAccountId)||
      typeof j.deviceId!=='string'||!ID.test(j.deviceId)||
      typeof j.phase!=='string'||!CRASH_PHASES.includes(j.phase as CrashPhase)||
      !Number.isSafeInteger(j.sequence)||Number(j.sequence)<0||
      !Number.isSafeInteger(pins.minimumIndependentSequence)||
      pins.minimumIndependentSequence<0){
    return blocked('invalid','invalid_schema');
  }
  const matchingFields=[
    'transactionId','ownerAccountId','deviceId','oldAgentVersion',
    'targetAgentVersion','hubVersion','oldArtifactSha256','targetArtifactSha256',
    'installerHelperSha256',
  ] as const;
  if(!matchingFields.every(k=>equals(j[k],pins[k]))||
    !validSemver(pins.oldAgentVersion)||
    !validSemver(pins.targetAgentVersion)||
    !validSemver(pins.hubVersion)||
    !sha(pins.oldArtifactSha256)||!sha(pins.targetArtifactSha256)||
    !sha(pins.installerHelperSha256)||
    pins.oldArtifactSha256===pins.targetArtifactSha256){
    return blocked('invalid','pin_scope_hash_version_mismatch');
  }
  if((j.sequence as number)<pins.minimumIndependentSequence){
    return blocked('stale_or_rollback','journal_replayed_below_independent_cas');
  }
  if(j.phase==='signed_stage_ready'){
    // Even a pre-stop local snapshot might be malicious/stale. It needs an
    // independent attestation proving the process was NEVER stopped.
    return blocked('unverified_local_checkpoint','prestop_requires_external_process_proof');
  }
  return blocked('interrupted_after_stop','native_process_and_signed_rollback_proof_missing');
}
export function digestUntrustedRecoveryJournal(record:unknown):string{
  // Diagnostic digest only: NOT a signature, monotonic anchor or trust root.
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}
