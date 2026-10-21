/**
 * #10 Independent native-readonly provider availability diagnostic.
 * This is NOT a native Windows provider or elevation authorizer. It NEVER
 * claims that a running Broker is installed/HIGH from caller-supplied JSON.
 */
import {
  assessReadonlyBrokerEpoch,
  type BrokerExpectation,
  type ReadEvidence,
  type ReadonlyEvidenceProviders,
  type ReadonlyDiagnostic,
  type RunningImage,
  type HighToken,
  type ImageTree,
  type OwnerEpoch,
  type ExternalEpoch,
  type StatusOnly,
} from './core-broker-filetime-cas-evidence.js';

type SourceState = 'unavailable' | 'unknown' | 'reported';
type NamedProbe =
  | 'signedImage' | 'highToken' | 'protectedTree'
  | 'ownerGrant' | 'externalCas' | 'status';
const PROBES: readonly NamedProbe[] = [
  'signedImage','highToken','protectedTree',
  'ownerGrant','externalCas','status',
];
export interface NativeAvailabilityDiagnostic {
  readonly version: 1;
  readonly origin: 'injected_readonly_provider_untrusted';
  /** Missing provider and thrown/malformed read are always UNAVAILABLE. */
  readonly provider: 'UNAVAILABLE' | 'PARTIAL' | 'REPORTED_UNATTESTED';
  readonly probeState: Readonly<Record<NamedProbe, SourceState>>;
  /** HIGH is merely reported, not verified by signed OS-native attestation. */
  readonly highTokenObservation: 'HIGH_CLAIM_UNATTESTED' | 'UNAVAILABLE_OR_NOT_HIGH';
  readonly installedHighBroker: 'NOT_PROVEN';
  readonly effectiveCore: false;
  readonly authorizationGranted: false;
  readonly mutationPerformed: false;
  readonly independentWitnessDeployed: 'NOT_PROVEN';
  readonly diagnosis: ReadonlyDiagnostic;
}
async function guarded<T>(
  reader: (() => Promise<ReadEvidence<T>>) | undefined,
): Promise<ReadEvidence<T>> {
  if (typeof reader !== 'function') return { state: 'unavailable' };
  try {
    const value: unknown = await reader();
    if (typeof value !== 'object' || value === null || !('state' in value) ||
        !['reported','unknown','unavailable'].includes(String(value.state))) {
      return { state: 'unavailable' };
    }
    return value as ReadEvidence<T>;
  } catch {
    // Exclude native error strings: they may disclose secrets or file paths.
    return { state: 'unavailable' };
  }
}
/**
 * Snapshot each native/provider method at most once. This reports its
 * availability, but never authenticates a signature, process handle or
 * external rollback-resistant authority. An actual Windows native witness
 * must be implemented/reviewed separately by the #03/#04/#01 owners.
 */
export async function inspectReadonlyNativeAvailability(
  provider: ReadonlyEvidenceProviders | undefined,
  expected: BrokerExpectation,
): Promise<NativeAvailabilityDiagnostic> {
  const [image, token, tree, owner, cas, status] = await Promise.all([
    guarded<RunningImage>(provider?.signedImage),
    guarded<HighToken>(provider?.highToken),
    guarded<ImageTree>(provider?.protectedTree),
    guarded<OwnerEpoch>(provider?.ownerGrant),
    guarded<ExternalEpoch>(provider?.externalCas),
    guarded<StatusOnly>(provider?.status),
  ]);
  const states: Record<NamedProbe, SourceState> = {
    signedImage: image.state,
    highToken: token.state,
    protectedTree: tree.state,
    ownerGrant: owner.state,
    externalCas: cas.state,
    status: status.state,
  };
  const totalReported = PROBES.filter(name => states[name] === 'reported').length;
  const diagnosis = await assessReadonlyBrokerEpoch({
    signedImage: async () => image,
    highToken: async () => token,
    protectedTree: async () => tree,
    ownerGrant: async () => owner,
    externalCas: async () => cas,
    status: async () => status,
  }, expected);
  // Only report the existence of a HIGH token *claim*. This is not an
  // installed/high process attestation, even with an Authenticode claim.
  const highClaim = token.state === 'reported' &&
    (token.value?.integrity === 'high' || token.value?.integrity === 'system') &&
    token.value?.administratorsEnabled === true &&
    token.value?.sameProcessTokenVerified === true &&
    token.value?.pid === expected.identity.pid &&
    token.value?.creationFiletime === expected.identity.creationFiletime;
  return {
    version: 1,
    origin: 'injected_readonly_provider_untrusted',
    provider: totalReported === 0 ? 'UNAVAILABLE' :
      totalReported === PROBES.length ? 'REPORTED_UNATTESTED' : 'PARTIAL',
    probeState: states,
    highTokenObservation: highClaim ?
      'HIGH_CLAIM_UNATTESTED' : 'UNAVAILABLE_OR_NOT_HIGH',
    installedHighBroker: 'NOT_PROVEN',
    effectiveCore: false,
    authorizationGranted: false,
    mutationPerformed: false,
    independentWitnessDeployed: 'NOT_PROVEN',
    diagnosis,
  };
}
