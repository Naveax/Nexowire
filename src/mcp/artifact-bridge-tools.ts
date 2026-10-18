import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { authorizationGrant, type BearerAuthorization } from '../security/auth.js';
import { ArtifactBridgeError, type ArtifactScope } from '../workspace/artifact-bridge.js';
import { ArtifactCheckpointAdapter } from '../workspace/artifact-checkpoint-adapter.js';
import { ingestDeviceArtifact, type ArtifactSourceOps } from './artifact-bridge-device-ingest.js';
import type { WorkspaceStore } from '../workspace/store.js';

// Authentication derives account identity from a verified bearer grant, NEVER from tool input.
export function artifactPrincipal(auth: BearerAuthorization | undefined, deviceId: string): string {
  if (!auth || auth.kind === 'static') {
    throw new ArtifactBridgeError('AUTH_ACCOUNT_REQUIRED', 'Account-bound authenticated MCP identity is required.');
  }
  if (!(authorizationGrant(auth)?.allowedDeviceIds ?? []).includes(deviceId)) {
    throw new ArtifactBridgeError('DEVICE_NOT_AUTHORIZED', 'Device is outside the authenticated device grant.');
  }
  if (auth.kind === 'control-plane') return 'account:' + auth.accountId;
  if (auth.kind === 'stored') return 'credential:' + auth.credential.id;
  return 'oidc:' + createHash('sha256')
    .update(auth.identity.issuer).update('\0').update(auth.identity.subject).digest('hex');
}
function result(value: unknown, error = false) {
  const obj = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
    structuredContent: obj,
    ...(error ? { isError: true } : {}),
  };
}
async function wrap<T>(work: () => Promise<T>) {
  try { return result({ ok: true, data: await work() }); }
  catch (e) {
    const err = e instanceof Error ? e : new Error('Artifact bridge operation failed.');
    return result({ ok: false, error: {
      code: e instanceof ArtifactBridgeError ? e.code : 'ARTIFACT_BRIDGE_ERROR',
      message: e instanceof z.ZodError ? 'Artifact input failed validation.' : err.message,
    } }, true);
  }
}
const id = z.string().min(1).max(128);
const projectId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
const path = z.string().min(1).max(1024);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const common = { device_id: id, project_id: projectId };
function scope(auth: BearerAuthorization | undefined, deviceId: string, project: string): ArtifactScope {
  return { accountId: artifactPrincipal(auth, deviceId), projectId: project, deviceId };
}
export function registerArtifactBridgeTools(
  server: McpServer,
  workspaces: WorkspaceStore,
  auth: BearerAuthorization | undefined,
  sourceFromDevice?: (deviceId: string) => ArtifactSourceOps,
): void {
  const bridge = workspaces.artifactBridge();
  const adapter = new ArtifactCheckpointAdapter(workspaces, bridge);
  server.registerTool('artifact_bridge_begin', {
    title: 'Begin or resume verified project artifact',
    description: 'Account/device/project-scoped, resumable content-addressed staging; rejects unsafe overwrites.',
    inputSchema: {
      ...common, artifact_path: path, repository: z.string().min(1).max(512),
      commit_sha: commit, operation_id: id, size: z.number().int().min(0).max(268_435_456),
      sha256: sha, test_status: z.enum(['unverified', 'passed', 'failed']).default('unverified'),
      acceptance_status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
      expected_previous_sha256: sha.optional(),
    },
  }, async (a) => wrap(() => bridge.begin({
    scope: scope(auth, a.device_id, a.project_id), artifactPath: a.artifact_path,
    repository: a.repository, commitSha: a.commit_sha, producerOperationId: a.operation_id,
    size: a.size, sha256: a.sha256, testStatus: a.test_status,
    acceptanceStatus: a.acceptance_status,
    ...(a.expected_previous_sha256 ? { expectedPreviousSha256: a.expected_previous_sha256 } : {}),
  })));
  server.registerTool('artifact_bridge_ingest_device_file', {
    title: 'Transfer an Agent file directly into verified project artifact storage',
    description: 'Bounded server-side pull using permitted files.stat/hash/read. No file content is exposed to the tool result; repeat to resume.',
    inputSchema: {
      ...common, source_path: z.string().min(1).max(4096),
      artifact_path: path, repository: z.string().min(1).max(512),
      commit_sha: commit, operation_id: id,
      test_status: z.enum(['unverified', 'passed', 'failed']).default('unverified'),
      acceptance_status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
      expected_previous_sha256: sha.optional(),
      max_chunks: z.number().int().min(1).max(32).default(16),
    },
  }, async (a) => wrap(async () => {
    const scoped = scope(auth, a.device_id, a.project_id);
    if (!sourceFromDevice) {
      throw new ArtifactBridgeError('INGEST_BACKEND_UNAVAILABLE', 'Agent reader has not been configured.');
    }
    return ingestDeviceArtifact(bridge, sourceFromDevice(a.device_id), {
      scope: scoped, sourcePath: a.source_path, artifactPath: a.artifact_path,
      repository: a.repository, commitSha: a.commit_sha,
      producerOperationId: a.operation_id,
      testStatus: a.test_status, acceptanceStatus: a.acceptance_status,
      maxChunks: a.max_chunks,
      ...(a.expected_previous_sha256 ? {
        expectedPreviousSha256: a.expected_previous_sha256,
      } : {}),
    });
  }));
  server.registerTool('artifact_bridge_put_chunk', {
    title: 'Append verified artifact chunk',
    description: 'Write a 64-KiB-or-smaller Base64 chunk at the exact persisted byte offset.',
    inputSchema: { ...common, session_id: sha, offset_bytes: z.number().int().min(0),
      content_base64: z.string().max(87384) },
  }, async (a) => wrap(() => bridge.putChunk(
    scope(auth, a.device_id, a.project_id), a.session_id, a.offset_bytes, a.content_base64,
  )));
  server.registerTool('artifact_bridge_commit', {
    title: 'Verify and commit staged artifact',
    description: 'SHA-256 verification plus compare-and-swap manifest publication.',
    inputSchema: { ...common, session_id: sha },
  }, async (a) => wrap(() => bridge.commit(
    scope(auth, a.device_id, a.project_id), a.session_id,
  )));
  server.registerTool('artifact_bridge_get', {
    title: 'Fetch verified artifact manifest',
    description: 'Fail closed if the content is absent, corrupt, or outside authorized scope.',
    inputSchema: { ...common, artifact_path: path },
  }, async (a) => wrap(() => bridge.get(scope(auth, a.device_id, a.project_id), a.artifact_path)));
  server.registerTool('artifact_bridge_list', {
    title: 'List verified project artifacts',
    description: 'Enumerate only the authenticated account, requested project and permitted device.',
    inputSchema: { ...common },
  }, async (a) => wrap(() => bridge.list(scope(auth, a.device_id, a.project_id))));
  server.registerTool('artifact_bridge_read_chunk', {
    title: 'Read verified artifact content chunk',
    description: 'Retrieve bounded Base64 bytes with both chunk SHA-256 and complete object SHA-256.',
    inputSchema: { ...common, artifact_path: path, offset_bytes: z.number().int().min(0),
      max_bytes: z.number().int().min(1).max(65536).optional() },
  }, async (a) => wrap(() => bridge.readChunk(
    scope(auth, a.device_id, a.project_id), a.artifact_path, a.offset_bytes, a.max_bytes,
  )));
  server.registerTool('artifact_bridge_checkpoint_import', {
    title: 'Import authorized legacy workspace checkpoint',
    description: 'Explicitly copy an existing device/workspace checkpoint into scoped project history.',
    inputSchema: { ...common, workspace_id: id, repository: z.string().min(1).max(512),
      commit_sha: commit, artifact_paths: z.array(path).max(128).default([]) },
  }, async (a) => wrap(() => adapter.importLegacy({
    scope: scope(auth, a.device_id, a.project_id), workspaceId: a.workspace_id,
    repository: a.repository, commitSha: a.commit_sha, artifactPaths: a.artifact_paths,
  })));
  server.registerTool('artifact_bridge_checkpoint_get', {
    title: 'Retrieve verified project checkpoint',
    description: 'Load a project checkpoint only after rechecking all referenced artifact digests.',
    inputSchema: { ...common, workspace_id: id },
  }, async (a) => wrap(() => adapter.get(
    scope(auth, a.device_id, a.project_id), a.workspace_id,
  )));
  server.registerTool('artifact_bridge_checkpoint_list', {
    title: 'Find project checkpoints across chats',
    description: 'List persistent checkpoints within authenticated account/project/device scope.',
    inputSchema: { ...common },
  }, async (a) => wrap(() => adapter.list(scope(auth, a.device_id, a.project_id))));
}
