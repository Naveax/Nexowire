import * as z from 'zod';

/**
 * #617: CORE/ROOT broad elevated execution contract, SOURCE ONLY.
 * There is no elevation, command runner, Hyper-V API call, UAC action,
 * service install, or Broker dispatch in this module.
 */
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const guid=z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const datetime=z.string().datetime({offset:true});
export const CORE_EXECUTOR_DISPATCH_ENABLED=false;
export const CoreBrokerActionSchema=z.enum([
  'core.shell.exec','core.process.start','core.process.stop',
  'hyperv.vm.status','hyperv.vm.start','hyperv.vm.stop',
]);
const ShellArgsSchema=z.strictObject({
  executable:z.string().min(1).max(32767),
  arguments:z.array(z.string().max(32767)).max(256),
  workingDirectory:z.string().max(4096).optional(),
});
const StopTargetSchema=z.strictObject({
  pid:z.number().int().positive().max(0xffffffff),
  processCreationFiletime:z.string().regex(/^[1-9][0-9]{9,19}$/),
  expectedImageSha256:sha,
});
export const CoreBrokerExecutionRequestSchema=z.strictObject({
  type:z.literal('core-broker.execute'),
  version:z.literal(1),
  requestId:z.string().uuid(),
  deviceId:id,
  ownerAccountId:id,
  ownerEpoch:z.number().int().positive(),
  credentialBinding:sha,
  mode:z.enum(['CORE','ROOT']),
  action:CoreBrokerActionSchema,
  issuedAt:datetime,
  expiresAt:datetime,
  // Exactly one target schema per capability; no arbitrary client-provided UAC.
  shell:ShellArgsSchema.optional(),
  stopTarget:StopTargetSchema.optional(),
  vmId:guid.optional(),
}).superRefine((value,ctx)=>{
  const shell=value.action==='core.shell.exec'||value.action==='core.process.start';
  const stop=value.action==='core.process.stop';
  const hyperv=value.action.startsWith('hyperv.vm.');
  if((shell!==Boolean(value.shell))||(stop!==Boolean(value.stopTarget))||
    (hyperv!==Boolean(value.vmId))){
    ctx.addIssue({code:'custom',message:'CORE_EXECUTOR_TARGET_SHAPE_DENIED'});
  }
});
export type CoreBrokerExecutionRequest=z.infer<typeof CoreBrokerExecutionRequestSchema>;

export const CoreBrokerEnrollmentSchema=z.strictObject({
  deviceId:id,ownerAccountId:id,ownerEpoch:z.number().int().positive(),
  credentialBinding:sha,
  enrollmentId:z.string().uuid(),
  activatedAt:datetime,
  // CORE stays enrolled until explicit revocation/epoch change; ROOT max 15m.
  mode:z.enum(['CORE','ROOT']),
  expiresAt:datetime.nullable(),
  ownerSignedGrantDigest:sha,
  brokerInstalledImageSha256:sha,
});
export type CoreBrokerEnrollment=z.infer<typeof CoreBrokerEnrollmentSchema>;
export interface CoreBrokerContext {
  now:Date;
  deviceId:string;
  ownerAccountId:string;
  credentialBinding:string;
  /** Trusted external monotonic owner epoch; never request data. */
  authoritativeOwnerEpoch:number;
  ownerRevoked:boolean;
  enrollment:CoreBrokerEnrollment|null;
  /** Native bootstrap approved once, not per command. */
  localBootstrap:{
    localPhysicalUacConsentVerified:boolean;
    signedEnrollmentStoredInProtectedBroker:boolean;
    trustedInstallerRollbackBindingVerified:boolean;
  };
  /** Separate trusted broker/Windows-native observations. */
  trustedRuntime:{
    evidenceProvenance:'independent-windows-native'|'unverified';
    brokerProcessHighIntegrity:boolean;
    administratorsTokenEnabled:boolean;
    brokerAuthenticatedAndVersionMatched:boolean;
    runningImageIdentityMatched:boolean;
    expectedBrokerImageSha256:string;
    imageAuthenticodePublisherPinned:boolean;
    signedReleaseAndRollbackManifestVerified:boolean;
    brokerExeAndParentAclProtected:boolean;
    importedModulesAclProtected:boolean;
    updaterPathsAclProtected:boolean;
    processHandleDuplicationBoundaryProtected:boolean;
  };
  ownerIntentSignatureVerified:boolean;
  enrollmentSignatureVerified:boolean;
  ownerEpochWitnessVerified:boolean;
  /** Durable independent monotonic replay ledger. */
  requestAlreadyReserved:(requestId:string,ownerEpoch:number)=>boolean;
  /** Unknown last mutation must be externally reconciled, no auto replay. */
  pendingMutationUnknown:boolean;
  /** Typed Hyper-V VM GUID grants are scoped separately; broad shell is not VM allowlist. */
  approvedVmIds:readonly string[];
  /** For PID destructive actions require independent identity at dispatch time. */
  stopProcessIdentityVerified:boolean;
}

export type CoreBrokerBlockReason=
  | 'INVALID_TYPED_REQUEST'|'WRONG_DEVICE_OR_OWNER_EPOCH'|'GRANT_REVOKED'
  | 'MISSING_SIGNED_ENROLLMENT'|'GRANT_NOT_ACTIVE'|'ROOT_15_MINUTES_EXCEEDED'
  | 'STALE_OR_REPLAYED_REQUEST'|'UNKNOWN_MUTATION_NO_REPLAY'
  | 'OWNER_COMMAND_SIGNATURE_REQUIRED'|'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED'
  | 'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED'
  | 'VM_GUID_NOT_APPROVED'|'PROCESS_IDENTITY_UNVERIFIED'
  | 'ELEVATED_DISPATCH_NOT_INSTALLED';
export interface CoreBrokerAdmissionResult {
  mode:'CORE'|'ROOT'|null;
  requestedAction:string;
  status:'denied'|'pending'|'unknown';
  denialSource:'nexowire'|'policy'|'user'|'undetermined';
  reason:CoreBrokerBlockReason;
  privilegedExecutionOccurred:false;
  verifiedEffect:false;
  automaticallyRetryable:false;
  oneTimeBootstrapAlreadyVerified:boolean;
  requiresPerCommandUac:false;
  requestId:string|null;
}
/** The source gate may prove prerequisites are present, but no execution path exists. */
export function evaluateCoreBrokerExecution(raw:unknown,context:CoreBrokerContext):CoreBrokerAdmissionResult {
  const parsed=CoreBrokerExecutionRequestSchema.safeParse(raw);
  const req=parsed.success?parsed.data:null;
  const bootstrap=context.localBootstrap.localPhysicalUacConsentVerified &&
    context.localBootstrap.signedEnrollmentStoredInProtectedBroker &&
    context.localBootstrap.trustedInstallerRollbackBindingVerified;
  const block=(reason:CoreBrokerBlockReason,
    status:'denied'|'pending'|'unknown'='denied',
    source:'nexowire'|'policy'|'user'|'undetermined'='policy'):CoreBrokerAdmissionResult=>({
    mode:req?.mode??null,requestedAction:req?.action??'unverified',
    status,denialSource:source,reason,
    privilegedExecutionOccurred:false,verifiedEffect:false,automaticallyRetryable:false,
    oneTimeBootstrapAlreadyVerified:bootstrap,requiresPerCommandUac:false,
    requestId:req?.requestId??null,
  });
  if(!req)return block('INVALID_TYPED_REQUEST');
  if(req.deviceId!==context.deviceId||req.ownerAccountId!==context.ownerAccountId||
     req.credentialBinding!==context.credentialBinding||
     req.ownerEpoch!==context.authoritativeOwnerEpoch){
    return block('WRONG_DEVICE_OR_OWNER_EPOCH');
  }
  if(context.ownerRevoked)return block('GRANT_REVOKED');
  const e=context.enrollment;
  if(!e||!CoreBrokerEnrollmentSchema.safeParse(e).success||
    e.deviceId!==req.deviceId||e.ownerAccountId!==req.ownerAccountId||
    e.ownerEpoch!==req.ownerEpoch||e.credentialBinding!==req.credentialBinding||
    e.mode!==req.mode||
    e.brokerInstalledImageSha256!==context.trustedRuntime.expectedBrokerImageSha256){
    return block('MISSING_SIGNED_ENROLLMENT');
  }
  const now=context.now.getTime(),issued=Date.parse(req.issuedAt),
    expires=Date.parse(req.expiresAt),activated=Date.parse(e.activatedAt);
  if(!Number.isFinite(now)||!Number.isFinite(issued)||!Number.isFinite(expires)||
     !Number.isFinite(activated)||issued>now+5000||now>=expires||
     expires<=issued||expires-issued>120000||activated>now){
    return block('GRANT_NOT_ACTIVE');
  }
  if(e.mode==='ROOT'){
    const end=e.expiresAt===null?NaN:Date.parse(e.expiresAt);
    if(!Number.isFinite(end)||end<=activated||end-activated>900000||
      now>=end||expires>end)return block('ROOT_15_MINUTES_EXCEEDED');
  }else if(e.expiresAt!==null){
    return block('MISSING_SIGNED_ENROLLMENT');
  }
  if(context.pendingMutationUnknown)return block('UNKNOWN_MUTATION_NO_REPLAY','unknown','undetermined');
  let reserved=false;
  try{reserved=context.requestAlreadyReserved(req.requestId,req.ownerEpoch)}catch{
    return block('STALE_OR_REPLAYED_REQUEST','unknown','undetermined');
  }
  if(reserved)return block('STALE_OR_REPLAYED_REQUEST','unknown','undetermined');
  if(!context.ownerIntentSignatureVerified||!context.enrollmentSignatureVerified||
    !context.ownerEpochWitnessVerified)return block('OWNER_COMMAND_SIGNATURE_REQUIRED');
  if(!bootstrap)return block('LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED','pending','user');
  const t=context.trustedRuntime;
  if(t.evidenceProvenance!=='independent-windows-native'||!t.brokerProcessHighIntegrity||
    !t.administratorsTokenEnabled||!t.brokerAuthenticatedAndVersionMatched||
    !t.runningImageIdentityMatched||!t.imageAuthenticodePublisherPinned||
    !t.signedReleaseAndRollbackManifestVerified||!t.brokerExeAndParentAclProtected||
    !t.importedModulesAclProtected||!t.updaterPathsAclProtected||
    !t.processHandleDuplicationBoundaryProtected){
    return block('ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
  }
  if(req.vmId&&!context.approvedVmIds.includes(req.vmId))return block('VM_GUID_NOT_APPROVED');
  if(req.stopTarget&&!context.stopProcessIdentityVerified)return block('PROCESS_IDENTITY_UNVERIFIED');
  // No real dispatch, shell, process, Hyper-V, UAC or installation in this PR.
  return block('ELEVATED_DISPATCH_NOT_INSTALLED');
}
