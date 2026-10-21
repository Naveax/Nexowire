/**
 * Worker #27 / #617 / child of #656. Pure SOURCE-ONLY QA contract.
 *
 * This deliberately does NOT claim Windows exposes a signed "UAC approved"
 * certificate. An independent trusted Windows-side observer would need to
 * attest the actual *resulting elevated launch*, image and effective token.
 * A verifier injected by tests cannot stand in for a real OS/native provider.
 */
export type InteractionSurface =
  | 'windows-remote-assistance'
  | 'local-console'
  | 'rdp'
  | 'browser'
  | 'headless';
export type PromptClass = 'standard-user-credential' | 'admin-consent';
export type ScreenObservation = 'consent.exe-visible' | 'no-consent-process' | 'secure-desktop-forbidden' | 'unknown';

export interface AssistedApprovalContext {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly sessionId: string;
  readonly surface: InteractionSurface;
  readonly promptClass: PromptClass;
  readonly ownerApprovedAssistance: boolean;
  readonly remoteAdminAuthenticated: boolean;
  readonly uiAccessSignatureVerified: boolean;
  readonly uiAccessInstallProtected: boolean;
  readonly uiAccessPolicyEnabled: boolean;
  readonly physicalOwnerPresent: boolean;
  readonly physicalConsoleGrant: boolean;
  readonly screenObservation: ScreenObservation;
  readonly expectedPublisher: string;
  readonly expectedImageSha256: string;
  readonly nowMs: number;
}

export interface NativeLaunchWitness {
  readonly origin: 'independent-native-windows-provider' | 'agent-telemetry' |
    'remote-helper' | 'consent.exe' | 'screenshot';
  readonly ownerId: string;
  readonly deviceId: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly sessionId: string;
  readonly publisher: string;
  readonly imageSha256: string;
  readonly imageAndImportChainProtected: boolean;
  readonly elevatedTokenObserved: boolean;
  readonly result: 'elevated-launch-observed' | 'denied' | 'unknown';
  readonly observedAtMs: number;
}

/**
 * Simulation only: a genuine trusted OS/native provider is unavailable here.
 * Tests using () => true prove required plumbing/logic, not real signing.
 */
export type SyntheticIndependentVerifier = (w: Readonly<NativeLaunchWitness>) => boolean;

export type ApprovalContractReason =
  | 'HUMAN_INTERACTION_NOT_ESTABLISHED'
  | 'NATIVE_EVIDENCE_MISSING'
  | 'UNTRUSTED_EVIDENCE_ORIGIN'
  | 'WITNESS_IDENTITY_OR_NONCE_MISMATCH'
  | 'WITNESS_IMAGE_PROVENANCE_FAILED'
  | 'WITNESS_TIME_INVALID'
  | 'WITNESS_NATIVE_VERIFICATION_FAILED'
  | 'WITNESS_REPORTED_DENIED'
  | 'WITNESS_RESULT_UNKNOWN'
  | 'WITNESS_ELEVATED_TOKEN_MISSING'
  | 'NATIVE_OUTCOME_CONTRACT_CANDIDATE';

export function assessNativeApprovalOutcome(
  context: AssistedApprovalContext,
  witness: NativeLaunchWitness | null,
  verify: SyntheticIndependentVerifier,
): {
  readonly assistedRoute: 'eligible-remote-credentials' | 'eligible-local-human' | 'unavailable';
  readonly result: 'UNVERIFIED' | 'DENIED' | 'UNKNOWN' | 'CONTRACT_CANDIDATE';
  readonly reason: ApprovalContractReason;
  readonly realWindowsUacApproved: false;
  readonly actualElevatedExecutionProven: false;
  readonly issuedCommand: false;
} {
  const remoteEligible =
    context.surface === 'windows-remote-assistance' &&
    context.promptClass === 'standard-user-credential' &&
    context.ownerApprovedAssistance &&
    context.remoteAdminAuthenticated &&
    context.uiAccessSignatureVerified &&
    context.uiAccessInstallProtected &&
    context.uiAccessPolicyEnabled;
  const localEligible = context.surface === 'local-console' &&
    context.physicalOwnerPresent && context.physicalConsoleGrant;
  const route = remoteEligible ? 'eligible-remote-credentials' as const
    : localEligible ? 'eligible-local-human' as const : 'unavailable' as const;
  const result = (
    state: 'UNVERIFIED' | 'DENIED' | 'UNKNOWN' | 'CONTRACT_CANDIDATE',
    reason: ApprovalContractReason,
  ) => ({
    assistedRoute: route, result: state, reason,
    realWindowsUacApproved: false as const,
    actualElevatedExecutionProven: false as const,
    issuedCommand: false as const,
  });
  if (route === 'unavailable') return result('UNVERIFIED', 'HUMAN_INTERACTION_NOT_ESTABLISHED');
  if (!witness) return result('UNVERIFIED', 'NATIVE_EVIDENCE_MISSING');
  if (witness.origin !== 'independent-native-windows-provider')
    return result('UNVERIFIED', 'UNTRUSTED_EVIDENCE_ORIGIN');
  if (
    !context.ownerId || !context.deviceId || !context.requestId ||
    !context.nonce || !context.sessionId ||
    witness.ownerId !== context.ownerId ||
    witness.deviceId !== context.deviceId ||
    witness.requestId !== context.requestId ||
    witness.nonce !== context.nonce ||
    witness.sessionId !== context.sessionId
  ) return result('UNVERIFIED', 'WITNESS_IDENTITY_OR_NONCE_MISMATCH');
  if (
    !context.expectedPublisher ||
    !/^[a-f0-9]{64}$/.test(context.expectedImageSha256) ||
    witness.publisher !== context.expectedPublisher ||
    witness.imageSha256 !== context.expectedImageSha256 ||
    !witness.imageAndImportChainProtected
  ) return result('UNVERIFIED', 'WITNESS_IMAGE_PROVENANCE_FAILED');
  if (!Number.isFinite(witness.observedAtMs) ||
    witness.observedAtMs > context.nowMs ||
    context.nowMs - witness.observedAtMs > 30_000)
    return result('UNVERIFIED', 'WITNESS_TIME_INVALID');
  if (!verify(witness)) return result('UNVERIFIED', 'WITNESS_NATIVE_VERIFICATION_FAILED');
  if (witness.result === 'denied') return result('DENIED', 'WITNESS_REPORTED_DENIED');
  if (witness.result !== 'elevated-launch-observed')
    return result('UNKNOWN', 'WITNESS_RESULT_UNKNOWN');
  if (!witness.elevatedTokenObserved)
    return result('UNVERIFIED', 'WITNESS_ELEVATED_TOKEN_MISSING');
  // Even this all-green synthetic example is NOT a Windows UAC authorization.
  return result('CONTRACT_CANDIDATE', 'NATIVE_OUTCOME_CONTRACT_CANDIDATE');
}

const MOCK_TIME = Date.parse('2026-10-21T17:05:00.000Z');
export const syntheticApprovalContext: AssistedApprovalContext = {
  ownerId: 'owner-os-witness-27', deviceId: 'device-os-witness-27',
  requestId: 'request-os-witness-27', nonce: 'nonce-os-witness-27',
  sessionId: 'assistance-os-witness-27',
  surface: 'windows-remote-assistance', promptClass: 'standard-user-credential',
  ownerApprovedAssistance: true, remoteAdminAuthenticated: true,
  uiAccessSignatureVerified: true, uiAccessInstallProtected: true,
  uiAccessPolicyEnabled: true, physicalOwnerPresent: false,
  physicalConsoleGrant: false, screenObservation: 'consent.exe-visible',
  expectedPublisher: 'synthetic-publisher-os-witness-27',
  expectedImageSha256: 'c'.repeat(64), nowMs: MOCK_TIME,
};
export const syntheticNativeWitness: NativeLaunchWitness = {
  origin: 'independent-native-windows-provider',
  ownerId: syntheticApprovalContext.ownerId,
  deviceId: syntheticApprovalContext.deviceId,
  requestId: syntheticApprovalContext.requestId,
  nonce: syntheticApprovalContext.nonce,
  sessionId: syntheticApprovalContext.sessionId,
  publisher: syntheticApprovalContext.expectedPublisher,
  imageSha256: syntheticApprovalContext.expectedImageSha256,
  imageAndImportChainProtected: true, elevatedTokenObserved: true,
  result: 'elevated-launch-observed', observedAtMs: MOCK_TIME - 500,
};
