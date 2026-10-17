import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { AgentProvider } from '../src/providers/agent-provider.js';
import { AuditLog } from '../src/audit/log.js';
import {
  IdempotencyStore, type IdempotencyRecord, type IdempotencyStatus,
} from '../src/operations/idempotency-store.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

class SuccessBroker extends AgentBroker {
  calls = 0;
  override list() {
    return [{
      id: 'test-device',
      name: 'Disposable P2 Device',
      platform: process.platform,
      arch: process.arch,
      agentVersion: 'test',
      capabilities: ['files.write'],
      instanceId: '11111111-1111-4111-8111-111111111111',
      connectedAt: new Date().toISOString(),
    }];
  }
  override async request(): Promise<unknown> {
    this.calls++;
    return {data:{path:'isolated-test.txt',bytesWritten:4}};
  }
}

class OneFailedCompletionStore extends IdempotencyStore {
  failed = false;
  override async complete(
    key: string, status: Exclude<IdempotencyStatus,'in_progress'>,
    result?: unknown,
  ): Promise<IdempotencyRecord> {
    if (!this.failed && status === 'succeeded') {
      this.failed = true;
      throw new Error('INJECTED_JOURNAL_COMPLETION_FAILURE');
    }
    return super.complete(key, status, result);
  }
}

async function withFakeMcp(
  storeFactory: (root: string) => IdempotencyStore,
  setAudit: (audit: AuditLog) => void,
  run: (client: Client, store: IdempotencyStore, broker: SuccessBroker) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-post-mutation-p2-'));
  const broker = new SuccessBroker();
  const registry = new ProviderRegistry();
  registry.register(new AgentProvider(broker));
  const store = storeFactory(root);
  const audit = new AuditLog(path.join(root,'audit.jsonl'));
  setAudit(audit);
  const server = createNexowireMcpServer({
    broker, providers: registry, idempotency: store, audit,
    workspaces: new WorkspaceStore(root),
    skills: new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client = new Client({name:'post-mutation-test',version:'1.0.0'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b),client.connect(a)]);
    await run(client,store,broker);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root,{recursive:true,force:true});
  }
}

const args = {
  device_id: 'test-device', path: 'isolated-test.txt',
  content: 'test', mode: 'overwrite',
  idempotency_key: 'post-mutation-p2-test',
};

test('failed final audit must never downgrade a durably successful mutation', async () => {
  await withFakeMcp(
    (root) => new IdempotencyStore(root),
    (audit) => {
      const original = audit.write.bind(audit);
      let writes = 0;
      audit.write = async (entry) => {
        if (++writes === 2) throw new Error('INJECTED_FINAL_AUDIT_FAILURE');
        return await original(entry);
      };
    },
    async (client,store,broker) => {
      const first = await client.callTool({name:'file_write',arguments:args});
      assert.equal(first.isError,true,'audit failure is surfaced');
      assert.equal((await store.get(args.idempotency_key))?.status,'succeeded');
      assert.equal(broker.calls,1);
      const retry = await client.callTool({name:'file_write',arguments:args});
      assert.equal(retry.isError ?? false,false,'confirmed result is replayable from memory');
      assert.equal(broker.calls,1,'never re-run the mutation');
    },
  );
});

test('failed post-dispatch journal completion must be unknown, never failed', async () => {
  await withFakeMcp(
    (root) => new OneFailedCompletionStore(root),
    () => {},
    async (client,store,broker) => {
      const first = await client.callTool({name:'file_write',arguments:args});
      assert.equal(first.isError,true);
      assert.equal((await store.get(args.idempotency_key))?.status,'unknown');
      assert.equal(broker.calls,1);
      const repeat = await client.callTool({name:'file_write',arguments:args});
      assert.equal(repeat.isError,true);
      assert.equal(
        (repeat.structuredContent as {error?:{code?:string}}).error?.code,
        'IDEMPOTENCY_STATE_UNKNOWN',
      );
      assert.equal(broker.calls,1);
    },
  );
});

test('pre-dispatch audit failure is not mislabeled as an ambiguous remote mutation', async () => {
  await withFakeMcp(
    (root) => new IdempotencyStore(root),
    (audit) => {
      audit.write = async () => {
        throw new Error('INJECTED_START_AUDIT_FAILURE');
      };
    },
    async (client,store,broker) => {
      const response = await client.callTool({name:'file_write',arguments:args});
      assert.equal(response.isError,true);
      assert.equal(broker.calls,0,'provider must not run before started-audit gate');
      assert.equal((await store.get(args.idempotency_key))?.status,'failed');
    },
  );
});

test('repeated audit sink failures do not hide a previously confirmed remote outcome', async () => {
  await withFakeMcp(
    (root) => new IdempotencyStore(root),
    (audit) => {
      const original = audit.write.bind(audit);
      let writes = 0;
      audit.write = async (entry) => {
        if (++writes >= 2) throw new Error('INJECTED_PERSISTENT_AUDIT_FAILURE');
        return original(entry);
      };
    },
    async (client,store,broker) => {
      const first = await client.callTool({name:'file_write',arguments:args});
      assert.equal(first.isError,true);
      const detail = first.structuredContent as {
        recoveryAuditFailed?: boolean;
        idempotency?: {persistedStatus?:string};
      };
      assert.equal(detail.recoveryAuditFailed,true);
      assert.equal(detail.idempotency?.persistedStatus,'succeeded');
      assert.equal((await store.get(args.idempotency_key))?.status,'succeeded');
      assert.equal(broker.calls,1);
    },
  );
});

class AlwaysFailedCompletionStore extends IdempotencyStore {
  override async complete(): Promise<IdempotencyRecord> {
    throw new Error('INJECTED_UNAVAILABLE_COMPLETION_JOURNAL');
  }
}

test('unavailable journal after remote dispatch returns fail-closed metadata without claiming persisted status', async () => {
  await withFakeMcp(
    (root) => new AlwaysFailedCompletionStore(root),
    () => {},
    async (client, store, broker) => {
      const response = await client.callTool({name:'file_write',arguments:args});
      assert.equal(response.isError,true,'the caller receives an actionable failure');
      const details = response.structuredContent as {
        recoveryJournalFailed?: boolean;
        idempotency?: { persistedStatus?: string; outcomeUnconfirmed?: boolean };
      };
      assert.equal(details.recoveryJournalFailed, true);
      assert.equal(details.idempotency?.persistedStatus, undefined);
      assert.equal(details.idempotency?.outcomeUnconfirmed, true);
      assert.equal(broker.calls, 1, 'the underlying side effect was dispatched once');
      assert.equal((await store.get(args.idempotency_key))?.status, 'in_progress');
      const next = await client.callTool({name:'file_write',arguments:args});
      assert.equal(next.isError,true);
      assert.equal(broker.calls,1,'the same idempotency key must not dispatch twice');
    },
  );
});
