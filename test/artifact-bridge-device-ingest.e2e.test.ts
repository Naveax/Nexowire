import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('loopback WebSocket Agent -> Hub artifact ingest resumes across MCP calls with no Base64 response', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-wss-ingest-'));
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(sourceRoot);
  const content = Buffer.alloc(205_001);
  for (let i = 0; i < content.length; i++) content[i] = i % 243;
  const sourceFile = path.join(sourceRoot, 'proof.bin');
  await fs.writeFile(sourceFile, content);
  const server = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(server, broker, 'synthetic-fixture-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = new ProviderRegistry();
  registry.register(new AgentProvider(broker));
  const workspaces = new WorkspaceStore(path.join(root, 'hub-state'));
  const mcp = createNexowireMcpServer({
    broker, providers: registry, workspaces,
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
    toolAuthorization: { kind: 'control-plane', scope: 'mcp', accountId: 'authorized-owner',
      role: 'admin', allowedDeviceIds: ['test-source'] },
  });
  const client = new Client({ name: 'ingest-e2e', version: '1.0.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(s), client.connect(c)]);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const ws = new WebSocket('ws://127.0.0.1:' + address.port + '/agent', {
    headers: { Authorization: 'Bearer synthetic-fixture-token' },
  });
  let sourceReads = 0;
  t.after(async () => {
    await client.close();
    await mcp.close();
    ws.close();
    for (const socket of wss.clients) socket.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve); ws.once('error', reject);
  });
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString()) as {
      type: string; requestId: string; capability: string; input: unknown;
    };
    if (msg.type !== 'request') return;
    if (msg.capability === 'files.read') sourceReads++;
    void (async () => {
      try {
        const response = await executeCapability(msg.capability, msg.input,
          new PathPolicy([sourceRoot]));
        ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId,
          ok: true, data: response }));
      } catch (error) {
        ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: false,
          error: { code: 'TEST_REJECTED', message: error instanceof Error ? error.message : 'denied' } }));
      }
    })();
  });
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: AGENT_PROTOCOL_VERSION,
    instanceId: '77777777-7777-4777-8777-777777777777',
    device: { id: 'test-source', name: 'test-source', platform: process.platform,
      arch: process.arch, agentVersion: 'test', capabilities:
      ['files.stat', 'files.hash', 'files.read'] } }));
  for (let i = 0; i < 100 && !broker.has('test-source'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(broker.has('test-source'));
  const allTools = await client.listTools();
  assert.ok(allTools.tools.some(tool => tool.name === 'artifact_bridge_ingest_device_file'));
  const args = { device_id: 'test-source', project_id: 'Nexowire',
    source_path: sourceFile, artifact_path: 'e2e/proof.bin',
    repository: 'Naveax/Nexowire', commit_sha: '3927c61b6893a8d4397bfbc76ff6fcdf87393fc1',
    operation_id: 'wss-proof', max_chunks: 2 };
  const denied = await client.callTool({ name: 'artifact_bridge_ingest_device_file',
    arguments: { ...args, device_id: 'foreign' } });
  assert.equal((denied.structuredContent as {ok:boolean}).ok, false);
  assert.equal(sourceReads, 0, 'unauthorized device must be denied before any Agent read');

  let state = '';
  let calls = 0;
  do {
    const response = await client.callTool({ name: 'artifact_bridge_ingest_device_file', arguments: args });
    const v = response.structuredContent as {
      ok: boolean; data?: {state: string; sha256: string; offset: number};
      error?: {code:string;message:string};
    };
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.ok(v.data);
    state = v.data.state;
    assert.equal(v.data.sha256, createHash('sha256').update(content).digest('hex'));
    calls++;
    assert.doesNotMatch(JSON.stringify(response), /contentBase64|AABBCCDD/);
    assert.ok(calls < 9);
  } while (state === 'PARTIAL');
  assert.equal(state, 'COMPLETE');
  assert.equal(calls, 2);
  assert.equal(sourceReads, 4);
  const forbidden = await client.callTool({
    name: 'artifact_bridge_ingest_device_file',
    arguments: { ...args, source_path: path.join(root, 'outside.bin'),
      artifact_path: 'e2e/outside.bin' },
  });
  assert.equal((forbidden.structuredContent as { ok: boolean }).ok, false);
  assert.equal(sourceReads, 4, 'path-denied source must not disclose content');
  const manifest = await workspaces.artifactBridge().get({
    accountId: 'account:authorized-owner', projectId: 'Nexowire', deviceId: 'test-source',
  }, 'e2e/proof.bin');
  assert.equal(manifest?.size, content.length);
  assert.equal(manifest?.testStatus, 'unverified');
});
