/**
 * Source-only CORE/ROOT physical evidence formatter, NOT an authorizer.
 * Inputs are untrusted observational summaries. In particular a boolean in
 * JSON never attests to Windows token identity, Authenticode, or owner consent.
 */
export type CoreRequestedMode = "SAFE" | "FULL" | "ROOT" | "CORE";
export type CoreObservationOrigin = "live_readonly" | "synthetic_fixture" | "unknown";
export type CoreIntegrity = "low" | "medium" | "high" | "system" | "unknown";
export type CoreTriState = "verified" | "unverified" | "denied";
export type CoreVMState = "running" | "off" | "unknown";

export interface CorePhysicalFacts {
  readonly requestedMode: CoreRequestedMode;
  readonly claimedOrigin: CoreObservationOrigin;
  readonly agent: {
    readonly version: string | null;
    readonly integrity: CoreIntegrity;
    readonly adminRoleInProcess: boolean | null;
    readonly administratorsDenyOnly: boolean | null;
  };
  /** Control-plane intent is never an effective Windows access grant. */
  readonly ownerDelegation: {
    readonly deviceOwnerBound: CoreTriState;
    readonly rootLeaseUnexpired: boolean | null;
    readonly rootSessionBound: CoreTriState;
    readonly coreEnrollmentActive: CoreTriState;
    readonly revocationChecked: CoreTriState;
  };
  readonly broker: {
    readonly port43112ListenerSeen: boolean | null;
    readonly authenticatedHealth: CoreTriState;
    readonly signedBinary: CoreTriState;
    readonly versionMatch: CoreTriState;
    readonly elevatedToken: CoreTriState;
    readonly protectedParentAndImports: CoreTriState;
    /** True means broad write ACE found; false means none observed, not proof of effective ACL. */
    readonly broadWriteAceObserved: boolean | null;
  };
  readonly vm: {
    readonly observedState: CoreVMState;
    readonly independentlyAuthenticatedReadback: CoreTriState;
  };
}

export type CorePhysicalReason =
  | "OWNER_DELEGATION_UNVERIFIED"
  | "ROOT_LEASE_OR_SESSION_UNVERIFIED"
  | "CORE_ENROLLMENT_OR_REVOCATION_UNVERIFIED"
  | "DIRECT_AGENT_MEDIUM_OR_NOT_ADMIN"
  | "AGENT_TOKEN_ELEVATION_UNVERIFIED"
  | "BROKER_LISTENER_NOT_AUTHENTICATION"
  | "BROKER_AUTHENTICATED_HEALTH_UNVERIFIED"
  | "BROKER_SIGNATURE_UNVERIFIED"
  | "BROKER_VERSION_UNVERIFIED"
  | "BROKER_ELEVATED_TOKEN_UNVERIFIED"
  | "BROKER_ACL_UNVERIFIED"
  | "UNTRUSTED_PARENT_OR_IMPORT_ACL"
  | "VM_STATE_UNKNOWN_OR_UNATTESTED"
  | "OBSERVATION_PROVENANCE_SELF_ASSERTED";

export interface CorePhysicalReport {
  readonly schemaVersion: 1;
  readonly source: "untrusted-readonly-observations";
  readonly claimedOrigin: CoreObservationOrigin;
  readonly originCryptographicallyAttested: false;
  readonly requestedMode: CoreRequestedMode;
  /** Never let the diagnostic helper grant local Windows authority. */
  readonly effectiveElevation: "not_proven";
  readonly productionReadiness: "blocked" | "unverified";
  readonly authorizationGranted: false;
  readonly mutationPerformed: false;
  readonly vmEffectVerified: false;
  readonly brokerListenerObserved: boolean | null;
  readonly observedAgentIntegrity: CoreIntegrity;
  readonly observedAgentAdminRole: boolean | null;
  readonly reasons: readonly CorePhysicalReason[];
}

export function explainCorePhysicalReadiness(facts: CorePhysicalFacts): CorePhysicalReport {
  const reasons: CorePhysicalReason[] = [];
  if (facts.ownerDelegation.deviceOwnerBound !== "verified") {
    reasons.push("OWNER_DELEGATION_UNVERIFIED");
  }
  if (facts.requestedMode === "ROOT" &&
      (facts.ownerDelegation.rootLeaseUnexpired !== true ||
       facts.ownerDelegation.rootSessionBound !== "verified")) {
    reasons.push("ROOT_LEASE_OR_SESSION_UNVERIFIED");
  }
  if (facts.requestedMode === "CORE" &&
      (facts.ownerDelegation.coreEnrollmentActive !== "verified" ||
       facts.ownerDelegation.revocationChecked !== "verified")) {
    reasons.push("CORE_ENROLLMENT_OR_REVOCATION_UNVERIFIED");
  }
  if (facts.agent.integrity === "medium" || facts.agent.integrity === "low" ||
      facts.agent.adminRoleInProcess === false || facts.agent.administratorsDenyOnly === true) {
    reasons.push("DIRECT_AGENT_MEDIUM_OR_NOT_ADMIN");
  } else if (facts.agent.integrity !== "high" && facts.agent.integrity !== "system" ||
             facts.agent.adminRoleInProcess !== true) {
    reasons.push("AGENT_TOKEN_ELEVATION_UNVERIFIED");
  }
  if (facts.broker.port43112ListenerSeen === true) {
    reasons.push("BROKER_LISTENER_NOT_AUTHENTICATION");
  }
  if (facts.broker.authenticatedHealth !== "verified") {
    reasons.push("BROKER_AUTHENTICATED_HEALTH_UNVERIFIED");
  }
  if (facts.broker.signedBinary !== "verified") {
    reasons.push("BROKER_SIGNATURE_UNVERIFIED");
  }
  if (facts.broker.versionMatch !== "verified") {
    reasons.push("BROKER_VERSION_UNVERIFIED");
  }
  if (facts.broker.elevatedToken !== "verified") {
    reasons.push("BROKER_ELEVATED_TOKEN_UNVERIFIED");
  }
  if (facts.broker.protectedParentAndImports !== "verified") {
    reasons.push("BROKER_ACL_UNVERIFIED");
  }
  if (facts.broker.broadWriteAceObserved === true) {
    reasons.push("UNTRUSTED_PARENT_OR_IMPORT_ACL");
  }
  if (facts.vm.observedState === "unknown" ||
      facts.vm.independentlyAuthenticatedReadback !== "verified") {
    reasons.push("VM_STATE_UNKNOWN_OR_UNATTESTED");
  }
  // The formatter has no signing keys or trustworthy collector identity.
  // All "verified" fields are claimed by the caller, not verified by us.
  reasons.push("OBSERVATION_PROVENANCE_SELF_ASSERTED");
  const blocked = reasons.some((reason) =>
    reason === "DIRECT_AGENT_MEDIUM_OR_NOT_ADMIN" ||
    reason === "OWNER_DELEGATION_UNVERIFIED" ||
    reason === "ROOT_LEASE_OR_SESSION_UNVERIFIED" ||
    reason === "CORE_ENROLLMENT_OR_REVOCATION_UNVERIFIED" ||
    reason === "UNTRUSTED_PARENT_OR_IMPORT_ACL" ||
    reason === "VM_STATE_UNKNOWN_OR_UNATTESTED");
  return {
    schemaVersion: 1,
    source: "untrusted-readonly-observations",
    claimedOrigin: facts.claimedOrigin,
    originCryptographicallyAttested: false,
    requestedMode: facts.requestedMode,
    effectiveElevation: "not_proven",
    productionReadiness: blocked ? "blocked" : "unverified",
    authorizationGranted: false,
    mutationPerformed: false,
    vmEffectVerified: false,
    brokerListenerObserved: facts.broker.port43112ListenerSeen,
    observedAgentIntegrity: facts.agent.integrity,
    observedAgentAdminRole: facts.agent.adminRoleInProcess,
    reasons,
  };
}
