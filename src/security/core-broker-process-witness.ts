import * as z from 'zod';

/** Source-only cross-check contract. No Process Open/Kill/Start, no elevation. */
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const filetime=z.string().regex(/^[1-9][0-9]{9,19}$/);
const fileId=z.string().regex(/^[a-f0-9]{16,64}$/);
export const BrokerProcessIdentitySchema=z.strictObject({
  pid:z.number().int().positive().max(0xffffffff),
  creationFiletime:filetime,
  volumeSerialHex:z.string().regex(/^[a-f0-9]{8,16}$/),
  fileIdHex:fileId,
  runningImageSha256:digest,
  ownerEpoch:z.number().int().positive(),
  deviceId:z.string().min(1).max(128),
});
export type BrokerProcessIdentity=z.infer<typeof BrokerProcessIdentitySchema>;
export interface BrokerRuntimeWitnessContext {
  /** Independently provisioned from authenticated Windows-native Broker IPC.
   * Caller-supplied request metadata and generic shell stdout are NOT evidence.
   */
  trustedObservationSource:'signed-local-high-token-broker'|'unverified';
  observedProcess:unknown;
  expectedDeviceId:string;
  currentOwnerEpoch:number;
  signedPublisherPinned:boolean;
  signedReleaseAndRollbackManifestVerified:boolean;
  protectedExeAndAncestorAclVerified:boolean;
  protectedImportsAndUpdaterTreeVerified:boolean;
  imageHandleFileIdentityVerified:boolean;
  processHandleDaclRejectsLowPrivDupHandle:boolean;
  tokenHighAndEnabledAdministratorsVerified:boolean;
  pendingMutationUnknown:boolean;
  ledgerAvailable:boolean;
}
export type BrokerRuntimeReason=
  | 'INVALID_EXPECTED_PROCESS'
  | 'OBSERVATION_SOURCE_UNVERIFIED'
  | 'NATIVE_PROCESS_EVIDENCE_UNAVAILABLE'
  | 'PID_REUSED_OR_CREATION_TIME_MISMATCH'
  | 'RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID'
  | 'OWNER_DEVICE_EPOCH_INVALID'
  | 'SIGNED_RELEASE_OR_IMAGE_TRUST_UNVERIFIED'
  | 'FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED'
  | 'PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED'
  | 'HIGH_TOKEN_BROKER_UNVERIFIED'
  | 'PENDING_EFFECT_UNKNOWN_NO_REPLAY'
  | 'PRODUCTION_EXECUTOR_NOT_INSTALLED';
export interface BrokerRuntimeAssessment {
  status:'denied'|'unknown';
  reason:BrokerRuntimeReason;
  pidOnlyTaskkillAllowed:false;
  ownerCoreRootElevatedDispatchEnabled:false;
  actualHighIntegrityBrokerAccepted:false;
  productionReady:false;
  effectVerified:false;
  retrySafe:false;
}
export function assessBrokerRuntimeIdentity(
  expected:unknown, context:BrokerRuntimeWitnessContext,
):BrokerRuntimeAssessment {
  const denied=(reason:BrokerRuntimeReason,status:'denied'|'unknown'='denied'):
    BrokerRuntimeAssessment=>({
    status,reason,pidOnlyTaskkillAllowed:false,
    ownerCoreRootElevatedDispatchEnabled:false,
    actualHighIntegrityBrokerAccepted:false,productionReady:false,
    effectVerified:false,retrySafe:false,
  });
  const e=BrokerProcessIdentitySchema.safeParse(expected);
  if(!e.success)return denied('INVALID_EXPECTED_PROCESS');
  if(context.pendingMutationUnknown||!context.ledgerAvailable){
    return denied('PENDING_EFFECT_UNKNOWN_NO_REPLAY','unknown');
  }
  if(context.trustedObservationSource!=='signed-local-high-token-broker'){
    return denied('OBSERVATION_SOURCE_UNVERIFIED');
  }
  const o=BrokerProcessIdentitySchema.safeParse(context.observedProcess);
  if(!o.success)return denied('NATIVE_PROCESS_EVIDENCE_UNAVAILABLE');
  if(o.data.pid!==e.data.pid||o.data.creationFiletime!==e.data.creationFiletime){
    return denied('PID_REUSED_OR_CREATION_TIME_MISMATCH');
  }
  if(o.data.fileIdHex!==e.data.fileIdHex||
    o.data.volumeSerialHex!==e.data.volumeSerialHex||
    o.data.runningImageSha256!==e.data.runningImageSha256){
    return denied('RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID');
  }
  if(context.expectedDeviceId!==e.data.deviceId||
    o.data.deviceId!==e.data.deviceId||
    context.currentOwnerEpoch!==e.data.ownerEpoch||
    o.data.ownerEpoch!==e.data.ownerEpoch){
    return denied('OWNER_DEVICE_EPOCH_INVALID');
  }
  if(!context.signedPublisherPinned||
    !context.signedReleaseAndRollbackManifestVerified||
    !context.imageHandleFileIdentityVerified){
    return denied('SIGNED_RELEASE_OR_IMAGE_TRUST_UNVERIFIED');
  }
  if(!context.protectedExeAndAncestorAclVerified||
    !context.protectedImportsAndUpdaterTreeVerified){
    return denied('FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED');
  }
  if(!context.processHandleDaclRejectsLowPrivDupHandle){
    return denied('PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED');
  }
  if(!context.tokenHighAndEnabledAdministratorsVerified){
    return denied('HIGH_TOKEN_BROKER_UNVERIFIED');
  }
  // No authority implied by a test-created observation, even if all booleans
  // were forged. Real Broker image/runtime/handle authority is not installed.
  return denied('PRODUCTION_EXECUTOR_NOT_INSTALLED');
}
