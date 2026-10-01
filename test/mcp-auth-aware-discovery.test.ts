import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import type { BearerAuthorization } from '../src/security/auth.js';

async function listedTools(
  authorization: BearerAuthorization | undefined,
): Promise<string[]> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-tool-discovery-'),
  );
  const mcp = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    ...(authorization
      ? { toolAuthorization: authorization }
      : {}),
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(
      path.join(process.cwd(), 'skills'),
    ),
  });
  const client = new Client({
    name: 'tool-discovery-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await mcp.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

test('restricted stored MCP credentials only discover authorized tools', async () => {
  const tools = await listedTools({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential1234',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      allowedTools: ['machine_*', 'file_read'],
    },
  });

  assert.ok(tools.includes('machine_snapshot'));
  assert.ok(tools.includes('machine_health'));
  assert.ok(tools.includes('file_read'));

  assert.equal(tools.includes('file_write'), false);
  assert.equal(tools.includes('policy_profile_list'), false);
  assert.equal(tools.includes('device_alias_set'), false);
  assert.equal(tools.includes('browser_session_start'), false);

  assert.ok(
    tools.every(
      (name) =>
        name.startsWith('machine_') ||
        name === 'file_read',
    ),
  );
});

test('auth-aware discovery respects user, operator, admin, and static roles', async () => {
  const staticTools = await listedTools({
    kind: 'static',
    scope: 'mcp',
  });
  const userTools = await listedTools({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential5678',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'user',
    },
  });
  const operatorTools = await listedTools({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credentialoperator',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'operator',
    },
  });
  const adminTools = await listedTools({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credentialadmin',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
      role: 'admin',
    },
  });

  for (const regular of [
    'machine_snapshot',
    'file_write',
    'browser_session_start',
    'devices_list',
    'device_route',
  ]) {
    assert.ok(staticTools.includes(regular), regular);
    assert.ok(userTools.includes(regular), regular);
    assert.ok(operatorTools.includes(regular), regular);
    assert.ok(adminTools.includes(regular), regular);
  }

  for (const operatorTool of [
    'policy_profile_list',
    'policy_device_check',
    'operations_idempotency_list',
    'events_read',
    'audit_query',
  ]) {
    assert.ok(staticTools.includes(operatorTool), operatorTool);
    assert.equal(userTools.includes(operatorTool), false, operatorTool);
    assert.ok(operatorTools.includes(operatorTool), operatorTool);
    assert.ok(adminTools.includes(operatorTool), operatorTool);
  }

  for (const adminTool of [
    'policy_profile_set',
    'device_alias_set',
    'device_group_delete',
    'device_route_policy_set',
  ]) {
    assert.ok(staticTools.includes(adminTool), adminTool);
    assert.equal(userTools.includes(adminTool), false, adminTool);
    assert.equal(operatorTools.includes(adminTool), false, adminTool);
    assert.ok(adminTools.includes(adminTool), adminTool);
  }

  assert.deepEqual(adminTools, staticTools);
});

