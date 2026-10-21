/**
 * #617/#645 child, worker #27. SOURCE-ONLY acceptance oracle.
 *
 * This is test code, not a production authorization provider. It cannot query
 * Windows, verify a signature, click UAC, change desktops, or elevate anything.
 * Its "candidate" result is NOT evidence of a real approved elevation.
 */
export type RemoteSession = 'windows-remote-assistance' | 'rdp' | 'browser' | 'local-console' | 'headless';
export type PromptKind = 'standard-user-credentials' | 'administrator-consent';
export type PromptObservation = 'visible' | 'absent' | 'secure-desktop-forbidden' | 'unknown';
export type EvidenceOrigin =
  | 'trusted-native-enrollment-record'
  | 'consent-exe-count'
  | 'screenshot'
  | 'agent-telemetry'
  | 'remote-helper-claim';

export interface RemotePromptFixture {
  readonly session: RemoteSession;
  readonly kind: PromptKind;
  readonly ownerAuthorizedRemoteHelp: boolean;
  readonly authenticatedRemoteAdmin: boolean;
  readonly uiAccessSigned: boolean;
  readonly uiAccessProtectedLocation: boolean;
  readonly uiAccessPolicyEnabled: boolean;
  readonly physicalConsoleGrant: boolean;
  readonly promptObservation: PromptObservation;
  readonly consentCount: number | null;
}

export interface EnrollmentProvenanceFixture {
  readonly origin: EvidenceOrigin;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly enrollmentSessionId: string;
  readonly enrollmentRequestId: string;
  readonly enrollmentNonce: string;
  readonly publisherId: string;
  readonly executableSha256: string;
  readonly signedImageAndImportsTrusted: boolean;
  readonly parentAndUpdaterAclProtected: boolean;
  readonly effectiveHighTokenAttested: boolean;
  readonly installerCompleted: boolean;
  readonly duplicateReceipt: boolean;
  readonly receivedAtMs: number;
}

export interface CommandDelegationFixture {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly ownerGrantEpoch: number;
  readonly installedGrantEpoch: number;
  readonly coreActive: boolean;
  readonly revoked: boolean;
  readonly commandPreapproved: boolean;
  readonly brokerVersionMatches: boolean;
  readonly expectedPublisherId: string;
  readonly expectedExecutableSha256: string;
  readonly nowMs: number;
}

/** OS eligibility is about a possible *human* prompt, never approval. */
export function assessHumanPromptPath(f: RemotePromptFixture): {
  readonly humanPromptRoute: 'conditional-remote-assistance' | 'local-console' | 'unavailable';
  readonly uacApproved: false;
  readonly needsActualOsConsent: true;
  readonly reason: string;
} {
  if (f.session === 'local-console') {
    return {
      humanPromptRoute: f.physicalConsoleGrant ? 'local-console' : 'unavailable',
      uacApproved: false, needsActualOsConsent: true,
      reason: f.physicalConsoleGrant ? 'LOCAL_CONSOLE_HUMAN_DECISION_PENDING' : 'NO_PHYSICAL_CONSOLE_GRANT',
    };
  }
  // The Microsoft UIAccess policy only addresses elevation prompts for
  // standard users, NOT administrator consent prompts.
  if (
    f.session !== 'windows-remote-assistance' ||
    f.kind !== 'standard-user-credentials' ||
    !f.ownerAuthorizedRemoteHelp ||
    !f.authenticatedRemoteAdmin ||
    !f.uiAccessSigned ||
    !f.uiAccessProtectedLocation ||
    !f.uiAccessPolicyEnabled
  ) {
    return {humanPromptRoute: 'unavailable', uacApproved: false,
      needsActualOsConsent: true, reason: 'REMOTE_ASSISTANCE_PRECONDITIONS_NOT_PROVEN'};
  }
  // Missing console grant is not itself a rejection of an explicitly
  // authorized and OS-supported remote-assistance session. It is also NOT
  // evidence that a standard-user prompt was answered.
  return {humanPromptRoute: 'conditional-remote-assistance', uacApproved: false,
    needsActualOsConsent: true, reason: 'HUMAN_REMOTE_ADMIN_CREDENTIALS_REQUIRED'};
}

/** A synthetic independent verifier is injected by the QA test.
 * NEVER use caller-provided booleans as a real Windows trust witness.
 */
export type IndependentWindowsEvidenceVerifier = (
  evidence: Readonly<EnrollmentProvenanceFixture>
) => boolean;

export function assessBrokerDelegationCandidate(
  enrollment: EnrollmentProvenanceFixture | null,
  command: CommandDelegationFixture,
  independentVerifier: IndependentWindowsEvidenceVerifier,
): {
  readonly state: 'UNVERIFIED' | 'CONTRACT_CANDIDATE';
  readonly reason: string;
  readonly needsPerCommandUac: false;
  readonly uacApprovedByThisCheck: false;
  readonly actualCommandExecuted: false;
} {
  const rejected = (reason: string) => ({
    state: 'UNVERIFIED' as const, reason, needsPerCommandUac: false as const,
    uacApprovedByThisCheck: false as const, actualCommandExecuted: false as const,
  });
  if (!enrollment) return rejected('NO_ENROLLMENT_RECEIPT');
  if (enrollment.origin !== 'trusted-native-enrollment-record') return rejected('UNTRUSTED_ORIGIN');
  if (
    !enrollment.ownerId || !enrollment.deviceId || !enrollment.enrollmentSessionId ||
    !enrollment.enrollmentRequestId || !enrollment.enrollmentNonce ||
    enrollment.ownerId !== command.ownerId ||
    enrollment.deviceId !== command.deviceId
  ) return rejected('PROVENANCE_IDENTITY_MISMATCH');
  if (
    enrollment.publisherId !== command.expectedPublisherId ||
    !/^[a-f0-9]{64}$/.test(enrollment.executableSha256) ||
    enrollment.executableSha256 !== command.expectedExecutableSha256 ||
    !enrollment.signedImageAndImportsTrusted ||
    !enrollment.parentAndUpdaterAclProtected
  ) return rejected('SIGNED_PROTECTED_IMAGE_UNPROVEN');
  if (!enrollment.installerCompleted || !enrollment.effectiveHighTokenAttested)
    return rejected('INSTALL_OR_HIGH_TOKEN_UNPROVEN');
  if (enrollment.duplicateReceipt) return rejected('DUPLICATE_ENROLLMENT_RECEIPT');
  if (!Number.isFinite(enrollment.receivedAtMs) ||
      enrollment.receivedAtMs > command.nowMs ||
      command.nowMs - enrollment.receivedAtMs > 30 * 24 * 60 * 60 * 1000)
    return rejected('ENROLLMENT_PROVENANCE_STALE_OR_INVALID');
  if (!independentVerifier(enrollment)) return rejected('INDEPENDENT_OS_VERIFICATION_REQUIRED');
  if (!command.ownerId || !command.deviceId || !command.sessionId ||
      !Number.isSafeInteger(command.ownerGrantEpoch) ||
      command.ownerGrantEpoch < 1 ||
      command.ownerGrantEpoch !== command.installedGrantEpoch ||
      !command.coreActive || command.revoked || !command.commandPreapproved)
    return rejected('CURRENT_OWNER_GRANT_DENIED');
  if (!command.brokerVersionMatches) return rejected('BROKER_VERSION_MISMATCH');
  // The *candidate* models the desired post-enrollment design, not a
  // deployed grant. A real executor must independently enforce ALL gates.
  return {
    state: 'CONTRACT_CANDIDATE', reason: 'PHYSICAL_EVIDENCE_STILL_REQUIRED',
    needsPerCommandUac: false, uacApprovedByThisCheck: false,
    actualCommandExecuted: false,
  };
}
