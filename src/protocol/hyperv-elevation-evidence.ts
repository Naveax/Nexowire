/**
 * #617 read-only evidence contract for an explicitly scoped Hyper-V operation.
 *
 * NOT an executor, Windows token attestation, Broker authorization, UAC
 * approval mechanism or proof of any VM's physical state. In particular,
 * source/UI facts MUST NOT be used to grant an elevated command.
 * There is deliberately no "succeeded" return value until a separately
 * trusted, independently attested Hyper-V postcondition is implemented.
 */
export type HypervCapability =
  | 'hyperv.vm.start' | 'hyperv.vm.stop' | 'hyperv.vm.status';
export type HypervDecision = 'denied' | 'pending' | 'unknown';
export type HypervDenialSource =
  | 'windows' | 'nexowire' | 'policy' | 'user' | 'undetermined';

export interface HypervElevationSnapshot {
  readonly capability: HypervCapability;
  readonly deviceId: string;
  readonly vmName: string;
  readonly vmId: string | null;
  readonly agentConnected: boolean;
  /** Real local process token assessment, NEVER FULL/ROOT/CORE preference. */
  readonly currentProcessElevated: boolean | null;
  readonly processIntegrity: 'low' | 'medium' | 'high' | 'system' | 'unverified';
  /** Only authenticated, version-matched AND locally attested Broker is ready. */
  readonly broker: {
    readonly authenticatedHealth: 'verified' | 'failed' | 'unverified';
    readonly elevatedToken: 'verified' | 'failed' | 'unverified';
    readonly versionMatch: 'verified' | 'failed' | 'unverified';
    readonly capabilityAllowed: boolean;
  };
  /** A remote button/CORE lease is not physical approval or Windows UAC. */
  readonly localApproval: 'not_verified' | 'pending' | 'rejected' | 'verified';
  readonly ownerPolicyApproved: boolean;
  /** Owner-selected Nexowire mode. This is not OS token elevation. */
  readonly ownerGrant: 'safe' | 'full' | 'root' | 'core';
  /** Independent authority expected; the snapshot alone does not attest it. */
  readonly rootLease: 'verified' | 'expired' | 'unverified';
  readonly coreEnrollment: 'verified' | 'revoked' | 'unverified';
  /** No transport ACK can independently establish a Windows side effect. */
  readonly dispatch: 'not_sent' | 'lost_confirmation' | 'ack_unverified';
}

export interface HypervElevationExplanation {
  readonly requestedCapability: HypervCapability;
  readonly target: { readonly deviceId: string; readonly vmName: string; readonly vmId: string | null };
  readonly windows: {
    readonly currentProcessElevated: boolean | null;
    readonly elevationRequired: boolean | 'unverified';
    readonly processIntegrity: HypervElevationSnapshot['processIntegrity'];
  };
  readonly adminBridge: HypervElevationSnapshot['broker'];
  readonly localApproval: HypervElevationSnapshot['localApproval'];
  readonly delegation: {
    readonly requested: HypervElevationSnapshot['ownerGrant'];
    readonly state: 'not-authorized' | 'root-preapproved' | 'core-preapproved';
    /** The approved elevated Broker should avoid repeated RunAs prompts. */
    readonly perOperationUacRequired: boolean;
  };
  readonly execution: {
    readonly status: HypervDecision;
    readonly denialSource: HypervDenialSource;
    readonly code: string;
    readonly effectVerified: false;
    readonly automaticallyRetryable: false;
  };
}

/** Only a fully pinned VM GUID can be used for mutating Hyper-V operations. */
export function validHypervVmId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function explainHypervElevation(
  s: HypervElevationSnapshot,
): HypervElevationExplanation {
  if (!['hyperv.vm.start', 'hyperv.vm.stop', 'hyperv.vm.status'].includes(s.capability)) {
    throw new Error('HYPERV_CAPABILITY_INVALID');
  }
  if (typeof s.deviceId !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,128}$/.test(s.deviceId) ||
      typeof s.vmName !== 'string' || s.vmName.length < 1 || s.vmName.length > 128 ||
      !/^[\p{L}\p{N}_. ()-]+$/u.test(s.vmName)) {
    throw new Error('HYPERV_TARGET_INVALID');
  }
  const mutation = s.capability !== 'hyperv.vm.status';
  const brokerVerified =
    s.broker.authenticatedHealth === 'verified' &&
    s.broker.elevatedToken === 'verified' &&
    s.broker.versionMatch === 'verified' &&
    s.broker.capabilityAllowed;

  // ROOT and CORE are intended to supply real preapproved elevated authority.
  // Do not downgrade an owner-confirmed mode to per-command UAC consent.
  // This pure snapshot is NOT authorization or token attestation itself.
  const rootDelegated = s.ownerGrant === 'root' && s.rootLease === 'verified';
  const coreDelegated = s.ownerGrant === 'core' && s.coreEnrollment === 'verified';
  const delegated = rootDelegated || coreDelegated;
  const delegationState = coreDelegated ? 'core-preapproved' :
    rootDelegated ? 'root-preapproved' : 'not-authorized';

  let status: HypervDecision = 'pending';
  let denialSource: HypervDenialSource = 'undetermined';
  let code = 'HYPERV_INDEPENDENT_EXECUTION_AND_READBACK_REQUIRED';

  // Possible side effect has highest precedence: an earlier authorization
  // failure is not evidence that an already dispatched mutation did nothing.
  if (s.dispatch !== 'not_sent') {
    status = 'unknown';
    code = 'MUTATION_STATE_UNKNOWN';
  } else if (!s.agentConnected) {
    status = 'denied';
    denialSource = 'nexowire';
    code = 'AGENT_DISCONNECTED';
  } else if (!s.ownerPolicyApproved) {
    status = 'denied';
    denialSource = 'policy';
    code = 'HYPERV_OWNER_POLICY_UNVERIFIED';
  } else if (mutation && !validHypervVmId(s.vmId)) {
    status = 'denied';
    denialSource = 'policy';
    code = 'HYPERV_SCOPED_VM_ID_REQUIRED';
  } else if (s.localApproval === 'rejected') {
    status = 'denied';
    denialSource = 'user';
    code = 'HYPERV_LOCAL_APPROVAL_REJECTED';
  } else if (mutation && !delegated) {
    // An owner preference or FULL flag alone is not a real ROOT/CORE grant.
    // Initial Windows enrolment is a separate privileged installation step.
    status = 'denied';
    denialSource = 'policy';
    code = s.ownerGrant === 'safe' || s.ownerGrant === 'full'
      ? 'HYPERV_ELEVATED_MODE_REQUIRED'
      : 'HYPERV_OWNER_DELEGATION_UNVERIFIED';
  } else if (!brokerVerified && s.currentProcessElevated === false) {
    status = 'denied';
    denialSource = 'windows';
    code = 'HYPERV_ELEVATED_TOKEN_UNAVAILABLE';
  } else if (!brokerVerified) {
    status = 'denied';
    denialSource = 'nexowire';
    code = 'HYPERV_BROKER_NOT_ATTESTED';
  }

  return {
    requestedCapability: s.capability,
    target: { deviceId: s.deviceId, vmName: s.vmName, vmId: s.vmId },
    windows: {
      currentProcessElevated: s.currentProcessElevated,
      elevationRequired: mutation ? true : 'unverified',
      processIntegrity: s.processIntegrity,
    },
    adminBridge: { ...s.broker },
    localApproval: s.localApproval,
    delegation: {
      requested: s.ownerGrant,
      state: delegationState,
      perOperationUacRequired: !delegated && mutation,
    },
    execution: {
      status, denialSource, code,
      effectVerified: false,
      automaticallyRetryable: false,
    },
  };
}
