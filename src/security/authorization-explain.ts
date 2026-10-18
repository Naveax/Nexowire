import { privilegeRequirement, type PrivilegeRequirement } from './privilege.js';

/**
 * A read-only explanation of owner policy versus OS authority.
 * Inputs from the control-plane database and Agent presence are NOT trusted
 * local Windows attestation. In particular, "broker" telemetry and a
 * successful preference save never prove a Broker token, task or ACL.
 */
export interface DeviceAuthorizationFacts {
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly requesterAccountId: string;
  readonly requesterRole: 'user' | 'admin' | 'service';
  readonly accessMode: 'safe' | 'full';
  readonly online: boolean;
  readonly privilegeMode: 'direct' | 'broker' | null;
  readonly adminBridgeReady: boolean | null;
  readonly rootLease: {
    readonly ownerAccountId: string;
    readonly expiresAt: string;
  } | null;
  readonly corePreference: {
    readonly ownerAccountId: string;
    readonly enabled: boolean;
    readonly updatedAt: string;
  } | null;
  readonly bridgePreference: {
    readonly ownerAccountId: string;
    readonly desiredMode: 'auto' | 'on' | 'off';
    readonly updatedAt: string;
  } | null;
  readonly now: Date;
}

export type AuthorizationExplainReason =
  | 'OWNER_IDENTITY_REQUIRED'
  | 'DEVICE_OWNER_MISMATCH'
  | 'ACCESS_MODE_SAFE'
  | 'DEVICE_OFFLINE'
  | 'ROOT_LEASE_EXPIRED_OR_REVOKED'
  | 'CORE_DISABLED_OR_REVOKED'
  | 'BROKER_DESIRED_OFF'
  | 'BROKER_AGENT_TELEMETRY_NOT_READY'
  | 'BROKER_LOCAL_ATTESTATION_REQUIRED'
  | 'WINDOWS_ADMIN_TOKEN_UNVERIFIED'
  | 'UAC_APPROVAL_UNVERIFIED'
  | 'PHYSICAL_CONSOLE_GRANT_UNVERIFIED'
  | 'UPSTREAM_PROVIDER_POLICY_NOT_EVALUATED';

export interface AuthorizationExplain {
  readonly version: 1;
  readonly deviceId: string;
  readonly generatedAt: string;
  readonly source: 'owner-control-plane-snapshot';
  readonly access: {
    readonly mode: 'safe' | 'full';
    readonly devicePresence: 'reported-online' | 'reported-offline';
  };
  readonly root: {
    readonly policyActive: boolean;
    readonly expiresAt: string | null;
    readonly duration: '15-minute-maximum-lease';
    readonly sessionBound: false;
  };
  readonly core: {
    readonly enabled: boolean;
    readonly state: 'OFF' | 'PAUSED_UNVERIFIED';
    readonly duration: 'indefinite-revocable';
    readonly updatedAt: string | null;
  };
  readonly adminBridge: {
    readonly requestedMode: 'auto' | 'on' | 'off';
    readonly preferenceApplied: false;
    readonly preferenceUpdatedAt: string | null;
    readonly agentReportedPrivilegeMode: 'direct' | 'broker' | null;
    readonly agentReportedReady: boolean | null;
    readonly deviceTaskState: 'unverified';
    readonly authenticatedBrokerHealth: 'unverified';
    readonly lastAppliedAt: null;
  };
  readonly windows: {
    readonly adminToken: 'unverified';
    readonly uacApproval: 'unverified';
    readonly physicalConsoleApproval: 'unverified';
  };
  readonly operation: {
    readonly capability: string | null;
    readonly privilegeRequirement: PrivilegeRequirement | 'not-evaluated';
    /** Never an execution permit or a substitute for authorization. */
    readonly elevatedExecutionProven: false;
    readonly providerAuthorizationProven: false;
    readonly decision: 'denied' | 'not-proven';
    readonly reasons: readonly AuthorizationExplainReason[];
    readonly safeNextAction: string;
  };
}

export function explainDeviceAuthorization(
  facts: DeviceAuthorizationFacts,
  capability: string | null = null,
  input: unknown = undefined,
): AuthorizationExplain {
  const now = facts.now.getTime();
  if (!Number.isFinite(now)) {
    throw new Error('AUTHORIZATION_EXPLAIN_INVALID_CLOCK');
  }
  const ownerValid = facts.requesterRole !== 'service' &&
    facts.requesterAccountId === facts.ownerAccountId;
  const leaseOwned = facts.rootLease?.ownerAccountId === facts.ownerAccountId;
  const expiry = leaseOwned ? Date.parse(facts.rootLease!.expiresAt) : Number.NaN;
  const rootActive = ownerValid && facts.accessMode === 'full' && facts.online &&
    Number.isFinite(expiry) && expiry > now;
  const coreOwned = facts.corePreference?.ownerAccountId === facts.ownerAccountId;
  const coreEnabled = Boolean(ownerValid && coreOwned &&
    facts.corePreference?.enabled && facts.accessMode === 'full');
  const bridgeOwned = facts.bridgePreference?.ownerAccountId === facts.ownerAccountId;
  const requestedMode = bridgeOwned ? facts.bridgePreference!.desiredMode : 'auto';
  const telemetryReady = facts.privilegeMode === 'broker' &&
    facts.adminBridgeReady === true;
  const reasons: AuthorizationExplainReason[] = [];
  if (facts.requesterRole === 'service') reasons.push('OWNER_IDENTITY_REQUIRED');
  if (facts.requesterAccountId !== facts.ownerAccountId) reasons.push('DEVICE_OWNER_MISMATCH');
  if (facts.accessMode === 'safe') reasons.push('ACCESS_MODE_SAFE');
  if (!facts.online) reasons.push('DEVICE_OFFLINE');
  if (!rootActive) reasons.push('ROOT_LEASE_EXPIRED_OR_REVOKED');
  if (!coreEnabled) reasons.push('CORE_DISABLED_OR_REVOKED');
  if (requestedMode === 'off') reasons.push('BROKER_DESIRED_OFF');
  if (!telemetryReady) reasons.push('BROKER_AGENT_TELEMETRY_NOT_READY');
  reasons.push(
    'BROKER_LOCAL_ATTESTATION_REQUIRED',
    'WINDOWS_ADMIN_TOKEN_UNVERIFIED',
    'UAC_APPROVAL_UNVERIFIED',
    'PHYSICAL_CONSOLE_GRANT_UNVERIFIED',
    'UPSTREAM_PROVIDER_POLICY_NOT_EVALUATED',
  );
  const denied = !ownerValid || facts.accessMode === 'safe' || !facts.online ||
    requestedMode === 'off';
  return {
    version: 1,
    deviceId: facts.deviceId,
    generatedAt: new Date(now).toISOString(),
    source: 'owner-control-plane-snapshot',
    access: {
      mode: facts.accessMode,
      devicePresence: facts.online ? 'reported-online' : 'reported-offline',
    },
    root: {
      policyActive: rootActive,
      expiresAt: leaseOwned && Number.isFinite(expiry) && expiry > now
        ? facts.rootLease!.expiresAt : null,
      duration: '15-minute-maximum-lease',
      // The current ControlPlaneIdentity has no session generation/ID.
      // Never claim automatic logout revocation without a persisted binding.
      sessionBound: false,
    },
    core: {
      enabled: coreEnabled,
      state: coreEnabled ? 'PAUSED_UNVERIFIED' : 'OFF',
      duration: 'indefinite-revocable',
      updatedAt: coreOwned ? facts.corePreference!.updatedAt : null,
    },
    adminBridge: {
      requestedMode,
      preferenceApplied: false,
      preferenceUpdatedAt: bridgeOwned ? facts.bridgePreference!.updatedAt : null,
      agentReportedPrivilegeMode: facts.privilegeMode,
      agentReportedReady: facts.adminBridgeReady,
      deviceTaskState: 'unverified',
      authenticatedBrokerHealth: 'unverified',
      lastAppliedAt: null,
    },
    windows: {
      adminToken: 'unverified',
      uacApproval: 'unverified',
      physicalConsoleApproval: 'unverified',
    },
    operation: {
      capability,
      privilegeRequirement: capability === null
        ? 'not-evaluated' : privilegeRequirement(capability, input),
      elevatedExecutionProven: false,
      providerAuthorizationProven: false,
      decision: denied ? 'denied' : 'not-proven',
      reasons,
      safeNextAction: requestedMode === 'off'
        ? 'An owner may request a new mode; confirm device-side Guardian availability before applying it.'
        : !facts.online
          ? 'Reconnect and reauthenticate the exact paired device, then collect fresh local Broker evidence.'
          : 'Verify paired owner/session and protected Guardian, trusted task ACL, authenticated Broker health and Windows/UAC approvals locally. Do not retry privileged mutations blindly.',
    },
  };
}
