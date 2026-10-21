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
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';

// P1 #588 INDEPENDENT ACCEPTANCE TEST, intentionally red until the
// one-logical-command, cross-device durable transfer contract is implemented.
// Passing Artifact Bridge staging/chunk tests is not equivalent to this contract.
// No physical device, network transfer, large file or production mutation used.
test('issue #588: authenticated transfer starts with one bounded MCP command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-588-contract-'));
  const workspaces = new WorkspaceStore(root);
  const server = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers: new ProviderRegistry(),
    workspaces,
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
    toolAuthorization: {
      kind: 'control-plane',
      scope: 'mcp',
      accountId: 'synthetic-588-owner',
      role: 'admin',
      allowedDeviceIds: ['device-source', 'device-target'],
    },
  });
  const client = new Client({ name: 'qa-588-one-command', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const advertised = (await client.listTools()).tools;
    const names = advertised.map(tool => tool.name);
    const acceptedNames = new Set([
      'transfer_start',
      'artifact_transfer_start',
      'artifact_bridge_transfer_start',
    ]);
    const start = advertised.find(tool => acceptedNames.has(tool.name));

    assert.ok(start,
      'BLOCKED #588: MCP exposes bounded artifact_bridge_ingest_device_file only; ' +
      'its PARTIAL response requires up to 512 separate requests per 1 GiB. ' +
      'Add one start call that starts a durable server-side cross-device worker.');
    const properties = (start.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const field of [
      'source_device_id', 'source_path', 'target_device_id', 'target_path',
    ]) {
      assert.ok(Object.hasOwn(properties, field),
        'BLOCKED #588: transfer start must carry explicit ' + field);
    }
    assert.equal(Object.hasOwn(properties, 'content_base64'), false,
      'Transfer start must not accept a huge inline Base64 file body.');
    assert.equal(Object.hasOwn(properties, 'chunks'), false,
      'Transfer start must not require ChatGPT to submit individual chunks.');

    assert.ok(names.some(name => /^(?:transfer|artifact_transfer|artifact_bridge_transfer)_status$/.test(name)),
      'BLOCKED #588: expose authenticated durable transfer status/progress.');
    assert.ok(names.some(name => /^(?:transfer|artifact_transfer|artifact_bridge_transfer)_cancel$/.test(name)),
      'BLOCKED #588: expose scoped cancellation for unfinished transfers.');
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
