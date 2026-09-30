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
      allowedTools: ['machine_*', 'files_read'],
    },
  });

  assert.ok(tools.includes('machine_snapshot'));
  assert.ok(tools.includes('machine_health'));
  assert.ok(tools.includes('files_read'));

  assert.equal(tools.includes('files_write'), false);
  assert.equal(tools.includes('policy_profile_list'), false);
  assert.equal(tools.includes('device_alias_set'), false);
  assert.equal(tools.includes('browser_session_start'), false);

  assert.ok(
    tools.every(
      (name) =>
        name.startsWith('machine_') ||
        name === 'files_read',
    ),
  );
});

test('static and unscoped stored credentials retain the full MCP surface', async () => {
  const staticTools = await listedTools({
    kind: 'static',
    scope: 'mcp',
  });
  const storedTools = await listedTools({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential5678',
      scope: 'mcp',
      createdAt: '2026-09-30T12:00:00.000Z',
    },
  });

  for (const required of [
    'policy_profile_list',
    'device_alias_set',
    'machine_snapshot',
    'files_write',
    'browser_session_start',
  ]) {
    assert.ok(staticTools.includes(required), required);
    assert.ok(storedTools.includes(required), required);
  }

  assert.deepEqual(storedTools, staticTools);
});
