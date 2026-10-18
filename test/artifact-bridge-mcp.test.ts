import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { BearerAuthorization } from '../src/security/auth.js';

const owner: BearerAuthorization = {
  kind: 'control-plane', scope: 'mcp', accountId: 'owner-bridge',
  role: 'admin', allowedDeviceIds: ['device-A'],
};
const request = { device_id: 'device-A', project_id: 'Nexowire' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture(auth: BearerAuthorization | undefined, run: (client: Client, ws: WorkspaceStore) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-bridge-mcp-'));
  const workspaces = new WorkspaceStore(dir);
  const server = createNexowireMcpServer({
    broker: new AgentBroker(), providers: new ProviderRegistry(),
    workspaces, skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
    ...(auth ? { toolAuthorization: auth } : {}),
  });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(s), client.connect(c)]);
    await run(client, workspaces);
  } finally {
    await client.close(); await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function data(response: Awaited<ReturnType<Client['callTool']>>) {
  return response.structuredContent as Record<string, unknown>;
}
test('MCP bridge round-trip uses account-scoped permanent store, with checkpoint retrieval', async () =>
  fixture(owner, async (client, workspaces) => {
    const available = (await client.listTools()).tools.map(x => x.name);
    assert.ok(available.includes('artifact_bridge_begin'));
    assert.ok(available.includes('artifact_bridge_checkpoint_list'));
    const b = Buffer.from('verified artifact from chat 1');
    const input = {
      ...request, artifact_path: 'results/log.txt', repository: 'Naveax/Nexowire',
      commit_sha: '8bf7ce10972e78268e3cac945e833781b8d6846c',
      operation_id: 'test-artifact-01', size: b.length, sha256: sha(b),
    };
    const began = data(await client.callTool({ name: 'artifact_bridge_begin', arguments: input }));
    assert.equal(began.ok, true);
    const session = (began.data as { sessionId: string }).sessionId;
    const uploaded = data(await client.callTool({ name: 'artifact_bridge_put_chunk',
      arguments: { ...request, session_id: session, offset_bytes: 0, content_base64: b.toString('base64') } }));
    assert.equal(uploaded.ok, true);
    const committed = data(await client.callTool({ name: 'artifact_bridge_commit',
      arguments: { ...request, session_id: session } }));
    assert.equal(committed.ok, true);
    const content = data(await client.callTool({ name: 'artifact_bridge_read_chunk',
      arguments: { ...request, artifact_path: 'results/log.txt', offset_bytes: 0 } }));
    assert.deepEqual(Buffer.from((content.data as { contentBase64: string }).contentBase64, 'base64'), b);
    await workspaces.save({ deviceId: 'device-A', workspaceId: 'bridge-session-1', summary: 'new source',
      completed: ['code'], remaining: ['review'], lastCommands: ['npm run typecheck'] });
    const adopted = data(await client.callTool({ name: 'artifact_bridge_checkpoint_import', arguments: {
      ...request, workspace_id: 'bridge-session-1', repository: 'Naveax/Nexowire',
      commit_sha: input.commit_sha, artifact_paths: ['results/log.txt'],
    } }));
    assert.equal(adopted.ok, true);
    const checkpoints = data(await client.callTool({ name: 'artifact_bridge_checkpoint_list',
      arguments: request }));
    assert.equal((checkpoints.data as unknown[]).length, 1);
  }));
test('MCP bridge denies unpermitted device regardless of attacker supplied scope', async () =>
  fixture(owner, async client => {
    const denied = data(await client.callTool({ name: 'artifact_bridge_list',
      arguments: { device_id: 'device-FOREIGN', project_id: 'Nexowire' } }));
    assert.equal(denied.ok, false);
    assert.equal((denied.error as { code: string }).code, 'DEVICE_NOT_AUTHORIZED');
  }));
test('MCP bridge rejects static auth with no stable account identity', async () =>
  fixture({ kind: 'static', scope: 'mcp' }, async client => {
    const denied = data(await client.callTool({ name: 'artifact_bridge_list', arguments: request }));
    assert.equal(denied.ok, false);
    assert.equal((denied.error as { code: string }).code, 'AUTH_ACCOUNT_REQUIRED');
  }));
test('MCP per-credential allowedTools hides the bridge if not granted', async () =>
  fixture({ kind: 'stored', scope: 'mcp', credential: {
    id: 'credential0001', scope: 'mcp', createdAt: '2026-10-01T00:00:00Z',
    allowedTools: ['file_read'], allowedDeviceIds: ['device-A'],
  } }, async client => {
    assert.equal((await client.listTools()).tools.some(t => t.name.startsWith('artifact_bridge_')), false);
  }));
test('composite native pull is hidden unless read/stat/hash grants are all present', async () => {
  const createAuth = (allow: string[]): BearerAuthorization => ({
    kind: 'stored', scope: 'mcp', credential: {
      id: 'credential-pull', scope: 'mcp', createdAt: '2026-10-18T00:00:00Z',
      allowedTools: allow, allowedDeviceIds: ['device-A'],
    },
  });
  await fixture(createAuth(['artifact_bridge_ingest_device_file']), async client => {
    assert.equal((await client.listTools()).tools.some(t => t.name ===
      'artifact_bridge_ingest_device_file'), false);
  });
  await fixture(createAuth(['artifact_bridge_ingest_device_file', 'file_read',
    'file_stat', 'file_hash']), async client => {
    assert.equal((await client.listTools()).tools.some(t => t.name ===
      'artifact_bridge_ingest_device_file'), true);
  });
});
