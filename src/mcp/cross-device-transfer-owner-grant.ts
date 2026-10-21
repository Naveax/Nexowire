import type {
  AuthenticatedTransferRoute, TransferAuthorization, TransferBinding,
} from './cross-device-transfer-continuity.js';

/**
 * Connection-only grant fence. A caller MUST inject an owner-controlled
 * authenticated authority; never derive this from MCP input, UI preferences,
 * Agent telemetry, or a self-asserted CORE/ROOT toggle.
 *
 * Grant epochs are monotonic external facts and distinct from the WSS
 * connection epoch and #616's cross-Hub worker lease epoch.
 */
export interface TransferGrantFence {
  ownerId: string;
  projectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  /** Immutable owner-controlled epoch at job admission. */
  grantEpoch: number;
  /** Normal copies can use standard authorization. */
  mode: 'standard' | 'core' | 'root';
  /** Root has a separately scoped session-generation/lease epoch. */
  rootEpoch?: number;
  rootExpiresAt?: string;
}

export interface CurrentAuthenticatedTransferGrant {
  ownerId: string;
  projectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  grantEpoch: number;
  enabled: boolean;
  revoked: boolean;
  mode: 'standard' | 'core' | 'root';
  rootEpoch?: number;
  rootExpiresAt?: string;
  /** Attestation of local elevated Broker belongs to the signed #617/#551
   * implementation, not the owner control-plane preference. */
  brokerAttested: boolean;
}

export interface TrustedTransferGrantSource {
  /** Must read from owner-controlled, rollback-independent trust authority.
   * Throws or returns undefined if revocation/clock state is unavailable. */
  current(binding: Readonly<TransferBinding>): Promise<
    CurrentAuthenticatedTransferGrant | undefined>;
}

/**
 * Strict scope and epoch gate compatible with the #613 TransferAuthorization
 * injection. Never grants new rights; only denies when the old job's
 * owner/device/privilege identity is no longer proven current.
 */
export function ownerGrantEpochGuard(
  admission: TransferGrantFence,
  source: TrustedTransferGrantSource | undefined,
  clock: () => number = Date.now,
): TransferAuthorization {
  return async (
    route: Readonly<AuthenticatedTransferRoute>,
    binding: Readonly<TransferBinding>,
  ): Promise<boolean> => {
    if (!source || !Number.isSafeInteger(admission.grantEpoch) ||
        admission.grantEpoch < 1 ||
        !admission.ownerId || !admission.projectId ||
        admission.sourceDeviceId === admission.destinationDeviceId) {
      return false;
    }
    const validTime = clock();
    if (!Number.isFinite(validTime)) return false;
    if (admission.ownerId !== binding.ownerId ||
        admission.projectId !== binding.projectId ||
        admission.sourceDeviceId !== binding.sourceDeviceId ||
        admission.destinationDeviceId !== binding.destinationDeviceId ||
        route.ownerId !== admission.ownerId ||
        route.projectId !== admission.projectId ||
        route.sourceDeviceId !== admission.sourceDeviceId ||
        route.destinationDeviceId !== admission.destinationDeviceId) {
      return false;
    }
    let current: CurrentAuthenticatedTransferGrant | undefined;
    try { current = await source.current(binding); }
    catch { return false; }
    if (!current || !current.enabled || current.revoked ||
        current.ownerId !== admission.ownerId ||
        current.projectId !== admission.projectId ||
        current.sourceDeviceId !== admission.sourceDeviceId ||
        current.destinationDeviceId !== admission.destinationDeviceId ||
        current.grantEpoch !== admission.grantEpoch ||
        current.mode !== admission.mode) {
      return false;
    }
    if (admission.mode === 'standard') return true;
    // A CORE preference in ControlPlaneIdentity is PAUSED_UNVERIFIED;
    // brokerAttested must reflect an independently verified actual helper,
    // never a UI preference or a mere consent.exe process presence.
    if (!current.brokerAttested) return false;
    if (admission.mode === 'core') return true;
    // ROOT is both owner/session generation-bound and time-bounded.
    if (!Number.isSafeInteger(admission.rootEpoch) ||
        (admission.rootEpoch ?? 0) < 1 ||
        admission.rootEpoch !== current.rootEpoch ||
        !admission.rootExpiresAt || !current.rootExpiresAt ||
        admission.rootExpiresAt !== current.rootExpiresAt) {
      return false;
    }
    const expiry = Date.parse(current.rootExpiresAt);
    return Number.isFinite(expiry) && expiry > validTime &&
      expiry - validTime <= 15 * 60 * 1000;
  };
}
