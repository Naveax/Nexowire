import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { ArtifactBridgeError } from '../workspace/artifact-bridge.js';
import type { WorkspaceStore } from '../workspace/store.js';
import type { BearerAuthorization } from '../security/auth.js';
import { artifactPrincipal } from './artifact-bridge-tools.js';
import { TransferTrustError, type TrustedTransferAuthority,
  type TrustedTransferCoreGrants, type TrustedFinalReceiptVerifier
} from '../workspace/artifact-job-trust.js';
import { CrossDeviceTransferJobs, TransferJobError,
  type TransferRemote } from './cross-device-transfer-jobs.js';

const id = z.string().min(1).max(128);
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
const file = z.string().min(1).max(4000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
function result(data: unknown, error = false) {
  const envelope = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown> : { value: data };
  return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope, ...(error ? { isError: true } : {}) };
}
async function wrap<T>(fn: () => Promise<T>) {
  try { return result({ ok: true, data: await fn() }); }
  catch (e) {
    const code = e instanceof TransferJobError || e instanceof ArtifactBridgeError || e instanceof TransferTrustError
      ? e.code : 'TRANSFER_UNAVAILABLE';
    return result({ ok: false, error: { code,
      message: e instanceof Error ? e.message : 'Transfer operation failed.' } }, true);
  }
}
export function registerCrossDeviceTransferJobTools(
  server: McpServer, workspaces: WorkspaceStore,
  auth: BearerAuthorization | undefined,
  remote: TransferRemote,
  authority?: TrustedTransferAuthority,
  grants?: TrustedTransferCoreGrants,
  finalReceiptVerifier?: TrustedFinalReceiptVerifier,
): void {
  // No external trust root = no hosted file mutation. It is deliberately
  // impossible for client JSON to supply the authority.
  const jobs = new CrossDeviceTransferJobs(workspaces.transferJobsDirectory(), remote,
    { requireExternalAuthority: true, authority, grants,
      requireAuthenticatedFinalReceipt: true, finalReceiptVerifier });
  const principal = (source: string, target: string) => {
    const src = artifactPrincipal(auth, source);
    const dst = artifactPrincipal(auth, target);
    if (src !== dst) throw new TransferJobError('TRANSFER_SCOPE_DENIED', 'Different account principals.');
    return src;
  };
  server.registerTool('artifact_bridge_transfer_start', {
    title: 'Start or explicitly resume durable cross-device file transfer',
    description: 'ONE bounded MCP command starts a Hub-side worker. No inline file payload; 64 KiB Agent chunks, SHA verification, durable progress and no-overwrite publication. For recovery use resume_transfer_id after inspecting status.',
    inputSchema: {
      source_device_id: id, source_path: file, target_device_id: id, target_path: file,
      project_id: name.optional(), expected_source_sha256: sha.optional(),
      resume_transfer_id: z.string().uuid().optional(),
    },
  }, async (a) => wrap(() => jobs.start({
    accountId: principal(a.source_device_id, a.target_device_id),
    projectId: a.project_id ?? 'default',
    sourceDeviceId: a.source_device_id, sourcePath: a.source_path,
    targetDeviceId: a.target_device_id, targetPath: a.target_path,
    ...(a.expected_source_sha256 ? { expectedSourceSha256: a.expected_source_sha256 } : {}),
    ...(a.resume_transfer_id ? { resumeTransferId: a.resume_transfer_id } : {}),
  })));
  server.registerTool('artifact_bridge_transfer_status', {
    title: 'Get durable transfer status without reading user files',
    description: 'Account- and two-device-scoped status, including byte offset and full-file digest.',
    inputSchema: { transfer_id: z.string().uuid() },
  }, async (a) => wrap(async () => {
    const meta = await jobs.identity(a.transfer_id);
    const account = principal(meta.sourceDeviceId, meta.targetDeviceId);
    return jobs.status(a.transfer_id, account, meta.sourceDeviceId, meta.targetDeviceId);
  }));
  server.registerTool('artifact_bridge_transfer_cancel', {
    title: 'Cancel scoped unfinished cross-device transfer',
    description: 'Stops new chunks; retained staging is quarantined for operator review. Never deletes or replaces destination data.',
    inputSchema: { transfer_id: z.string().uuid() },
  }, async (a) => wrap(async () => {
    const meta = await jobs.identity(a.transfer_id);
    const account = principal(meta.sourceDeviceId, meta.targetDeviceId);
    return jobs.cancel(a.transfer_id, account, meta.sourceDeviceId, meta.targetDeviceId);
  }));
}
