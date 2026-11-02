import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { AuditLog } from '../src/audit/log.js';
import { IdempotencyStore } from '../src/operations/idempotency-store.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { classifyFailure, classifyUndeliveredUpstreamRefusal } from '../src/protocol/error-contract-v2.js';

const DEVICE = 'qa-02-synthetic-device';
const SECRET = 'Qa02SyntheticSecretDoNotPersist123';

class LostAckBroker extends AgentBroker {
  dispatches = 0;
  requestIds: string[] = [];
  override list() {
    return [{
      id: DEVICE, name: 'Isolated QA Device', platform: process.platform,
      arch: process.arch, agentVersion: 'fixture',
      capabilities: ['files.write', 'files.read', 'shell.exec'],
      instanceId: '11111111-1111-4111-8111-111111111111',
      connectedAt: new Date().toISOString(),
    }];
  }
  override async request(_target: string, _capability: string, _input: unknown,
    _timeoutMs: number, requestId?: string): Promise<never> {
    this.dispatches++;
    this.requestIds.push(requestId ?? '');
    const error = new Error('Bearer ' + SECRET + ' unavailable after dispatch') as Error & {code:string};
    error.code = 'AGENT_DISCONNECTED';
    throw error;
  }
}

async function openFixture(broker: LostAckBroker, root: string) {
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const audit = new AuditLog(path.join(root, 'audit.jsonl'));
  const server = createNexowireMcpServer({
    broker, providers, audit, idempotency: new IdempotencyStore(root),
    workspaces: new WorkspaceStore(root),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({name:'qa-02-no-replay',version:'1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  return {
    client, audit,
    async close() { await client.close(); await server.close(); },
  };
}

test('QA02: lost mutation ACK never dispatches twice, even after MCP/Hub restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-qa02-noreplay-'));
  const broker = new LostAckBroker();
  const args = {
    device_id: DEVICE, path: 'fixture-not-created', content: 'fixture-content',
    mode:'overwrite', idempotency_key: 'qa02-dispatched-no-replay',
  };
  try {
    let firstId: string;
    const first = await openFixture(broker,root);
    try {
      const response = await first.client.callTool({name:'file_write',arguments:args});
      const data = response.structuredContent as Record<string, any>;
      assert.equal(data.ok,false);
      assert.equal(data.error.code,'MUTATION_STATE_UNKNOWN');
      assert.equal(data.error.attribution.causeLayer,'undetermined');
      assert.equal(data.error.attribution.retrySafety,'reconcile_first');
      assert.equal(data.idempotency.persistedStatus,'unknown');
      firstId = data.idempotency.operationId;
      assert.match(firstId,/^[a-f0-9-]{36}$/i);
      assert.deepEqual(broker.requestIds,[firstId]);
      assert.deepEqual((await first.audit.query({operationId:firstId})).events.map(e=>e.status),
        ['unknown','started']);
      assert.ok(!JSON.stringify(response).includes(SECRET));
      const retry = await first.client.callTool({name:'file_write',arguments:args});
      const retried = retry.structuredContent as Record<string, any>;
      assert.equal(retried.idempotency.operationId,firstId);
      assert.equal(retried.idempotency.persistedStatus,'unknown');
      assert.equal(broker.dispatches,1,'same key must not dispatch while outcome unknown');
    } finally {
      await first.close();
    }

    const restarted = await openFixture(broker,root);
    try {
      const response = await restarted.client.callTool({name:'file_write',arguments:args});
      const data = response.structuredContent as Record<string, any>;
      assert.equal(data.ok,false);
      assert.equal(data.idempotency.persistedStatus,'unknown');
      assert.equal(data.idempotency.operationId,firstId!);
      assert.equal(broker.dispatches,1,'Hub restart must not auto replay lost mutation');
      assert.ok(!JSON.stringify(response).includes(SECRET));
      const rawAudit = await fs.readFile(path.join(root,'audit.jsonl'),'utf8');
      assert.ok(!rawAudit.includes(SECRET),'raw audit must not leak injected Bearer token');
    } finally {
      await restarted.close();
    }
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('QA02: unknown failure source cannot masquerade as Agent or OpenAI refusal', () => {
  const hubUnseen = classifyFailure({
    code:'UPSTREAM_REFUSAL_NOT_DELIVERED',observedAt:'mcp_hub',dispatched:'unknown',
  });
  assert.equal(hubUnseen.causeLayer,'undetermined');
  assert.equal(hubUnseen.certainty,'unknown');
  const external = classifyUndeliveredUpstreamRefusal('explicit-synthetic-external-evidence');
  assert.equal(external.causeLayer,'upstream_client');
  assert.equal(external.dispatchState,'not_dispatched');
  const undetermined = classifyFailure({
    code:'UNAVAILABLE',observedAt:'mcp_hub',dispatched:'unknown',readOnly:false,
  });
  assert.equal(undetermined.causeLayer,'undetermined');
  assert.equal(undetermined.retrySafety,'reconcile_first');
  const denied = classifyFailure({
    code:'PATH_DENIED',observedAt:'native_agent',dispatched:true,readOnly:true,
  });
  assert.equal(denied.causeLayer,'native_agent');
  assert.equal(denied.retrySafety,'after_reauthorization');
});
