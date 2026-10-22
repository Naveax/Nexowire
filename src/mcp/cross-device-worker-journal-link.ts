import { randomBytes } from 'node:crypto';
import type {
  AuthenticatedTransferRoute, TransferAuthorization, TransferBinding,
  TransferCheckpoint, PendingTransferChunk,
} from './cross-device-transfer-continuity.js';

/**
 * Source-only bridge for #634's durable one-call worker journal and #613's
 * Connection checkpoint. Never executes writes, adopts remote ACKs, calls
 * #08's filesystem store, changes quota, or advances either journal.
 *
 * A worker lease epoch, WSS socket epoch, and ROOT/CORE owner grant epoch
 * are THREE INDEPENDENT authorities. Their numeric equality proves nothing.
 */
export interface FencedWorkerJournalSnapshot {
  id: string;
  accountId: string;
  projectId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourcePath: string;
  targetPath: string;
  stagePath: string;
  bytesTotal: number;
  bytesConfirmed: number;
  sha256: string;
  /** #725 typed diagnostic metadata is forensic only, never a dispatch grant. */
  errorCode?: string;
  state: 'QUEUED' | 'RUNNING' | 'RECOVERY_REQUIRED' | 'FAILED' |
    'MUTATION_UNKNOWN' | 'CANCEL_REQUESTED' | 'CANCELLED' |
    'PUBLISHING' | 'COMPLETED';
  fencing?: { epoch: number; token: string };
  pending?: {
    requestId: string;
    epoch: number;
    offset: number;
    length: number;
    sha256: string;
    /** #691: false is durably reserved but not yet dispatched. Missing on
     * legacy journals means dispatch status is UNKNOWN, not false. */
    dispatched?: boolean;
  };
}

/** Authenticated Broker-only view of the ACTIVE socket epoch. Never read an
 * epoch from the worker, Agent ACK, or control-plane badge. */
export interface ConnectionSessionWitness {
  currentEpoch(route: Readonly<AuthenticatedTransferRoute>): Promise<number | undefined>;
}

/** #712 scope is distinct from numeric WebSocket and Artifact writer epochs.
 * Admission MUST be derived from independently protected Broker/owner state;
 * this read-only module never creates or validates a signed dispatch permit. */
export interface BrokerOwnerEpochAdmission {
  ownerEpoch: number;
  grantGeneration: number;
  deviceEpoch: string;
  sessionEpoch: string;
  privilege: 'CORE' | 'ROOT';
}
export interface BrokerOwnerEpochChallenge extends BrokerOwnerEpochAdmission {
  ownerId: string;
  deviceId: string;
  challengeNonce: string;
}
export interface BrokerOwnerEpochWitness {
  /** Must authenticate protected Broker ownerEpoch/generation with a NEW
   * nonce-bound *read-only* proof against independent revoke authority.
   * NEVER call #712's beginIfCurrent merely to inspect: it reserves an
   * external dispatch claim. If read-only signed evidence is unavailable,
   * the witness must deny. Caller/Agent/WAL booleans are NEVER proof. */
  assertFresh(challenge: Readonly<BrokerOwnerEpochChallenge>): Promise<boolean>;
}

export interface WorkerLeaseWitness {
  /** Never fulfilled by a local PID, owner UI toggle, or Agent response. */
  check(
    job: Readonly<FencedWorkerJournalSnapshot>,
    scope: Readonly<AuthenticatedTransferRoute>,
  ): Promise<boolean>;
}

export interface TrustedStageReadback {
  /** MUST read actual authenticated target-device stage bytes.
   * Agent self-asserted write ACK is not evidence. */
  inspect(
    job: Readonly<FencedWorkerJournalSnapshot>,
    pending: Readonly<PendingTransferChunk>,
  ): Promise<
    | { kind: 'verified'; deviceId: string; offset: number; length: number; sha256: string }
    | { kind: 'unavailable' | 'partial' | 'missing' }
  >;
}

export type WorkerReconciliationDecision =
  | 'authority_blocked'
  | 'journal_mismatch'
  | 'epoch_stale'
  | 'cancel_pending'
  | 'mutation_unknown'
  | 'reservation_unresolved'
  | 'readback_verified_not_committed'
  | 'prefix_consistent'
  | 'unverified_completion';

export interface WorkerReconciliationProof {
  readonly state: WorkerReconciliationDecision;
  /** This adapter NEVER grants a write or advances checkpoint bytes. */
  readonly automaticallyReplayable: false;
  readonly mutationExecuted: false;
  readonly checkpointAdvanced: false;
  readonly externalSideEffectProven: false;
  readonly requestId?: string;
  readonly verifiedPrefixBytes: number;
}

const sha = /^[0-9a-f]{64}$/;
const safe = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const denied = (
  state: WorkerReconciliationDecision,
  bytes: number,
  requestId?: string,
): WorkerReconciliationProof => ({
  state, automaticallyReplayable: false, mutationExecuted: false,
  checkpointAdvanced: false, externalSideEffectProven: false,
  verifiedPrefixBytes: safe(bytes) ? bytes : 0,
  ...(requestId ? { requestId } : {}),
});
const matchesBinding = (
  job: FencedWorkerJournalSnapshot,
  binding: TransferBinding,
): boolean => job.id === binding.jobId &&
  job.accountId === binding.ownerId &&
  job.projectId === binding.projectId &&
  job.sourceDeviceId === binding.sourceDeviceId &&
  job.targetDeviceId === binding.destinationDeviceId &&
  job.sourcePath === binding.sourcePath &&
  job.targetPath === binding.targetPath &&
  job.stagePath === binding.stagePath &&
  job.bytesTotal === binding.totalBytes &&
  job.sha256 === binding.sourceSha256;

export async function inspectOneCallWorkerConnectionJournal(input: {
  /** From trusted, durable #08 worker metadata, not caller JSON. */
  worker: Readonly<FencedWorkerJournalSnapshot>;
  /** From trusted Connection checkpoint CAS, not Agent status JSON. */
  checkpoint: Readonly<TransferCheckpoint>;
  /** From authenticated Broker exact-device route. */
  route: Readonly<AuthenticatedTransferRoute>;
  /** #613 current owner/project/CORE/ROOT grant check. */
  authorize?: TransferAuthorization;
  /** #616/#634 rollback-independent *worker* CAS lease check. */
  workerLease?: WorkerLeaseWitness;
  /** Required #712 protected owner/session admission and nonce-bound oracle. */
  ownerAdmission?: Readonly<BrokerOwnerEpochAdmission>;
  ownerEpochWitness?: BrokerOwnerEpochWitness;
  /** Required fresh Broker witness; read again after any awaited readback. */
  sessionWitness?: ConnectionSessionWitness;
  /** Optional independent non-mutating destination readback. */
  stageReadback?: TrustedStageReadback;
}): Promise<WorkerReconciliationProof> {
  const { worker, checkpoint, route } = input;
  const pending = checkpoint.pending;
  const id = pending?.requestId;
  const offset = checkpoint.offset;

  // Structural provenance and immutable source/destination identity.
  if (!matchesBinding(worker, checkpoint.binding) ||
      route.ownerId !== checkpoint.binding.ownerId ||
      route.projectId !== checkpoint.binding.projectId ||
      route.sourceDeviceId !== checkpoint.binding.sourceDeviceId ||
      route.destinationDeviceId !== checkpoint.binding.destinationDeviceId ||
      !safe(worker.bytesTotal) || !safe(worker.bytesConfirmed) ||
      worker.bytesConfirmed > worker.bytesTotal ||
      !sha.test(worker.sha256) || !safe(checkpoint.offset) ||
      checkpoint.offset > worker.bytesTotal ||
      !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0) {
    return denied('journal_mismatch', offset, id);
  }
  if (!Number.isSafeInteger(route.epoch) || route.epoch < 1 ||
      checkpoint.epoch !== route.epoch) {
    return denied('epoch_stale', offset, id);
  }
  const admission = input.ownerAdmission;
  if (!input.authorize || !input.workerLease || !input.sessionWitness ||
      !input.ownerEpochWitness || !admission ||
      !Number.isSafeInteger(admission.ownerEpoch) || admission.ownerEpoch < 1 ||
      !Number.isSafeInteger(admission.grantGeneration) || admission.grantGeneration < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admission.deviceEpoch) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admission.sessionEpoch) ||
      (admission.privilege !== 'CORE' && admission.privilege !== 'ROOT') ||
      !worker.fencing ||
      !Number.isSafeInteger(worker.fencing.epoch) ||
      worker.fencing.epoch < 1 ||
      typeof worker.fencing.token !== 'string' ||
      worker.fencing.token.length < 32 || worker.fencing.token.length > 256) {
    return denied('authority_blocked', offset, id);
  }
  // Each inspection phase MUST obtain a fresh signed nonce-bound owner proof;
  // a correctly signed permit resurrected from a rolled-back WAL is stale.
  const ownerChallenge = (): BrokerOwnerEpochChallenge => ({
    ...admission, ownerId: checkpoint.binding.ownerId,
    deviceId: checkpoint.binding.destinationDeviceId,
    challengeNonce: randomBytes(32).toString('hex'),
  });
  let current = false, leased = false, ownerEpochCurrent = false;
  let liveSocketEpoch: number | undefined;
  try {
    current = await input.authorize(route, checkpoint.binding);
    if (current) leased = await input.workerLease.check(worker, route);
    if (leased) ownerEpochCurrent = await input.ownerEpochWitness.assertFresh(ownerChallenge());
    if (ownerEpochCurrent) liveSocketEpoch = await input.sessionWitness.currentEpoch(route);
  } catch { /* unreachable authority must fail closed */ }
  if (!current || !leased || !ownerEpochCurrent || !Number.isSafeInteger(liveSocketEpoch)) {
    return denied('authority_blocked', offset, id);
  }
  if (liveSocketEpoch !== route.epoch) {
    return denied('epoch_stale', offset, id);
  }

  // Any unresolved chunk (even after worker reports CANCELLED) is never
  // discarded, re-dispatched, or credited by an ACK.
  if (pending || worker.pending) {
    if (!pending || !worker.pending ||
        pending.requestId !== worker.pending.requestId ||
        pending.offset !== worker.pending.offset ||
        pending.length !== worker.pending.length ||
        pending.sha256 !== worker.pending.sha256 ||
        !safe(pending.offset) || !Number.isSafeInteger(pending.length) ||
        pending.length < 1 || pending.length > 65_536 ||
        pending.offset !== offset ||
        pending.offset + pending.length > worker.bytesTotal ||
        !sha.test(pending.sha256) ||
        (worker.pending.dispatched !== undefined &&
         typeof worker.pending.dispatched !== 'boolean') ||
        !Number.isSafeInteger(worker.pending.epoch) ||
        !worker.fencing || worker.pending.epoch !== worker.fencing.epoch) {
      return denied('journal_mismatch', offset, id);
    }
    if (worker.state === 'CANCELLED' || worker.state === 'CANCEL_REQUESTED' ||
        checkpoint.status === 'cancelled' || checkpoint.status === 'cancel_pending') {
      return denied('cancel_pending', offset, id);
    }
    // A #691 pending reservation with dispatched=false is not a receipt.
    // Never promote a matching stale stage from a previous incarnation to
    // evidence that this newly reserved mutation executed. A legacy record
    // with no flag is POSSIBLY dispatched and retains UNKNOWN semantics.
    if (worker.pending.dispatched === false) {
      return denied('reservation_unresolved', offset, id);
    }
    if (!input.stageReadback) return denied('mutation_unknown', offset, id);
    let observation: Awaited<ReturnType<TrustedStageReadback['inspect']>>;
    try { observation = await input.stageReadback.inspect(worker, pending); }
    catch { return denied('mutation_unknown', offset, id); }
    // A revoke, or an advanced external worker lease, DURING the readback
    // invalidates the evidence. No checkpoint CAS in this read-only adapter.
    try {
      if (!(await input.authorize(route, checkpoint.binding)) ||
          !(await input.workerLease.check(worker, route)) ||
          !(await input.ownerEpochWitness.assertFresh(ownerChallenge()))) {
        return denied('authority_blocked', offset, id);
      }
      // Reconnect can happen during the independent destination read. A
      // readback from the old socket is NOT authenticated proof for the
      // current exact device even when chunk hash and UUID match.
      const freshEpoch = await input.sessionWitness.currentEpoch(route);
      if (!Number.isSafeInteger(freshEpoch)) {
        return denied('authority_blocked', offset, id);
      }
      if (freshEpoch !== route.epoch) {
        return denied('epoch_stale', offset, id);
      }
    } catch { return denied('authority_blocked', offset, id); }
    if (observation.kind !== 'verified' ||
        observation.deviceId !== worker.targetDeviceId ||
        observation.offset !== pending.offset ||
        observation.length !== pending.length ||
        observation.sha256 !== pending.sha256) {
      return denied('mutation_unknown', offset, id);
    }
    // Caller must separately request a CAS from #613 and verify that the
    // #08 worker and Connection journal share one monotonic authority.
    return denied('readback_verified_not_committed', offset, id);
  }

  if (worker.bytesConfirmed !== checkpoint.offset) {
    return denied('journal_mismatch', offset);
  }
  if (worker.state === 'CANCELLED' || worker.state === 'CANCEL_REQUESTED' ||
      checkpoint.status === 'cancel_pending' || checkpoint.status === 'cancelled') {
    return denied('cancel_pending', offset);
  }
  // #725 may correctly preserve an UNKNOWN outcome while a damaged or
  // partially restored journal no longer exposes either pending envelope.
  // Equal offsets are NOT proof that an orphaned Native effect completed.
  if (worker.state === 'MUTATION_UNKNOWN' || worker.state === 'RECOVERY_REQUIRED' ||
      worker.state === 'FAILED' || checkpoint.status === 'unknown') {
    return denied('mutation_unknown', offset);
  }
  if (worker.state === 'COMPLETED' || worker.state === 'PUBLISHING' ||
      checkpoint.status === 'complete' || checkpoint.status === 'verified') {
    // Publishing without pending is still unverified until trusted target
    // postcondition; never infer success from equal source/target offsets.
    return denied('unverified_completion', offset);
  }
  // Only QUEUED/RUNNING with no pending and equal offsets may describe a
  // healthy, read-only prefix. It NEVER authorizes dispatch or replay.
  if (worker.state !== 'QUEUED' && worker.state !== 'RUNNING') {
    return denied('mutation_unknown', offset);
  }
  return denied('prefix_consistent', offset);
}
