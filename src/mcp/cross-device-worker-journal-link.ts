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
  };
}

/** Authenticated Broker-only view of the ACTIVE socket epoch. Never read an
 * epoch from the worker, Agent ACK, or control-plane badge. */
export interface ConnectionSessionWitness {
  currentEpoch(route: Readonly<AuthenticatedTransferRoute>): Promise<number | undefined>;
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
  if (!input.authorize || !input.workerLease || !input.sessionWitness || !worker.fencing ||
      !Number.isSafeInteger(worker.fencing.epoch) ||
      worker.fencing.epoch < 1 || worker.fencing.token.length < 32) {
    return denied('authority_blocked', offset, id);
  }
  let current = false, leased = false;
  let liveSocketEpoch: number | undefined;
  try {
    current = await input.authorize(route, checkpoint.binding);
    if (current) leased = await input.workerLease.check(worker, route);
    if (leased) liveSocketEpoch = await input.sessionWitness.currentEpoch(route);
  } catch { /* unreachable authority must fail closed */ }
  if (!current || !leased || !Number.isSafeInteger(liveSocketEpoch)) {
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
        !Number.isSafeInteger(worker.pending.epoch) ||
        !worker.fencing || worker.pending.epoch !== worker.fencing.epoch) {
      return denied('journal_mismatch', offset, id);
    }
    if (worker.state === 'CANCELLED' || worker.state === 'CANCEL_REQUESTED' ||
        checkpoint.status === 'cancelled' || checkpoint.status === 'cancel_pending') {
      return denied('cancel_pending', offset, id);
    }
    if (!input.stageReadback) return denied('mutation_unknown', offset, id);
    let observation: Awaited<ReturnType<TrustedStageReadback['inspect']>>;
    try { observation = await input.stageReadback.inspect(worker, pending); }
    catch { return denied('mutation_unknown', offset, id); }
    // A revoke, or an advanced external worker lease, DURING the readback
    // invalidates the evidence. No checkpoint CAS in this read-only adapter.
    try {
      if (!(await input.authorize(route, checkpoint.binding)) ||
          !(await input.workerLease.check(worker, route))) {
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
      checkpoint.status === 'cancel_pending') {
    return denied('cancel_pending', offset);
  }
  if (worker.state === 'COMPLETED' || checkpoint.status === 'complete') {
    // Final independent published-target attestation belongs to #08.
    return denied('unverified_completion', offset);
  }
  return denied('prefix_consistent', offset);
}
