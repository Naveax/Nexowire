import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { MCP_V1_STABLE_TOOLS } from '../src/mcp/surface.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

const stateDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'nexowire-mcp-contract-'),
);
const server = createNexowireMcpServer({
  broker: new AgentBroker(),
  providers: new ProviderRegistry(),
  workspaces: new WorkspaceStore(stateDir),
  skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
});
const client = new Client({
  name: 'nexowire-contract-generator',
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
  const byName = new Map(
    listed.tools.map((tool) => [tool.name, tool.inputSchema]),
  );

  const contract: Record<string, unknown> = {};
  for (const name of MCP_V1_STABLE_TOOLS) {
    const schema = byName.get(name);
    if (!schema) {
      throw new Error(
        `Cannot generate v1 contract; stable tool is missing: ${name}`,
      );
    }
    contract[name] = schema;
  }

  const output = path.join(
    process.cwd(),
    'src',
    'mcp',
    'v1-input-contract.json',
  );
  await fs.writeFile(
    output,
    JSON.stringify(contract, null, 2) + '\n',
    'utf8',
  );
  console.log(
    `Wrote ${Object.keys(contract).length} stable MCP input schemas to ${output}`,
  );
} finally {
  await client.close();
  await server.close();
  await fs.rm(stateDir, { recursive: true, force: true });
}
