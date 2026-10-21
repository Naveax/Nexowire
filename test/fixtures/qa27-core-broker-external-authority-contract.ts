/**
 * #617 worker #27 independent SOURCE-ONLY cross-branch acceptance contract.
 * Reviewed against #700 exact 637ff3a6... and #702 exact 576eab89....
 *
 * Neither implementation is merged into #684. Do NOT treat this fixture as
 * running #700/#702, verifying Windows Authenticode, or contacting external CAS.
 * The strongest state is CONTRACT_CANDIDATE, not permission to execute.
 */
export type ApprovalProvenance =
  | 'local-os-elevated-launch-attestation'
  | 'remote-assistance-session-only'
  | 'consent.exe-count'
  | 'secure-desktop-unavailable'
  | 'self-reported-helper';
export interface EnrollmentEvidence {
  readonly origin: ApprovalProvenance;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly approvalRequestId: string;
  readonly approvalSessionId: string;
  readonly imageSha256: string;
  readonly publisher: string;
  readonly independentOsResultVerified: boolean;
  readonly osEffectiveHighTokenVerified: boolean;
  readonly osInstallerCompleted: boolean;
  readonly ownerWasPhysicallyPresentAtEnrollment: boolean;
  readonly localOsHumanApprovalRecorded: boolean;
}
export interface ProtectedBrokerEvidence {
  readonly signedPinnedPublisher: boolean;
  readonly exeAndAncestorsAclVerified: boolean;
  readonly everyImportAndUpdaterAncestorAclVerified: boolean;
  readonly independentImportEnumeration: boolean;
  readonly signedReleaseAndRollbackManifest: boolean;
  readonly importedPublishersAndHashesVerified: boolean;
  readonly processPidCreationFiletimeMatches: boolean;
  readonly volumeSerialAndFileIdMatches: boolean;
  readonly runningImageHandleHashMatches: boolean;
  readonly noLowPrivProcessDupHandle: boolean;
  readonly effectiveHighTokenAndEnabledAdmins: boolean;
  readonly physicalBrokerDeploymentAttested: boolean;
}
export interface CurrentOwnerAuthority {
  readonly authenticatedOwnerId: string;
  readonly authenticatedDeviceId: string;
  readonly authenticatedSessionId: string;
  readonly coreEnabled: boolean;
  readonly ownerPhysicallyPresentNow: boolean;
  readonly ownerEpoch: number;
  readonly installedOwnerEpoch: number;
  readonly revoked: boolean;
  readonly revokeAndDrainPending: boolean;
  readonly capabilityPreapproved: boolean;
  readonly brokerVersionMatch: boolean;
  readonly requestId: string;
  readonly expectedFingerprint: string;
  readonly dispatchAlreadyObserved: boolean;
}
export interface RemoteDispatchEvidence {
  readonly onlineExternalCas: boolean;
  readonly issuerSignatureVerified: boolean;
  readonly claimSingleUse: boolean;
  readonly claimOwnerId: string;
  readonly claimDeviceId: string;
  readonly claimSessionId: string;
  readonly claimOwnerEpoch: number;
  readonly claimRequestId: string;
  readonly claimFingerprint: string;
  readonly claimedCapabilityPreapproved: boolean;
  readonly claimExpired: boolean;
  readonly remoteRevokeGenerationCurrent: boolean;
  readonly claimLostAck: boolean;
  readonly possibleNativeWriteStarted: boolean;
}

export type MatrixResult = 'BLOCKED' | 'UNKNOWN' | 'CONTRACT_CANDIDATE';
export type MatrixReason =
  | 'OS_ENROLLMENT_NOT_AUTHENTICATED'
  | 'ENROLLMENT_IDENTITY_MISMATCH'
  | 'ENROLLMENT_SIGNER_IMAGE_MISMATCH'
  | 'BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE'
  | 'BROKER_PROCESS_IDENTITY_UNVERIFIED'
  | 'BROKER_EFFECTIVE_HIGH_TOKEN_UNVERIFIED'
  | 'PHYSICAL_BROKER_NOT_ATTESTED'
  | 'OWNER_SESSION_OR_EPOCH_REVOKED'
  | 'CAPABILITY_OR_BROKER_VERSION_DENIED'
  | 'EXTERNAL_AUTHORITY_UNAVAILABLE'
  | 'EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID'
  | 'DISPATCH_ALREADY_POSSIBLE_UNKNOWN'
  | 'SOURCE_CONTRACT_ONLY';
export interface CrossBranchOutcome {
  readonly result: MatrixResult;
  readonly reason: MatrixReason;
  /** ALWAYS false. Fixtures are NOT a real OS/CAS permission or effect. */
  readonly realUacApprovalProven: false;
  readonly canExecutePrivilegedCommand: false;
  readonly submittedToBroker: false;
  readonly noPerCommandUacFallback: true;
  readonly safeToRetryUnknown: false;
}
export interface CrossBranchCase {
  readonly enrollment: EnrollmentEvidence;
  readonly broker: ProtectedBrokerEvidence;
  readonly authority: CurrentOwnerAuthority;
  readonly remote: RemoteDispatchEvidence;
}

/**
 * Conservative acceptance oracle for expected #700 + #702 composition.
 * Caller-owned booleans are intentionally NOT a trusted provider.
 */
export function classifySourceOnlyCrossBranchCase(c: CrossBranchCase): CrossBranchOutcome {
  const outcome=(result:MatrixResult,reason:MatrixReason):CrossBranchOutcome=>({
    result,reason,realUacApprovalProven:false,
    canExecutePrivilegedCommand:false,submittedToBroker:false,
    noPerCommandUacFallback:true,safeToRetryUnknown:false,
  });
  const {enrollment:e,broker:b,authority:a,remote:r}=c;
  // A started native effect or lost ACK must never be reclassified as
  // a clean no-write denial. Reconcile independently without replay.
  if (r.possibleNativeWriteStarted || r.claimLostAck || a.dispatchAlreadyObserved)
    return outcome('UNKNOWN','DISPATCH_ALREADY_POSSIBLE_UNKNOWN');

  // Owner can be absent *later* after a genuine one-time enrollment. Absence
  // during enrollment is not interchangeable with authenticated local approval.
  if (e.origin!=='local-os-elevated-launch-attestation' ||
    !e.independentOsResultVerified || !e.osEffectiveHighTokenVerified ||
    !e.osInstallerCompleted || !e.localOsHumanApprovalRecorded)
    return outcome('BLOCKED','OS_ENROLLMENT_NOT_AUTHENTICATED');
  if (!e.ownerId || !e.deviceId || !e.approvalRequestId || !e.approvalSessionId ||
    e.ownerId!==a.authenticatedOwnerId || e.deviceId!==a.authenticatedDeviceId)
    return outcome('BLOCKED','ENROLLMENT_IDENTITY_MISMATCH');
  if (!e.publisher || !/^[a-f0-9]{64}$/.test(e.imageSha256))
    return outcome('BLOCKED','ENROLLMENT_SIGNER_IMAGE_MISMATCH');
  if (!b.signedPinnedPublisher || !b.exeAndAncestorsAclVerified ||
    !b.everyImportAndUpdaterAncestorAclVerified ||
    !b.independentImportEnumeration || !b.signedReleaseAndRollbackManifest ||
    !b.importedPublishersAndHashesVerified)
    return outcome('BLOCKED','BROKER_EXE_IMPORT_UPDATER_TRUST_INCOMPLETE');
  if (!b.processPidCreationFiletimeMatches ||
    !b.volumeSerialAndFileIdMatches || !b.runningImageHandleHashMatches ||
    !b.noLowPrivProcessDupHandle)
    return outcome('BLOCKED','BROKER_PROCESS_IDENTITY_UNVERIFIED');
  if (!b.effectiveHighTokenAndEnabledAdmins)
    return outcome('BLOCKED','BROKER_EFFECTIVE_HIGH_TOKEN_UNVERIFIED');
  if (!b.physicalBrokerDeploymentAttested)
    return outcome('BLOCKED','PHYSICAL_BROKER_NOT_ATTESTED');
  if (!a.authenticatedSessionId || !Number.isSafeInteger(a.ownerEpoch) ||
    a.ownerEpoch<=0 || a.installedOwnerEpoch!==a.ownerEpoch ||
    !a.coreEnabled || a.revoked || a.revokeAndDrainPending)
    return outcome('BLOCKED','OWNER_SESSION_OR_EPOCH_REVOKED');
  if (!a.capabilityPreapproved || !a.brokerVersionMatch ||
    !a.requestId || !/^[a-f0-9]{64}$/.test(a.expectedFingerprint))
    return outcome('BLOCKED','CAPABILITY_OR_BROKER_VERSION_DENIED');
  if (!r.onlineExternalCas) return outcome('UNKNOWN','EXTERNAL_AUTHORITY_UNAVAILABLE');
  if (!r.issuerSignatureVerified || !r.claimSingleUse ||
    r.claimOwnerId!==a.authenticatedOwnerId ||
    r.claimDeviceId!==a.authenticatedDeviceId ||
    r.claimSessionId!==a.authenticatedSessionId ||
    r.claimOwnerEpoch!==a.ownerEpoch ||
    r.claimRequestId!==a.requestId ||
    r.claimFingerprint!==a.expectedFingerprint ||
    !r.claimedCapabilityPreapproved || r.claimExpired ||
    !r.remoteRevokeGenerationCurrent)
    return outcome('BLOCKED','EXTERNAL_CLAIM_SCOPE_OR_SIGNATURE_INVALID');

  // This branch has no actual OS/remote verifier and never sends dispatch.
  return outcome('CONTRACT_CANDIDATE','SOURCE_CONTRACT_ONLY');
}

export const syntheticCrossBranchCase: CrossBranchCase={
  enrollment:{
    origin:'local-os-elevated-launch-attestation',ownerId:'owner27',deviceId:'device27',
    approvalRequestId:'local-os-request27',approvalSessionId:'local-os-session27',
    publisher:'fixture-signed-publisher',imageSha256:'b'.repeat(64),
    independentOsResultVerified:true,osEffectiveHighTokenVerified:true,
    osInstallerCompleted:true,ownerWasPhysicallyPresentAtEnrollment:true,
    localOsHumanApprovalRecorded:true,
  },
  broker:{
    signedPinnedPublisher:true,exeAndAncestorsAclVerified:true,
    everyImportAndUpdaterAncestorAclVerified:true,independentImportEnumeration:true,
    signedReleaseAndRollbackManifest:true,importedPublishersAndHashesVerified:true,
    processPidCreationFiletimeMatches:true,volumeSerialAndFileIdMatches:true,
    runningImageHandleHashMatches:true,noLowPrivProcessDupHandle:true,
    effectiveHighTokenAndEnabledAdmins:true,physicalBrokerDeploymentAttested:true,
  },
  authority:{
    authenticatedOwnerId:'owner27',authenticatedDeviceId:'device27',
    authenticatedSessionId:'session-after-enrollment27',coreEnabled:true,
    ownerPhysicallyPresentNow:false,ownerEpoch:7,installedOwnerEpoch:7,
    revoked:false,revokeAndDrainPending:false,capabilityPreapproved:true,
    brokerVersionMatch:true,requestId:'req27',expectedFingerprint:'c'.repeat(64),
    dispatchAlreadyObserved:false,
  },
  remote:{
    onlineExternalCas:true,issuerSignatureVerified:true,claimSingleUse:true,
    claimOwnerId:'owner27',claimDeviceId:'device27',
    claimSessionId:'session-after-enrollment27',claimOwnerEpoch:7,
    claimRequestId:'req27',claimFingerprint:'c'.repeat(64),
    claimedCapabilityPreapproved:true,claimExpired:false,
    remoteRevokeGenerationCurrent:true,claimLostAck:false,
    possibleNativeWriteStarted:false,
  },
};
