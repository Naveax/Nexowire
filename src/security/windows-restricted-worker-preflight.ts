/**
 * #780 / QA36: source-only, non-authoritative Windows task sandbox preflight.
 *
 * An arbitrary JavaScript object, log, Job marker, or local test cannot prove
 * Win32 token, process DACL, handle, WFP, or filesystem isolation. This module
 * deliberately has NO launch/authorize API and can NEVER issue a runtime GO.
 * All fields called "claims" below are untrusted observations until checked by
 * a separately implemented, independent, OS-backed physical acceptance harness.
 */

export type ProbeResult = 'DENIED' | 'ALLOWED' | 'NOT_RUN' | 'ERROR';
export type WorkerIsolationMode = 'restricted-token' | 'appcontainer' | 'job-only' | 'ambient';

export interface RestrictedWorkerProposal {
  targetPlatform: string;
  ownerId: string;
  deviceId: string;
  taskId: string;
  requestId: string;
  worktreeId: string;
  sourceSha: string;
  ownerEpoch: number;
  observedOwnerEpoch: number;
  grantExpiresAtMs: number;
  observedAtMs: number;
  grantState: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'UNKNOWN';
  isolationMode: WorkerIsolationMode;
  launchPath: 'future-native-restricted-provider' | 'node-spawn' | 'windows-job-owner' | 'unknown';
  fallbackToAmbientSpawn: boolean;
  environment: 'explicit-allowlist' | 'ambient-process-env';
  handleInheritance: 'explicit-stdio-only' | 'inherit-all' | 'unknown';
  requestedNetworkPolicy: 'deny-all-including-loopback' | 'unspecified' | 'allow';
}

/** Claims are NOT cryptographic receipts and MUST NOT be used as a grant. */
export interface WindowsPhysicalWitnessClaims {
  ownerId: string;
  deviceId: string;
  taskId: string;
  requestId: string;
  ownerEpoch: number;
  rootPid: number;
  rootCreationFiletime: string;
  guardianPid: number;
  tokenUserSid: string;
  expectedTaskSid: string;
  restrictingSids: readonly string[];
  integrityRid: number;
  appContainerSid?: string;
  appContainerCapabilitiesReviewed: boolean;
  appContainerLoopbackExemption: boolean;
  rootAndDescendantsInJob: boolean;
  jobKillOnCloseProven: boolean;
  childTokenMatchesRoot: boolean;
  unexpectedInheritableHandleCount: number;
  outsideTaskRead: ProbeResult;
  outsideTaskWrite: ProbeResult;
  protectedSecretRead: ProbeResult;
  dnsEgress: ProbeResult;
  directIpTcpEgress: ProbeResult;
  udpEgress: ProbeResult;
  loopbackEgress: ProbeResult;
  // A same-user TEMP guardian is NOT the installed, signed HIGH guardian.
  processDupHandleFromLowUser: ProbeResult;
  protectedTargetKind: 'installed-signed-guardian' | 'synthetic-temp' | 'unknown';
  revokedLaunch: ProbeResult;
  lostAckResolution: 'UNKNOWN_NO_REPLAY' | 'RELAUNCHED' | 'UNTESTED';
}

export type RestrictedWorkerFinding =
  | 'TARGET_NOT_WINDOWS'
  | 'TASK_GRANT_IDENTITY_INVALID'
  | 'TASK_GRANT_SHA_INVALID'
  | 'TASK_GRANT_EPOCH_INVALID'
  | 'TASK_GRANT_NOT_CURRENT'
  | 'TASK_GRANT_EXPIRED_OR_REVOKED'
  | 'TOKEN_PROVIDER_UNAVAILABLE'
  | 'AMBIENT_LAUNCH_FALLBACK'
  | 'AMBIENT_ENVIRONMENT'
  | 'HANDLE_INHERITANCE_UNSAFE'
  | 'NETWORK_POLICY_NOT_DENY_ALL'
  | 'PHYSICAL_CLAIMS_NOT_SUPPLIED'
  | 'PHYSICAL_CLAIM_BINDING_MISMATCH'
  | 'PROCESS_IDENTITY_UNPROVEN'
  | 'RESTRICTED_TOKEN_UNPROVEN'
  | 'APPCONTAINER_UNPROVEN'
  | 'LOW_INTEGRITY_UNPROVEN'
  | 'JOB_TREE_LIFETIME_UNPROVEN'
  | 'PRIVILEGED_HANDLE_INHERITANCE_UNPROVEN'
  | 'FILESYSTEM_DENIAL_UNPROVEN'
  | 'NETWORK_DENIAL_UNPROVEN'
  | 'PROTECTED_PROCESS_DUP_HANDLE_UNPROVEN'
  | 'REVOCATION_OR_UNKNOWN_REPLAY_UNSAFE'
  | 'INDEPENDENT_OS_PROVIDER_NOT_ATTESTED';

export interface RestrictedWorkerPreflightReview {
  readonly decision: 'BLOCKED';
  readonly runtimeDispatchAuthorized: false;
  /** Completeness of *claimed evidence* only; never implies authorization. */
  readonly claimsCompleteForIndependentReview: boolean;
  readonly findings: readonly RestrictedWorkerFinding[];
  readonly missingAuthority: 'INDEPENDENT_OS_BACKED_TOKEN_HANDLE_WFP_VERIFIER';
}

function nonblank(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function denied(...values: ProbeResult[]): boolean {
  return values.every((value) => value === 'DENIED');
}

/**
 * Pure negative QA / integration inventory. Even complete CLAIMS yield BLOCKED.
 * A future #03 native authority must independently capture+verify Win32 OS facts,
 * pre-resume, then bind them to the signed grant and immutable journal identity.
 * It must not promote this method's results to a dispatch authorization.
 */
export function reviewWindowsRestrictedWorkerPreflight(
  proposal: RestrictedWorkerProposal,
  claims?: WindowsPhysicalWitnessClaims,
): RestrictedWorkerPreflightReview {
  const findings: RestrictedWorkerFinding[] = [];
  const mark = (condition: boolean, code: RestrictedWorkerFinding): void => {
    if (!condition) findings.push(code);
  };
  mark(proposal.targetPlatform === 'win32', 'TARGET_NOT_WINDOWS');
  mark([proposal.ownerId, proposal.deviceId, proposal.taskId, proposal.requestId,
    proposal.worktreeId].every(nonblank), 'TASK_GRANT_IDENTITY_INVALID');
  mark(/^[a-f0-9]{40}$/.test(proposal.sourceSha), 'TASK_GRANT_SHA_INVALID');
  mark(Number.isSafeInteger(proposal.ownerEpoch) && proposal.ownerEpoch > 0 &&
    Number.isSafeInteger(proposal.observedOwnerEpoch) && proposal.observedOwnerEpoch > 0,
  'TASK_GRANT_EPOCH_INVALID');
  mark(proposal.ownerEpoch === proposal.observedOwnerEpoch, 'TASK_GRANT_NOT_CURRENT');
  mark(proposal.grantState === 'ACTIVE' &&
    Number.isSafeInteger(proposal.observedAtMs) &&
    Number.isSafeInteger(proposal.grantExpiresAtMs) &&
    proposal.observedAtMs >= 0 && proposal.grantExpiresAtMs > proposal.observedAtMs,
  'TASK_GRANT_EXPIRED_OR_REVOKED');
  mark(proposal.launchPath === 'future-native-restricted-provider' &&
    (proposal.isolationMode === 'restricted-token' || proposal.isolationMode === 'appcontainer'),
  'TOKEN_PROVIDER_UNAVAILABLE');
  mark(proposal.fallbackToAmbientSpawn === false, 'AMBIENT_LAUNCH_FALLBACK');
  mark(proposal.environment === 'explicit-allowlist', 'AMBIENT_ENVIRONMENT');
  mark(proposal.handleInheritance === 'explicit-stdio-only', 'HANDLE_INHERITANCE_UNSAFE');
  mark(proposal.requestedNetworkPolicy === 'deny-all-including-loopback',
    'NETWORK_POLICY_NOT_DENY_ALL');

  if (claims === undefined) {
    findings.push('PHYSICAL_CLAIMS_NOT_SUPPLIED');
  } else {
    mark(claims.ownerId === proposal.ownerId && claims.deviceId === proposal.deviceId &&
      claims.taskId === proposal.taskId && claims.requestId === proposal.requestId &&
      claims.ownerEpoch === proposal.ownerEpoch,
    'PHYSICAL_CLAIM_BINDING_MISMATCH');
    mark(Number.isSafeInteger(claims.rootPid) && claims.rootPid > 0 &&
      Number.isSafeInteger(claims.guardianPid) && claims.guardianPid > 0 &&
      claims.guardianPid !== claims.rootPid &&
      /^[1-9][0-9]{5,}$/.test(claims.rootCreationFiletime),
    'PROCESS_IDENTITY_UNPROVEN');
    mark(nonblank(claims.tokenUserSid) && nonblank(claims.expectedTaskSid) &&
      claims.tokenUserSid !== claims.expectedTaskSid &&
      Array.isArray(claims.restrictingSids) &&
      claims.restrictingSids.includes(claims.expectedTaskSid),
    'RESTRICTED_TOKEN_UNPROVEN');
    if (proposal.isolationMode === 'appcontainer') {
      mark(nonblank(claims.appContainerSid ?? '') &&
        claims.appContainerCapabilitiesReviewed === true &&
        claims.appContainerLoopbackExemption === false,
      'APPCONTAINER_UNPROVEN');
    }
    mark(Number.isSafeInteger(claims.integrityRid) &&
      claims.integrityRid >= 0 && claims.integrityRid <= 0x1000,
    'LOW_INTEGRITY_UNPROVEN');
    mark(claims.rootAndDescendantsInJob === true && claims.jobKillOnCloseProven === true &&
      claims.childTokenMatchesRoot === true,
    'JOB_TREE_LIFETIME_UNPROVEN');
    mark(claims.unexpectedInheritableHandleCount === 0,
    'PRIVILEGED_HANDLE_INHERITANCE_UNPROVEN');
    mark(denied(claims.outsideTaskRead, claims.outsideTaskWrite, claims.protectedSecretRead),
    'FILESYSTEM_DENIAL_UNPROVEN');
    mark(denied(claims.dnsEgress, claims.directIpTcpEgress,
      claims.udpEgress, claims.loopbackEgress),
    'NETWORK_DENIAL_UNPROVEN');
    mark(claims.protectedTargetKind === 'installed-signed-guardian' &&
      claims.processDupHandleFromLowUser === 'DENIED',
    'PROTECTED_PROCESS_DUP_HANDLE_UNPROVEN');
    mark(claims.revokedLaunch === 'DENIED' && claims.lostAckResolution === 'UNKNOWN_NO_REPLAY',
    'REVOCATION_OR_UNKNOWN_REPLAY_UNSAFE');
  }
  // This gate is intentionally impossible to satisfy using source-level data.
  // The #03 native provider and an independently authorized physical verifier
  // have not been installed or invoked by this module.
  findings.push('INDEPENDENT_OS_PROVIDER_NOT_ATTESTED');
  return Object.freeze({
    decision: 'BLOCKED',
    runtimeDispatchAuthorized: false,
    claimsCompleteForIndependentReview: findings.length === 1 &&
      findings[0] === 'INDEPENDENT_OS_PROVIDER_NOT_ATTESTED',
    findings: Object.freeze(findings),
    missingAuthority: 'INDEPENDENT_OS_BACKED_TOKEN_HANDLE_WFP_VERIFIER',
  });
}
