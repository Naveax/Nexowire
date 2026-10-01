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
import { compareInputSchemas } from '../src/mcp/schema-compat.js';
import { MCP_V1_STABLE_TOOLS } from '../src/mcp/surface.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

test('schema compatibility checker allows additive/widening input changes', () => {
  const baseline = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        minLength: 2,
        maxLength: 20,
        enum: ['a', 'b'],
      },
    },
  };
  const current = {
    type: 'object',
    required: [],
    additionalProperties: true,
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 30,
        enum: ['a', 'b', 'c'],
      },
      optional_extra: {
        type: 'boolean',
      },
    },
  };

  assert.deepEqual(compareInputSchemas(baseline, current), []);
});

test('schema compatibility checker rejects narrowing/removal', () => {
  const baseline = {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 20,
        enum: ['a', 'b'],
      },
      optional_old: {
        type: 'number',
        minimum: 0,
      },
    },
  };
  const current = {
    type: 'object',
    required: ['name', 'new_required'],
    properties: {
      name: {
        type: 'string',
        minLength: 3,
        maxLength: 10,
        enum: ['a'],
      },
      new_required: {
        type: 'boolean',
      },
    },
  };

  const issues = compareInputSchemas(baseline, current);
  assert.ok(
    issues.some((issue) =>
      issue.message.includes('newly required'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.message.includes('Existing v1 input field was removed'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.message.includes('Enum value'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.message.includes('minLength narrowed'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.message.includes('maxLength narrowed'),
    ),
  );
});

test('MCP v1 stable input schemas remain backward compatible with frozen contract', async () => {
  const baselinePath = path.join(
    process.cwd(),
    'src',
    'mcp',
    'v1-input-contract.json',
  );
  const baseline = JSON.parse(
    await fs.readFile(baselinePath, 'utf8'),
  ) as Record<string, unknown>;

  assert.deepEqual(
    Object.keys(baseline),
    [...MCP_V1_STABLE_TOOLS],
    'Frozen contract keys must match the deterministic stable-tool floor.',
  );

  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-mcp-schema-'),
  );
  const server = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    workspaces: new WorkspaceStore(stateDir),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({
    name: 'mcp-schema-compat-test',
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
    const current = new Map(
      listed.tools.map((tool) => [tool.name, tool.inputSchema]),
    );

    for (const tool of [
      'windows_registry_set',
      'windows_registry_delete',
    ] as const) {
      const schema = current.get(tool) as
        | {
            properties?: Record<
              string,
              { minLength?: number }
            >;
          }
        | undefined;
      assert.ok(schema, tool + ' schema is missing.');
      assert.equal(
        schema?.properties?.name?.minLength ?? 0,
        0,
        tool + ' must allow an empty name for the unnamed/default registry value.',
      );
    }

    const failures: Array<{
      tool: string;
      path: string;
      message: string;
    }> = [];

    for (const tool of MCP_V1_STABLE_TOOLS) {
      const schema = current.get(tool);
      if (!schema) {
        failures.push({
          tool,
          path: '$',
          message: 'Stable tool is missing.',
        });
        continue;
      }

      for (const issue of compareInputSchemas(
        baseline[tool],
        schema,
      )) {
        failures.push({
          tool,
          path: issue.path,
          message: issue.message,
        });
      }
    }

    assert.deepEqual(
      failures,
      [],
      'Changing a frozen v1 input contract incompatibly requires a new MCP surface version or an explicit compatibility migration.',
    );
  } finally {
    await client.close();
    await server.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
