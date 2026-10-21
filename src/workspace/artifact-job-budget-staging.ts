import { createHash } from 'node:crypto';
import { StagingArtifactByteBudget } from '../ops/scale-v2-artifact-byte-budget-staging.js';
import type { TransferJob } from '../mcp/cross-device-transfer-jobs.js';

/** Trusted server-side only, for staging acceptance of #601.
 * This DOES NOT itself attest physical file deletion or stop writers.
 * Never accept "writersStoppedVerified" or "durableDeletionVerified" from MCP input.
 */
export interface VerifiedWriterDeletion {
  attest(job: Readonly<TransferJob>): Promise<{
    durableDeletionVerified: true; writersStoppedVerified: true;
  }>;
}
const scope = (job: Readonly<TransferJob>) => {
  const digest = (label: string, text: string) => createHash('sha256')
    .update(label).update('\0').update(text).digest('hex');
  return {
    ownerId: digest('owner', job.accountId),
    deviceId: digest('device', job.sourceDeviceId + '\0' + job.targetDeviceId),
    projectId: digest('project', job.projectId),
    sessionId: job.id,
  };
};
export class StagingJobBudgetGate {
  constructor(
    private readonly budget: StagingArtifactByteBudget,
    private readonly readFreeBytes: () => Promise<number>,
    private readonly trustedNow: () => Date,
    private readonly deleted: VerifiedWriterDeletion | undefined = undefined,
  ) {}
  async reserve(job: Readonly<TransferJob>): Promise<void> {
    const result = this.budget.begin({
      ...scope(job), rootInvocationId: job.id,
      sizeBytes: job.bytesTotal, sourceSha256: job.sha256,
      physicalFreeBytes: await this.readFreeBytes(), now: this.trustedNow(),
    });
    if (result !== 'RESERVED' && result !== 'ALREADY_RESERVED') {
      throw new Error('BUDGET_FAIL_CLOSED_' + result);
    }
  }
  /** Requires exact #601 CAS offset; no release/refund on cancellation alone. */
  async cancel(job: Readonly<TransferJob>): Promise<void> {
    const outcome = this.budget.requestCancel({
      ...scope(job), expectedOffsetBytes: job.bytesConfirmed,
    });
    if (outcome !== 'CANCEL_PENDING' && outcome !== 'ALREADY_CANCEL_PENDING') {
      throw new Error('BUDGET_FAIL_CLOSED_' + outcome);
    }
  }
  /** Never called automatically during cancellation. Only a trusted operator
   * may invoke it once a fenced writer AND physical deletion are both verified.
   */
  async acknowledgeVerifiedDeletion(job: Readonly<TransferJob>): Promise<void> {
    if (!this.deleted) throw new Error('TRUSTED_WRITER_DELETION_UNAVAILABLE');
    const proof = await this.deleted.attest(job);
    if (proof.durableDeletionVerified !== true || proof.writersStoppedVerified !== true) {
      throw new Error('WRITER_FENCE_REQUIRED');
    }
    const result = this.budget.acknowledgeDeletion({
      ...scope(job), durableDeletionVerified: true, writersStoppedVerified: true,
    });
    if (result !== 'RELEASED') throw new Error('BUDGET_FAIL_CLOSED_' + result);
  }
}
