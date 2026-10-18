import type { WorkspaceStore } from './store.js';
import { ArtifactBridgeError, type ArtifactBridgeStore, type ArtifactScope } from './artifact-bridge.js';

// Explicit, authorized, one-way adoption of an older device/workspace checkpoint.
// The existing workspace file is never modified. The snapshot is pinned to a
// repository revision and its artifact references are independently verified.
export class ArtifactCheckpointAdapter {
  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly bridge: ArtifactBridgeStore,
  ) {}
  async importLegacy(input: {
    scope: ArtifactScope; workspaceId: string; repository: string;
    commitSha: string; artifactPaths: string[];
  }) {
    const original = await this.workspaces.get(input.scope.deviceId, input.workspaceId);
    if (!original) {
      throw new ArtifactBridgeError('WORKSPACE_NOT_FOUND', 'Original device/workspace checkpoint was not found.');
    }
    return this.bridge.saveCheckpoint({
      scope: input.scope, workspaceId: input.workspaceId,
      repository: input.repository, commitSha: input.commitSha,
      summary: original.summary, completed: original.completed,
      remaining: original.remaining, lastCommands: original.lastCommands,
      artifactPaths: input.artifactPaths,
    });
  }
  async get(scope: ArtifactScope, workspaceId: string) {
    return this.bridge.getCheckpoint(scope, workspaceId);
  }
  async list(scope: ArtifactScope) {
    return this.bridge.listCheckpoints(scope);
  }
}
