/**
 * #42, isolated worker reconnect/lease FENCING CONTRACT, not a dispatcher.
 * These objects are claims and snapshots, not OS/owner authority. No caller
 * can convert a local assertion, signed enrollment, or cached receipt into
 * a native execution permit using this module.
 */
export interface WorkerMutationIdentity {
  readonly ownerAccountId: string;
  readonly deviceId: string;
  readonly pairingRealm: 'self-host' | 'cloud';
  readonly deviceSignerSpkiSha256: string;
  readonly ownerEpoch: number;
  readonly oauthSessionEpoch: number;
  readonly pairingEpoch: number;
  readonly issuerEpoch: number;
  readonly taskId: string;
  readonly worktreeId: string;
  readonly sourceSha: string;
  readonly stepId: string;
  readonly logicalMutationId: string;
  readonly originalRequestId: string;
}

/** Local session and socket generations MUST NOT redefine logical identity. */
export interface WorkerLeaseCheckpoint {
  readonly identity: WorkerMutationIdentity;
  readonly leaseId: string;
  readonly localSessionId: string;
  readonly connectionEpoch: number;
  readonly wssSessionGeneration: number;
  readonly expiresAtMs: number;
  readonly mutationState: 'not_sent' | 'dispatch_pending' | 'ack_lost' | 'journal_unknown';
}

/** Values must come from fresh, independently authenticated service readback. */
export interface WorkerAuthorityReadback {
  readonly ownerAccountId: string;
  readonly deviceId: string;
  readonly pairingRealm: 'self-host' | 'cloud';
  readonly deviceSignerSpkiSha256: string;
  readonly ownerEpoch: number;
  readonly oauthSessionEpoch: number;
  readonly pairingEpoch: number;
  readonly issuerEpoch: number;
  readonly connectionEpoch: number;
  readonly wssSessionGeneration: number;
  readonly localSessionId: string;
  readonly online: boolean;
  readonly oauthActive: boolean;
  readonly ownerRevoked: boolean;
  readonly pairingRevoked: boolean;
  readonly leaseRevoked: boolean;
  readonly readbackVerified: boolean;
}

export type LeaseFenceReason =
  | 'INVALID_OR_MISSING_PROVENANCE'
  | 'IMMUTABLE_MUTATION_IDENTITY_CHANGED'
  | 'OWNER_DEVICE_AUTHORITY_CHANGED'
  | 'OWNER_LOGOUT_OR_REVOCATION'
  | 'OFFLINE_OR_UNVERIFIED_READBACK'
  | 'EXPIRED_LEASE'
  | 'RECONNECT_REQUIRES_NEW_EXTERNAL_COMMIT'
  | 'RECONCILE_REQUIRED'
  | 'BLOCKED_EXTERNAL_CAS_UNAVAILABLE';

export interface WorkerLeaseDecision {
  readonly reason: LeaseFenceReason;
  readonly mayDispatch: false;
  readonly mayReplayMutation: false;
  readonly mayLaunchNativeTool: false;
  /** A stale authority STOP does not settle a previously uncertain mutation. */
  readonly reconciliationRequired: boolean;
  readonly state: 'STOP' | 'RECONCILE_REQUIRED' | 'BLOCKED';
  readonly originalLogicalMutationId: string | null;
  readonly originalRequestId: string | null;
  readonly originalSourceSha: string | null;
}

const identityKeys = [
  'ownerAccountId', 'deviceId', 'pairingRealm', 'deviceSignerSpkiSha256', 'ownerEpoch',
  'oauthSessionEpoch', 'pairingEpoch', 'issuerEpoch', 'taskId',
  'worktreeId', 'sourceSha', 'stepId', 'logicalMutationId', 'originalRequestId',
] as const satisfies readonly (keyof WorkerMutationIdentity)[];
const authorityKeys = [
  'ownerAccountId', 'deviceId', 'pairingRealm', 'deviceSignerSpkiSha256', 'ownerEpoch',
  'oauthSessionEpoch', 'pairingEpoch', 'issuerEpoch',
] as const satisfies readonly (keyof WorkerMutationIdentity & keyof WorkerAuthorityReadback)[];
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 256 &&
  /^[A-Za-z0-9_.:@/-]+$/.test(value);
const isPairingRealm = (v: unknown): v is 'self-host' | 'cloud' => v === 'self-host' || v === 'cloud';
const isEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validIdentity(v: WorkerMutationIdentity): boolean {
  if (!v || typeof v !== 'object') return false;
  return identityKeys.every(k => {
    const value = v[k];
    if (k === 'pairingRealm') return isPairingRealm(value);
    if (k === 'sourceSha') return isSha(value);
    if (k === 'deviceSignerSpkiSha256') return isDigest(value);
    if (k.endsWith('Epoch')) return isEpoch(value);
    return isId(value);
  });
}

const decision = (
  reason: LeaseFenceReason,
  state: WorkerLeaseDecision['state'],
  identity?: WorkerMutationIdentity,
  reconciliationRequired = false,
): WorkerLeaseDecision => Object.freeze({
  reason, state, reconciliationRequired, mayDispatch: false as const, mayReplayMutation: false as const,
  mayLaunchNativeTool: false as const,
  originalLogicalMutationId: isId(identity?.logicalMutationId) ? identity.logicalMutationId : null,
  originalRequestId: isId(identity?.originalRequestId) ? identity.originalRequestId : null,
  originalSourceSha: isSha(identity?.sourceSha) ? identity.sourceSha : null,
});

/**
 * Strictly read-only local evaluation. A valid readback is NOT a linearizable
 * external commit-vs-revoke, and this function NEVER issues a dispatch grant.
 * The new session cannot reuse the old connection's admission token.
 */
export function reviewWorkerLeaseReconnect(input: {
  readonly checkpoint: WorkerLeaseCheckpoint;
  readonly attemptedIdentity: WorkerMutationIdentity;
  readonly current?: WorkerAuthorityReadback;
  readonly nowMs: number;
}): WorkerLeaseDecision {
  const {checkpoint: cp, attemptedIdentity: attempt, current: a, nowMs} = input;
  // Preserve reported ACK-loss across revoke, reconnect and lease expiry.
  // This is forensic metadata, not an authenticated durable journal.
  if (!cp || !validIdentity(cp.identity) ||
      !['not_sent', 'dispatch_pending', 'ack_lost', 'journal_unknown'].includes(cp.mutationState)) {
    return decision('INVALID_OR_MISSING_PROVENANCE', 'STOP');
  }
  const needsReconciliation = cp.mutationState !== 'not_sent';
  const fenced = (reason: LeaseFenceReason, state: WorkerLeaseDecision['state']) =>
    decision(reason, state, cp.identity, needsReconciliation);
  if (!validIdentity(attempt) ||
      !isId(cp.leaseId) || !isId(cp.localSessionId) ||
      !isEpoch(cp.connectionEpoch) || !isEpoch(cp.wssSessionGeneration) ||
      !Number.isSafeInteger(cp.expiresAtMs) || cp.expiresAtMs <= 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return fenced('INVALID_OR_MISSING_PROVENANCE', 'STOP');
  }
  if (identityKeys.some(k => cp.identity[k] !== attempt[k])) {
    return fenced('IMMUTABLE_MUTATION_IDENTITY_CHANGED', 'STOP');
  }
  if (!a || a.readbackVerified !== true || a.online !== true ||
      !isPairingRealm(a.pairingRealm) ||
      !isId(a.localSessionId) || !isEpoch(a.connectionEpoch) ||
      !isEpoch(a.wssSessionGeneration) ||
      authorityKeys.some(k => typeof a[k] === 'undefined')) {
    return fenced('OFFLINE_OR_UNVERIFIED_READBACK', 'BLOCKED');
  }
  if (authorityKeys.some(k => cp.identity[k] !== a[k])) {
    return fenced('OWNER_DEVICE_AUTHORITY_CHANGED', 'STOP');
  }
  if (a.oauthActive !== true || a.ownerRevoked !== false ||
      a.pairingRevoked !== false || a.leaseRevoked !== false) {
    return fenced('OWNER_LOGOUT_OR_REVOCATION', 'STOP');
  }
  if (nowMs >= cp.expiresAtMs) {
    return fenced('EXPIRED_LEASE', 'STOP');
  }
  // UNKNOWN takes precedence even when a new socket/Hub claims healthy.
  if (cp.mutationState !== 'not_sent') {
    return fenced('RECONCILE_REQUIRED', 'RECONCILE_REQUIRED');
  }
  if (a.localSessionId !== cp.localSessionId ||
      a.connectionEpoch !== cp.connectionEpoch ||
      a.wssSessionGeneration !== cp.wssSessionGeneration) {
    return fenced('RECONNECT_REQUIRES_NEW_EXTERNAL_COMMIT', 'BLOCKED');
  }
  // Even same-session NOT_SENT is just a local assertion. A real external
  // atomic CAS, signer/key/nonce proof and protected OS effect gate are absent.
  return fenced('BLOCKED_EXTERNAL_CAS_UNAVAILABLE', 'BLOCKED');
}

/** Proposed integration only: NOT implemented or injectable into dispatch. */
export interface ExternalWorkerLeaseAuthorityRequirements {
  /** Independent, non-restorable CAS; exact immutable key and fresh epochs. */
  readonly atomicReserveAndCommitVsRevokeStart: true;
  /** Unique one-use enrollment nonce + signer SPKI / issuer epoch readback. */
  readonly oneUseSignedEnrollment: true;
  /** Read-only correlated original request/OS-effect outcome inspection. */
  readonly authenticatedOutcomeReconciliation: true;
  /** Native protected dispatch boundary; not browser/UI preference. */
  readonly protectedNativeEffectGate: true;
}
