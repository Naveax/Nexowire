import { randomUUID } from 'node:crypto';

/**
 * Connection-layer, metadata-only transfer reconciliation. Artifact store,
 * filesystem and durable checkpoint backend are injected by their owners.
 *
 * A connection loss NEVER means that a file write did not happen. A recovered
 * chunk may advance solely after independent destination readback at the
 * exact persisted offset. Neither an ACK nor an identical request ID alone
 * authorizes replay or file publication.
 */
export type TransferStatus =
  | 'ready' | 'awaiting_ack' | 'unknown' | 'cancel_pending'
  | 'cancelled' | 'verified' | 'complete';

export interface TransferBinding {
  jobId: string;
  ownerId: string;
  projectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  sourcePath: string;
  targetPath: string;
  stagePath: string;
  sourceSha256: string;
  totalBytes: number;
}

export interface PendingTransferChunk {
  requestId: string;
  epoch: number;
  offset: number;
  length: number;
  sha256: string;
  ackObserved: boolean;
}

export interface TransferCheckpoint {
  binding: TransferBinding;
  revision: number;
  epoch: number;
  offset: number;
  status: TransferStatus;
  pending?: PendingTransferChunk;
}

export interface TransferCheckpointStore {
  /** Must durably and atomically reject duplicate job IDs. */
  insert(record: TransferCheckpoint): Promise<boolean>;
  read(jobId: string): Promise<TransferCheckpoint | undefined>;
  /** Must commit revision and full row atomically before resolving true. */
  compareAndSwap(
    jobId: string, expectedRevision: number, next: TransferCheckpoint
  ): Promise<boolean>;
}

export interface AuthenticatedTransferRoute {
  /** These fields MUST come from the authenticated routing context. */
  ownerId: string;
  projectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  epoch: number;
}

/** Inject the *current* authoritative owner/device/project grant lookup.
 * Called before every checkpoint transition, not cached at job creation.
 * A revoked or unreachable authority fails closed. */
export type TransferAuthorization = (
  route: Readonly<AuthenticatedTransferRoute>,
  binding: Readonly<TransferBinding>,
) => Promise<boolean>;

export type DestinationReadback = (
  binding: Readonly<TransferBinding>,
  pending: Readonly<PendingTransferChunk>,
) => Promise<
  | { kind: 'verified'; deviceId: string; offset: number; length: number; sha256: string }
  | { kind: 'missing' | 'partial' | 'unavailable' }
>;

/** Trusted #08 publisher must independently inspect an already-published
 * destination; arbitrary tool arguments are NOT completion proof. */
export type PublishedArtifactReadback = (
  binding: Readonly<TransferBinding>,
) => Promise<
  | { kind: 'verified'; deviceId: string; size: number; sha256: string }
  | { kind: 'missing' | 'unavailable' | 'mismatch' }
>;

const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeBytes = (n: number) => Number.isSafeInteger(n) && n >= 0;
const copy = (record: TransferCheckpoint): TransferCheckpoint => ({
  ...record,
  binding: { ...record.binding },
  ...(record.pending ? { pending: { ...record.pending } } : {}),
});

export class TransferContinuityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TransferContinuityError';
  }
}
const deny = (code: string, message: string): never => {
  throw new TransferContinuityError(code, message);
};
const requireRow = (row: TransferCheckpoint | undefined): TransferCheckpoint => {
  if (!row) return deny('TRANSFER_JOB_NOT_FOUND', 'Durable transfer job was not found.');
  return copy(row);
};
function validateBinding(binding: TransferBinding): void {
  if (!uuid.test(binding.jobId) ||
      !binding.ownerId || !binding.projectId ||
      !binding.sourceDeviceId || !binding.destinationDeviceId ||
      !binding.sourcePath || !binding.targetPath || !binding.stagePath ||
      binding.sourceDeviceId === binding.destinationDeviceId ||
      !sha.test(binding.sourceSha256) ||
      !safeBytes(binding.totalBytes)) {
    deny('TRANSFER_BINDING_INVALID', 'Invalid immutable transfer owner/device/source binding.');
  }
}
function assertScope(
  row: TransferCheckpoint, route: AuthenticatedTransferRoute,
  requireEpoch = true,
): void {
  const b = row.binding;
  if (!route.ownerId || route.ownerId !== b.ownerId ||
      !route.projectId || route.projectId !== b.projectId ||
      route.sourceDeviceId !== b.sourceDeviceId ||
      route.destinationDeviceId !== b.destinationDeviceId) {
    deny('TRANSFER_ROUTE_DENIED', 'Authenticated owner or device scope mismatch.');
  }
  if (!Number.isSafeInteger(route.epoch) || route.epoch < 1 ||
      (requireEpoch && route.epoch !== row.epoch)) {
    deny('TRANSFER_EPOCH_STALE', 'Connection epoch does not match durable transfer checkpoint.');
  }
}

export class DurableTransferContinuity {
  constructor(
    private readonly store: TransferCheckpointStore,
    private readonly readback: DestinationReadback,
    private readonly publishedReadback?: PublishedArtifactReadback,
    private readonly authorize?: TransferAuthorization,
  ) {}

  private async assertCurrentlyAuthorized(
    row: TransferCheckpoint, route: AuthenticatedTransferRoute,
  ): Promise<void> {
    if (!this.authorize) {
      return deny('TRANSFER_AUTHORITY_UNAVAILABLE', 'Live owner/device grant authority is unavailable.');
    }
    let approved = false;
    try { approved = await this.authorize(route, row.binding); }
    catch { /* revoked, offline or failed authorization must fail closed */ }
    if (approved !== true) {
      return deny('TRANSFER_ACCESS_REVOKED', 'Transfer access is revoked or cannot be verified.');
    }
  }

  async create(binding: TransferBinding, route: AuthenticatedTransferRoute): Promise<TransferCheckpoint> {
    validateBinding(binding);
    const row: TransferCheckpoint = {
      binding: { ...binding }, revision: 0, epoch: route.epoch,
      offset: 0, status: 'ready',
    };
    assertScope(row, route);
    await this.assertCurrentlyAuthorized(row, route);
    if (!await this.store.insert(row)) {
      return deny('TRANSFER_JOB_EXISTS', 'A durable transfer with this UUID already exists.');
    }
    return copy(row);
  }

  async inspect(jobId: string, route: AuthenticatedTransferRoute): Promise<TransferCheckpoint> {
    const row = requireRow(await this.store.read(jobId));
    assertScope(row, route);
    await this.assertCurrentlyAuthorized(row, route);
    return row;
  }

  private async save(old: TransferCheckpoint, next: TransferCheckpoint,
    route: AuthenticatedTransferRoute): Promise<TransferCheckpoint> {
    await this.assertCurrentlyAuthorized(old, route);
    const updated = { ...next, revision: old.revision + 1 };
    if (!await this.store.compareAndSwap(old.binding.jobId, old.revision, updated)) {
      return deny('TRANSFER_CAS_CONFLICT', 'Durable transfer checkpoint revision changed.');
    }
    return copy(updated);
  }

  /**
   * Must be called before dispatch; duplicate/overlap, unknown ACK and
   * cancelled jobs are never submitted to the transport.
   */
  async reserveWrite(input: {
    jobId: string; route: AuthenticatedTransferRoute;
    offset: number; length: number; sha256: string;
  }): Promise<TransferCheckpoint> {
    const old = await this.inspect(input.jobId, input.route);
    if (old.status !== 'ready') {
      return deny('TRANSFER_NOT_DISPATCHABLE', 'Unverified, cancelled or in-flight mutation cannot be replayed.');
    }
    if (!safeBytes(input.offset) || input.offset !== old.offset ||
        !Number.isSafeInteger(input.length) || input.length < 1 || input.length > 65_536 ||
        input.offset + input.length > old.binding.totalBytes ||
        !sha.test(input.sha256)) {
      return deny('TRANSFER_CHUNK_INVALID', 'Chunk must match exact persisted offset, length and digest.');
    }
    // Generate each request ID here; never allow the caller to recycle an
    // earlier mutation ID by supplying it as a parameter.
    const requestId = randomUUID();
    if (!uuid.test(requestId)) {
      return deny('TRANSFER_REQUEST_ID_INVALID', 'Chunk request ID is not a UUID.');
    }
    return this.save(old, {
      ...old, status: 'awaiting_ack',
      pending: {
        requestId, epoch: old.epoch, offset: input.offset,
        length: input.length, sha256: input.sha256, ackObserved: false,
      },
    }, input.route);
  }

  /**
   * ACK only attests a frame's correlation. It never advances an offset,
   * claims a physical write, or dispatches another mutation.
   */
  async observeAck(input: {
    jobId: string; route: AuthenticatedTransferRoute;
    requestId: string; offset: number; sha256: string;
  }): Promise<boolean> {
    const old = await this.inspect(input.jobId, input.route);
    const pending = old.pending;
    if (old.status !== 'awaiting_ack' || !pending ||
        pending.requestId !== input.requestId || pending.epoch !== input.route.epoch ||
        pending.offset !== input.offset || pending.sha256 !== input.sha256) {
      return false;
    }
    if (pending.ackObserved) return true;
    await this.save(old, { ...old, pending: { ...pending, ackObserved: true } }, input.route);
    return true;
  }

  /** Broker-owned epoch change; no remote write is sent. */
  async onReconnect(input: {
    jobId: string; oldRoute: AuthenticatedTransferRoute; nextEpoch: number;
  }): Promise<TransferCheckpoint> {
    const old = await this.inspect(input.jobId, input.oldRoute);
    if (!Number.isSafeInteger(input.nextEpoch) || input.nextEpoch <= old.epoch) {
      return deny('TRANSFER_EPOCH_STALE', 'Next epoch must be strictly newer.');
    }
    return this.save(old, {
      ...old,
      epoch: input.nextEpoch,
      status: old.status === 'awaiting_ack' ? 'unknown' : old.status,
    }, input.oldRoute);
  }

  /** Never automatically retries an UNKNOWN mutation. A readback mismatch
   * retains UNKNOWN even when an ACK had been observed. */
  async reconcilePending(
    jobId: string, route: AuthenticatedTransferRoute,
  ): Promise<TransferCheckpoint> {
    const old = await this.inspect(jobId, route);
    if (!old.pending || !['unknown', 'awaiting_ack'].includes(old.status)) {
      return deny('TRANSFER_NOT_RECONCILABLE', 'No pending chunk can be reconciled.');
    }
    // Do not trust an ACK or an Agent-provided declaration as independent
    // evidence: readback must be supplied by an authorized destination source.
    const observed = await this.readback(old.binding, old.pending);
    const pending = old.pending;
    if (observed.kind !== 'verified' ||
        observed.deviceId !== old.binding.destinationDeviceId ||
        observed.offset !== pending.offset ||
        observed.length !== pending.length ||
        observed.sha256 !== pending.sha256) {
      // Make the result explicitly UNKNOWN, never re-dispatch automatically.
      if (old.status === 'unknown') return old;
      return this.save(old, { ...old, status: 'unknown' }, route);
    }
    const offset = pending.offset + pending.length;
    return this.save(old, {
      ...old, offset,
      status: offset === old.binding.totalBytes ? 'verified' : 'ready',
      pending: undefined,
    }, route);
  }

  /** Cancellation with an uncertain write retains an operator-visible
   * pending-cancel tombstone and neither retries nor deletes the stage. */
  async cancel(jobId: string, route: AuthenticatedTransferRoute): Promise<TransferCheckpoint> {
    const old = await this.inspect(jobId, route);
    if (old.status === 'complete' || old.status === 'cancelled' ||
        old.status === 'cancel_pending') return old;
    return this.save(old, {
      ...old, status: old.pending ? 'cancel_pending' : 'cancelled',
    }, route);
  }

  /** Publication belongs to #08; caller text can never certify completion.
   * This method requires an independently authenticated destination reader. */
  async confirmPublished(jobId: string, route: AuthenticatedTransferRoute): Promise<TransferCheckpoint> {
    const old = await this.inspect(jobId, route);
    if (old.status !== 'verified' || old.pending || old.offset !== old.binding.totalBytes ||
        !this.publishedReadback) {
      return deny('TRANSFER_PUBLISH_UNVERIFIED', 'Published artifact attestation is unavailable.');
    }
    const attested = await this.publishedReadback(old.binding);
    if (attested.kind !== 'verified' ||
        attested.deviceId !== old.binding.destinationDeviceId ||
        attested.size !== old.binding.totalBytes ||
        attested.sha256 !== old.binding.sourceSha256) {
      return deny('TRANSFER_PUBLISH_UNVERIFIED', 'Trusted publication readback did not match.');
    }
    return this.save(old, { ...old, status: 'complete' }, route);
  }
}
