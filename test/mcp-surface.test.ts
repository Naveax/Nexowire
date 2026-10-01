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
  MCP_SURFACE_VERSION,
  MCP_V1_STABLE_TOOLS,
} from '../src/mcp/surface.js';
import { AGENT_PROTOCOL_VERSION } from '../src/protocol/agent.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

test('MCP v1 compatibility floor remains present and unique', async () => {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-mcp-surface-'),
  );
  const server = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({
    name: 'mcp-surface-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const actual = new Set(names);

    assert.equal(
      new Set(MCP_V1_STABLE_TOOLS).size,
      MCP_V1_STABLE_TOOLS.length,
    );
    assert.deepEqual(
      [...MCP_V1_STABLE_TOOLS].sort(),
      [...MCP_V1_STABLE_TOOLS],
      'The compatibility floor stays deterministically sorted.',
    );

    const missing = MCP_V1_STABLE_TOOLS.filter(
      (name) => !actual.has(name),
    );
    assert.deepEqual(
      missing,
      [],
      'Removing/renaming a v1 stable tool requires a new surface version.',
    );

    const info = await client.callTool({
      name: 'nexowire_surface_info',
      arguments: { include_tools: true },
    });
    assert.equal(
      'isError' in info ? info.isError : false,
      false,
    );
    const structured = info.structuredContent as {
      mcpSurfaceVersion?: number;
      nativeAgentProtocolVersion?: number;
      stableToolCount?: number;
      stableTools?: string[];
      outputContractVersion?: number;
      outputContractHash?: string;
    };
    assert.equal(
      structured.mcpSurfaceVersion,
      MCP_SURFACE_VERSION,
    );
    assert.equal(
      structured.nativeAgentProtocolVersion,
      AGENT_PROTOCOL_VERSION,
    );
    assert.equal(
      structured.stableToolCount,
      MCP_V1_STABLE_TOOLS.length,
    );
    assert.deepEqual(
      structured.stableTools,
      [...MCP_V1_STABLE_TOOLS],
    );
    assert.equal(structured.outputContractVersion, 1);
    assert.match(
      structured.outputContractHash ?? '',
      /^[a-f0-9]{64}$/,
    );

    const withOutputs = await client.callTool({
      name: 'nexowire_surface_info',
      arguments: { include_output_contracts: true },
    });
    assert.equal(
      'isError' in withOutputs ? withOutputs.isError : false,
      false,
    );
    const outputStructured = withOutputs.structuredContent as {
      outputContractVersion?: number;
      outputContractHash?: string;
      outputContracts?: Record<
        string,
        {
          tool?: string;
          structuredContentType?: string;
          contentMode?: string;
        }
      >;
    };
    assert.equal(outputStructured.outputContractVersion, 1);
    assert.match(
      outputStructured.outputContractHash ?? '',
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(
      Object.keys(outputStructured.outputContracts ?? {}),
      [...MCP_V1_STABLE_TOOLS],
    );
    assert.equal(
      outputStructured.outputContracts?.browser_screenshot?.contentMode,
      'image-plus-json',
    );
    assert.equal(
      outputStructured.outputContracts?.machine_snapshot
        ?.structuredContentType,
      'object',
    );
  } finally {
    await client.close();
    await server.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
