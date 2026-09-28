import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AuditLog } from '../src/audit/log.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { attachAgentWebSocketServer } from '../src/hub/agent-websocket.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

test('MCP request reaches a native agent through the provider registry', async (t) => {
  const http = createServer();
  const broker = new AgentBroker();
  const wss = attachAgentWebSocketServer(http, broker, 'integration-token');
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-mcp-'));
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const audit = new AuditLog(path.join(stateDir, 'audit.jsonl'));

  const mcp = createNexowireMcpServer({
    providers,
    audit,
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({ name: 'nexowire-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  t.after(async () => {
    await client.close();
    await mcp.close();
    for (const ws of wss.clients) ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const agent = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
    headers: { Authorization: 'Bearer integration-token' },
  });
  await new Promise<void>((resolve, reject) => {
    agent.once('open', resolve);
    agent.once('error', reject);
  });

  agent.send(JSON.stringify({
    type: 'hello',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    device: {
      id: 'mcp-device',
      name: 'MCP Integration Device',
      platform: process.platform,
      arch: process.arch,
      agentVersion: 'integration-test',
      capabilities: ['machine.snapshot'],
    },
  }));

  agent.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as {
      type: string;
      requestId: string;
      capability: string;
    };
    if (request.type !== 'request') return;
    agent.send(JSON.stringify({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      data: {
        data: {
          hostname: 'mcp-e2e-host',
          capability: request.capability,
        },
      },
    }));
  });

  for (let i = 0; i < 100 && !broker.has('mcp-device'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.has('mcp-device'), true);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'machine_snapshot'));
  assert.ok(tools.tools.some((tool) => tool.name === 'process_start'));

  const result = await client.callTool({
    name: 'machine_snapshot',
    arguments: { device_id: 'mcp-device' },
  });

  assert.equal('isError' in result ? result.isError : false, false);
  assert.ok('structuredContent' in result);
  const structured = result.structuredContent as {
    ok?: boolean;
    data?: { hostname?: string; capability?: string };
    meta?: { providerId?: string; targetId?: string; requestId?: string };
  };
  assert.equal(structured.ok, true);
  assert.equal(structured.data?.hostname, 'mcp-e2e-host');
  assert.equal(structured.data?.capability, 'machine.snapshot');
  assert.equal(structured.meta?.providerId, 'native-agent');
  assert.equal(structured.meta?.targetId, 'mcp-device');
  assert.match(structured.meta?.requestId ?? '', /^[0-9a-f-]{36}$/i);

  const auditResult = await client.callTool({
    name: 'audit_recent',
    arguments: { limit: 10 },
  });
  assert.ok('structuredContent' in auditResult);
  const auditContent = auditResult.structuredContent as {
    events?: Array<{ operationId: string; status: string; capability: string }>;
  };
  const operationEvents = (auditContent.events ?? []).filter(
    (event) => event.operationId === structured.meta?.requestId,
  );
  assert.deepEqual(
    operationEvents.map((event) => event.status).sort(),
    ['started', 'succeeded'],
  );
  assert.ok(operationEvents.every((event) => event.capability === 'machine.snapshot'));

  agent.close();
});
