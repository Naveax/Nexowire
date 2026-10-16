import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { NexowireError } from '../src/core/errors.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

class LostAcknowledgementBroker extends AgentBroker {
  calls = 0;
  online = true;

  override list() {
    return this.online ? [{
      id: 'continuity-device',
      name: 'Disposable Continuity Device',
      platform: process.platform,
      arch: process.arch,
      agentVersion: 'test',
      capabilities: ['files.write'],
      instanceId: '11111111-1111-4111-8111-111111111111',
      connectedAt: new Date().toISOString(),
    }] : [];
  }

  override async request(): Promise<unknown> {
    this.calls++;
    // The native agent may have performed this mutation, but its response
    // was lost across a reconnect; no automatic retry is permitted.
    throw new NexowireError('AGENT_INSTANCE_CHANGED', 'acknowledgement lost');
  }
}

test('lost mutation acknowledgement remains queryable when its device disconnects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-p2-unknown-'));
  const broker = new LostAcknowledgementBroker();
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const store = new IdempotencyStore(root);
  const server = createNexowireMcpServer({
    broker, providers, idempotency: store,
    toolAuthorization: {
      kind: 'stored', scope: 'mcp',
      credential: {
        id: 'continuity-operator', scope: 'mcp',
        createdAt: '2026-10-17T00:00:00.000Z',
        role: 'operator',
        allowedDeviceIds: ['continuity-device'],
      },
    },
    workspaces: new WorkspaceStore(root),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({ name: 'continuity-integration', version: '1.0.0' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const args = {
      device_id: 'continuity-device', path: 'disposable-test.txt',
      content: 'sensitive-test-payload', mode: 'overwrite',
      idempotency_key: 'lost-acknowledgement-1',
    };
    const first = await client.callTool({ name: 'file_write', arguments: args });
    assert.equal(first.isError, true);
    const firstData = first.structuredContent as {
      error?: { code?: string }; idempotency?: { persistedStatus?: string };
    };
    assert.equal(firstData.error?.code, 'MUTATION_STATE_UNKNOWN');
    assert.equal(firstData.idempotency?.persistedStatus, 'unknown');
    assert.equal(broker.calls, 1);

    const retry = await client.callTool({ name: 'file_write', arguments: args });
    assert.equal(retry.isError, true);
    assert.equal((retry.structuredContent as {error?:{code:string}}).error?.code,
      'IDEMPOTENCY_STATE_UNKNOWN');
    assert.equal(broker.calls, 1, 'ambiguous mutation was not re-executed');

    broker.online = false;
    const offlineStatus = await client.callTool({
      name: 'operations_idempotency_list',
      arguments: { key: 'lost-acknowledgement-1' },
    });
    const found = (offlineStatus.structuredContent as {
      records: Array<{key:string;status:string;targetId:string;operationId:string}>
    }).records;
    assert.equal(found.length, 1);
    assert.equal(found[0]?.status, 'unknown');
    assert.equal(found[0]?.targetId, 'continuity-device');

    const persisted = await fs.readFile(path.join(root, 'idempotency-records.json'), 'utf8');
    assert.equal(persisted.includes('sensitive-test-payload'), false);
    assert.equal(JSON.stringify(offlineStatus).includes('sensitive-test-payload'), false);
    const restored = new IdempotencyStore(root);
    assert.equal((await restored.get('lost-acknowledgement-1'))?.status, 'unknown');
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
