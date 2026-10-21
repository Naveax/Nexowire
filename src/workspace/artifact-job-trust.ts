import type { TransferJob } from '../mcp/cross-device-transfer-jobs.js';

/** #587: MUST be served by rollback-independent monotonic CAS.
 * A local SQLite file, PID lock, or another folder is NOT a trust root.
 * Only trusted Hub bootstrap may inject it; no MCP tool argument may set it.
 */
export interface TrustedTransferAuthority {
  acquire(binding: Readonly<TransferJob>, mode: 'new' | 'resume'): Promise<{
    epoch: number; token: string;
  }>;
  assertCurrent(binding: Readonly<TransferJob>, proof: Readonly<{
    epoch: number; token: string;
  }>, stage: 'WRITE' | 'PUBLISH', expectedOffset: number): Promise<void>;
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
