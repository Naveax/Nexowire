import { ArtifactBridgeError, type ArtifactBridgeStore, type ArtifactScope
} from './artifact-bridge.js';
import type { TransferJob } from '../mcp/cross-device-transfer-jobs.js';
import type { TrustedTransferCoreGrants } from './artifact-job-trust.js';

/** Transfer status is NOT evidence of a Hub content-addressed artifact.
 * #605 Connection continuity is a separate DRAFT and not a trusted checkpoint
 * store. This adapter saves a cross-chat checkpoint only after re-reading the
 * scoped artifact manifest and verifying exact provenance, digest and length.
 */
export class VerifiedTransferCheckpointAdapter {
  constructor(private readonly store: ArtifactBridgeStore,
    private readonly grants: TrustedTransferCoreGrants) {}
  private async current(scope: ArtifactScope, job: Readonly<TransferJob>): Promise<void> {
    if (!this.grants) throw new ArtifactBridgeError('CORE_GRANT_AUTHORITY_REQUIRED',
      'Live owner CORE grant authority is unavailable.');
    if (scope.accountId !== job.accountId || scope.projectId !== job.projectId ||
        scope.deviceId !== job.targetDeviceId) {
      throw new ArtifactBridgeError('JOB_SCOPE_MISMATCH', 'Checkpoint owner, device or project differ.');
    }
    await this.grants.assertCurrent(job, 'STATUS');
  }
  /** Authorized new-chat retrieval, not automatic access to old attachments. */
  async get(scope: ArtifactScope, workspaceId: string, job: Readonly<TransferJob>) {
    await this.current(scope, job);
    const checkpoint = await this.store.getCheckpoint(scope, workspaceId);
    await this.current(scope, job);
    return checkpoint;
  }
  async persist(input: {
    scope: ArtifactScope; job: Readonly<TransferJob>;
    workspaceId: string; artifactPath: string;
    repository: string; commitSha: string;
  }) {
    const { job, scope } = input;
    if (job.state !== 'COMPLETED' || job.bytesConfirmed !== job.bytesTotal) {
      throw new ArtifactBridgeError('JOB_NOT_VERIFIED', 'A remote job status is not verified artifact proof.');
    }
    if (scope.accountId !== job.accountId || scope.projectId !== job.projectId ||
        scope.deviceId !== job.targetDeviceId) {
      throw new ArtifactBridgeError('JOB_SCOPE_MISMATCH', 'Checkpoint cannot cross owner/project/device scope.');
    }
    await this.current(scope, job);
    const manifest = await this.store.get(scope, input.artifactPath);
    if (!manifest || manifest.sha256 !== job.sha256 ||
        manifest.size !== job.bytesTotal || manifest.repository !== input.repository ||
        manifest.commitSha !== input.commitSha) {
      throw new ArtifactBridgeError('JOB_ARTIFACT_ATTESTATION_MISSING',
        'Remote status alone cannot certify a Hub artifact or repository commit.');
    }
    await this.current(scope, job);
    return this.store.saveCheckpoint({
      scope, workspaceId: input.workspaceId, repository: input.repository,
      commitSha: input.commitSha,
      summary: 'Cross-device transfer is independently attested by the Artifact Bridge manifest.',
      completed: ['Artifact SHA-256 and scope verified'],
      remaining: ['Physical/staging acceptance remains independent of source verification'],
      lastCommands: [], artifactPaths: [input.artifactPath],
    });
  }
}
