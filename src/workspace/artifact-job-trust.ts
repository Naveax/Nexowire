import type { TransferJob } from '../mcp/cross-device-transfer-jobs.js';

export type TransferMutationStage = 'START' | 'RESUME' | 'WRITE' | 'PUBLISH' | 'STATUS' | 'CANCEL';
/** Authoritative *current* CORE delegation, never a cached mode preference.
 * Owner + both devices + project must be checked against the trusted grant
 * store on each transition, including after a potentially lost ACK.
 */
export interface TrustedTransferCoreGrants {
  assertCurrent(job: Readonly<TransferJob>, stage: TransferMutationStage): Promise<void>;
}
export interface FencedWriteEnvelope {
  requestId: string; epoch: number; token: string;
  offset: number; length: number; sha256: string;
}
export interface FencedWriteReceipt {
  requestId: string; epoch: number; offset: number;
  length: number; sha256: string;
}


/** Receipt is only a CLAIM until independently authenticated against the
 * protected Native publisher. The caller and Hub worker cannot assert it.
 */
export interface FencedFinalReceipt {
  requestId: string;
  jobId: string; accountId: string; projectId: string;
  targetDeviceId: string; targetPath: string;
  bytesTotal: number; sha256: string; epoch: number;
  /** Opaque signed attestation, verified outside the Agent ACK channel. */
  proof: string;
}
export interface TrustedFinalReceiptVerifier {
  verify(job: Readonly<TransferJob>, receipt: Readonly<FencedFinalReceipt>): Promise<boolean>;
}

/** #587: MUST be served by rollback-independent monotonic CAS.
 * A local SQLite file, PID lock, or another folder is NOT a trust root.
 * Only trusted Hub bootstrap may inject it; no MCP tool argument may set it.
 */
/** Authoritative #587 anti-rollback publication commit. Must be persisted by
 * a separate monotonic service with CURRENT owner/CORE grant and exact Native
 * signed proof as one atomic conditional operation. A local WAL flag is not a
 * valid implementation; a void ACK cannot supply durableCommitId.
 */
export interface TrustedPublicationCommit {
  jobId: string; requestId: string; epoch: number; sha256: string;
  durableCommitId: string;
}
export interface TrustedTransferAuthority {
  acquire(binding: Readonly<TransferJob>, mode: 'new' | 'resume'): Promise<{
    epoch: number; token: string;
  }>;
  assertCurrent(binding: Readonly<TransferJob>, proof: Readonly<{
    epoch: number; token: string;
  }>, stage: 'WRITE' | 'PUBLISH', expectedOffset: number): Promise<void>;
  /** Optional in legacy isolated tests, REQUIRED by strict hosted transfers.
   * The independent service MUST atomically assert current monotonic epoch,
   * protected owner grant and one-time signed Native publication requestId.
   */
  commitPublished?(job: Readonly<TransferJob>, signedReceipt: Readonly<FencedFinalReceipt>):
    Promise<TrustedPublicationCommit>;
}

export class TransferTrustError extends Error {
  constructor(readonly code: string, message: string) {
    super(message); this.name = 'TransferTrustError';
  }
}
export function requireTrustedAuthority(
  authority: TrustedTransferAuthority | undefined,
): asserts authority is TrustedTransferAuthority {
  if (!authority) throw new TransferTrustError('EXTERNAL_AUTHORITY_REQUIRED',
    'No rollback-independent authority or multi-Hub fencing proof is configured.');
}
export function requireMonotonicLease(
  proof: { epoch: number; token: string } | undefined,
): asserts proof is { epoch: number; token: string } {
  if (!proof || !Number.isSafeInteger(proof.epoch) || proof.epoch < 1 ||
      typeof proof.token !== 'string' || proof.token.length < 32 ||
      proof.token.length > 256) {
    throw new TransferTrustError('TRUSTED_LEASE_INVALID',
      'Missing verifiable independent monotonic lease.');
  }
}

/** Trusted-only Native/OS dispatch provider. Real Agent 1.0.5 does not
 * implement atomic epoch fencing; production MUST leave this unset.
 */
export interface TrustedNativeTransferWriter {
  writeFenced(job: Readonly<TransferJob>, envelope: Readonly<FencedWriteEnvelope>,
    contentBase64: string, createExclusive: boolean): Promise<FencedWriteReceipt>;
  publishFenced(job: Readonly<TransferJob>, epoch: number, token: string,
    requestId?: string): Promise<FencedFinalReceipt | void>;
}
