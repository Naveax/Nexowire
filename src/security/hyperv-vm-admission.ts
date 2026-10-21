import * as z from 'zod';

/**
 * P0 #617 SOURCE-ONLY design. There is deliberately no executable path,
 * PowerShell command, Hyper-V module import, runner, bridge registration, or
 * elevated dispatch capability in this module.
 */
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const exactGuid=z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const observedTime=z.string().datetime({offset:true});

export const HypervVmCapabilitySchema=z.enum([
  'hyperv.vm.status','hyperv.vm.start','hyperv.vm.stop',
]);
export const HypervVmRequestSchema=z.strictObject({
  type:z.literal('hyperv.vm.request'),
  version:z.literal(1),
  capability:HypervVmCapabilitySchema,
  requestId:z.string().uuid(),
  vmId:exactGuid,
  deviceId:id,
  ownerAccountId:id,
  credentialBinding:digest,
  issuedAt:observedTime,
  expiresAt:observedTime,
});
export type HypervVmRequest=z.infer<typeof HypervVmRequestSchema>;

export const HypervVmGrantSchema=z.strictObject({
  vmId:exactGuid,
  deviceId:id,
  ownerAccountId:id,
  credentialBinding:digest,
  allowStatus:z.boolean(),
  allowStart:z.boolean(),
  allowStop:z.boolean(),
  expiresAt:observedTime,
});
export type HypervVmGrant=z.infer<typeof HypervVmGrantSchema>;

export interface HypervVmGateContext {
  /** Trusted host identity, NOT read from the incoming Hyper-V request. */
  deviceId:string;
  ownerAccountId:string;
  credentialBinding:string;
  now:Date;
  /** Provisioned out-of-band, immutable GUID-only VM grants; never request input. */
  grants:readonly HypervVmGrant[];
  /** Durable external monotonic request ledger, not in-memory-only. */
  hasConsumedRequestId:(requestId:string)=>boolean;
  /** Independently verified provenance, not client supplied fields. */
  signedOwnerIntentVerified:boolean;
  privilegedBrokerAuthenticated:boolean;
  brokerVersionMatch:boolean;
  localPhysicalApproval:'confirmed'|'denied'|'pending'|'unknown';
  /** A separate trusted Windows-native helper/installer verifier is required. */
  trust:{
    provenance:'independent-windows-native'|'unverified';
    helperAuthenticodeValid:boolean;
    publisherPinned:boolean;
    signedReleaseManifestVerified:boolean;
    helperExeImageIdentityMatched:boolean;
    launcherFileAclProtected:boolean;
    launcherAncestorAclProtected:boolean;
    helperImportTreeAclProtected:boolean;
    updaterPathsAclProtected:boolean;
    processTokenAuthorityVerified:boolean;
  };
}
export type HypervVmDenial =
  | 'HYPERV_REQUEST_SCHEMA_DENIED'
  | 'HYPERV_BOUND_IDENTITY_MISMATCH'
  | 'HYPERV_INTENT_EXPIRED_OR_INVALID'
  | 'HYPERV_REPLAY_UNKNOWN'
  | 'HYPERV_VM_GUID_NOT_ALLOWLISTED'
  | 'HYPERV_CAPABILITY_NOT_GRANTED'
  | 'HYPERV_OWNER_INTENT_UNVERIFIED'
  | 'HYPERV_BROKER_UNVERIFIED'
  | 'HYPERV_HELPER_TRUST_UNVERIFIED'
  | 'HYPERV_LOCAL_APPROVAL_REQUIRED'
  | 'HYPERV_LOCAL_APPROVAL_DECLINED'
  | 'HYPERV_DISPATCH_DISABLED_SOURCE_ONLY';
export interface HypervVmGateResult {
  requestedCapability:string;
  target:{deviceId:string|null;vmId:string|null};
  execution:{status:'denied'|'pending';denialSource:'policy'|'nexowire'|'user';reason:HypervVmDenial;effectVerified:false;retrySafe:false};
  audit:{requestId:string|null;observedAt:string;source:'source-only-policy-evaluation'};
}
export const HYPERV_ELEVATED_DISPATCH_ENABLED=false;

/**
 * A pure, deliberately non-executing admission check. Even perfectly forged
 * attestation booleans CANNOT make this function start/status/stop a VM.
 */
export function evaluateHypervVmRequest(raw:unknown,context:HypervVmGateContext):HypervVmGateResult {
  const parsed=HypervVmRequestSchema.safeParse(raw);
  const request=parsed.success?parsed.data:null;
  const answer=(reason:HypervVmDenial,source:'policy'|'nexowire'|'user'='policy',
    status:'denied'|'pending'='denied'):HypervVmGateResult=>({
    requestedCapability:request?.capability??'unverified',
    target:{deviceId:request?.deviceId??null,vmId:request?.vmId??null},
    execution:{status,denialSource:source,reason,effectVerified:false,retrySafe:false},
    audit:{requestId:request?.requestId??null,
      observedAt:Number.isFinite(context.now.getTime())?context.now.toISOString():'unverified',
      source:'source-only-policy-evaluation'},
  });
  if(!request)return answer('HYPERV_REQUEST_SCHEMA_DENIED');
  if(request.deviceId!==context.deviceId ||
    request.ownerAccountId!==context.ownerAccountId ||
    request.credentialBinding!==context.credentialBinding) {
    return answer('HYPERV_BOUND_IDENTITY_MISMATCH');
  }
  const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt),now=context.now.getTime();
  if(!Number.isFinite(now)||!Number.isFinite(issued)||!Number.isFinite(expires)||
    expires<=issued||expires-issued>120_000||issued>now+5_000||now>=expires) {
    return answer('HYPERV_INTENT_EXPIRED_OR_INVALID');
  }
  // Missing ledger is not permitted: caller must supply a real authority at
  // integration. This callback is a source-only seam, not an actual ledger.
  try {
    if(context.hasConsumedRequestId(request.requestId))return answer('HYPERV_REPLAY_UNKNOWN');
  } catch {
    return answer('HYPERV_REPLAY_UNKNOWN');
  }
  const grant=context.grants.find(g=>
    HypervVmGrantSchema.safeParse(g).success &&
    g.vmId===request.vmId&&g.deviceId===request.deviceId &&
    g.ownerAccountId===request.ownerAccountId &&
    g.credentialBinding===request.credentialBinding &&
    Date.parse(g.expiresAt)>now);
  if(!grant)return answer('HYPERV_VM_GUID_NOT_ALLOWLISTED');
  const key=request.capability==='hyperv.vm.status'?'allowStatus':
    request.capability==='hyperv.vm.start'?'allowStart':'allowStop';
  if(!grant[key])return answer('HYPERV_CAPABILITY_NOT_GRANTED');
  if(!context.signedOwnerIntentVerified)return answer('HYPERV_OWNER_INTENT_UNVERIFIED');
  if(!context.privilegedBrokerAuthenticated||!context.brokerVersionMatch) {
    return answer('HYPERV_BROKER_UNVERIFIED','nexowire');
  }
  const t=context.trust;
  if(t.provenance!=='independent-windows-native'||!t.helperAuthenticodeValid||
    !t.publisherPinned||!t.signedReleaseManifestVerified||
    !t.helperExeImageIdentityMatched||!t.launcherFileAclProtected||
    !t.launcherAncestorAclProtected||!t.helperImportTreeAclProtected||
    !t.updaterPathsAclProtected||!t.processTokenAuthorityVerified) {
    return answer('HYPERV_HELPER_TRUST_UNVERIFIED','nexowire');
  }
  if(request.capability!=='hyperv.vm.status') {
    if(context.localPhysicalApproval==='denied')return answer('HYPERV_LOCAL_APPROVAL_DECLINED','user');
    if(context.localPhysicalApproval!=='confirmed')return answer('HYPERV_LOCAL_APPROVAL_REQUIRED','user','pending');
  }
  // Keep disabled even when all supplied test fixtures claim trusted state.
  // Secure Desktop consent is never clicked, simulated or bypassed.
  return answer('HYPERV_DISPATCH_DISABLED_SOURCE_ONLY','nexowire');
}
