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
import {
  MCP_TOOL_CAPABILITY_REQUIREMENTS,
  onlineCapabilityUnion,
  requiredCapabilityForMcpTool,
} from '../src/mcp/tool-capabilities.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

async function listToolsForCapabilities(
  capabilities: readonly string[] | undefined,
): Promise<string[]> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-capability-discovery-'),
  );
  const mcp = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    ...(capabilities !== undefined
      ? { availableCapabilities: capabilities }
      : {}),
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(
      path.join(process.cwd(), 'skills'),
    ),
  });
  const client = new Client({
    name: 'capability-discovery-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
  } finally {
    await client.close();
    await mcp.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

test('online capability union ignores offline devices, deduplicates, and sorts', () => {
  assert.deepEqual(
    onlineCapabilityUnion([
      {
        online: true,
        capabilities: ['files.read', 'machine.snapshot'],
      },
      {
        online: false,
        capabilities: ['windows.screenshot', 'files.write'],
      },
      {
        online: true,
        capabilities: ['machine.snapshot', 'network.tcp.probe'],
      },
    ]),
    ['files.read', 'machine.snapshot', 'network.tcp.probe'],
  );
});

test('MCP discovery exposes only tools backed by online capabilities while keeping hub-local tools', async () => {
  const tools = await listToolsForCapabilities([
    'machine.snapshot',
    'files.read',
  ]);

  assert.ok(tools.includes('machine_snapshot'));
  assert.ok(tools.includes('file_read'));

  assert.equal(tools.includes('machine_health'), false);
  assert.equal(tools.includes('file_write'), false);
  assert.equal(tools.includes('windows_screenshot'), false);
  assert.equal(tools.includes('browser_session_start'), false);

  // Hub-local control-plane tools remain discoverable even with a narrow
  // native capability union.
  assert.ok(tools.includes('devices_list'));
  assert.ok(tools.includes('device_route'));
  assert.ok(tools.includes('policy_profile_list'));
  assert.ok(tools.includes('skills_list'));
});

test('zero online native capabilities hides agent-backed tools but leaves recovery/control-plane tools', async () => {
  const tools = await listToolsForCapabilities([]);

  assert.equal(tools.includes('machine_snapshot'), false);
  assert.equal(tools.includes('shell_exec'), false);
  assert.equal(tools.includes('file_read'), false);
  assert.equal(tools.includes('windows_window_list'), false);
  assert.equal(tools.includes('browser_session_list'), false);

  assert.ok(tools.includes('devices_list'));
  assert.ok(tools.includes('device_route'));
  assert.ok(tools.includes('device_alias_list'));
  assert.ok(tools.includes('audit_query'));
  assert.ok(tools.includes('workspace_checkpoint_list'));
});

test('omitting dynamic availability preserves the complete static MCP surface for stdio and tests', async () => {
  const tools = await listToolsForCapabilities(undefined);

  for (const required of [
    'machine_snapshot',
    'file_write',
    'windows_window_list',
    'browser_session_start',
    'devices_list',
  ]) {
    assert.ok(tools.includes(required), required);
  }
});

test('every capability-backed MCP registration is represented in the discovery map', async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), 'src', 'mcp', 'create-server.ts'),
    'utf8',
  );
  const registrationPattern =
    /server\.registerTool\(\s*\n\s*'([^']+)'/g;
  const registrations = [...source.matchAll(registrationPattern)];

  const observed = new Map<string, string>();
  for (let index = 0; index < registrations.length; index++) {
    const current = registrations[index]!;
    const name = current[1]!;
    const start = current.index ?? 0;
    const end =
      index + 1 < registrations.length
        ? registrations[index + 1]!.index ?? source.length
        : source.length;
    const block = source.slice(start, end);
    const capabilities = [
      ...block.matchAll(
        /await execute\(\s*\n?\s*ctx,\s*\n?\s*'([^']+)'/g,
      ),
    ].map((match) => match[1]!);

    if (capabilities.length === 0) continue;
    assert.equal(
      new Set(capabilities).size,
      1,
      `${name} must map to exactly one native capability`,
    );
    observed.set(name, capabilities[0]!);
  }

  assert.ok(observed.size > 60);

  for (const [tool, capability] of observed) {
    assert.equal(
      requiredCapabilityForMcpTool(tool),
      capability,
      tool,
    );
  }

  assert.deepEqual(
    [...Object.keys(MCP_TOOL_CAPABILITY_REQUIREMENTS)].sort(),
    [...observed.keys()].sort(),
  );
});


test('task artifact MCP schemas stay wired to the native artifact lifecycle', async () => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-artifact-schema-'),
  );
  const mcp = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({
    name: 'artifact-schema-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();

    for (const name of [
      'task_artifact_list',
      'task_artifact_verify',
    ]) {
      assert.ok(
        listed.tools.some((tool) => tool.name === name),
        name,
      );
    }

    const runGraph = listed.tools.find(
      (tool) => tool.name === 'task_run_graph',
    );
    assert.ok(runGraph);

    const schema = runGraph.inputSchema as {
      properties?: {
        jobs?: {
          items?: {
            properties?: Record<string, unknown>;
          };
        };
      };
    };
    const jobProperties =
      schema.properties?.jobs?.items?.properties ?? {};
    assert.ok('artifacts' in jobProperties);
    assert.ok('artifact_max_bytes' in jobProperties);
  } finally {
    await client.close();
    await mcp.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
