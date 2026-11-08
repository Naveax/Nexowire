import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../../src/core/agent-broker.js';
import {ProviderRegistry} from '../../src/core/provider-registry.js';
import {AgentProvider} from '../../src/providers/agent-provider.js';
import {createNexowireMcpServer} from '../../src/mcp/create-server.js';
import {IdempotencyStore} from '../../src/operations/idempotency-store.js';
import {WorkspaceStore} from '../../src/workspace/store.js';
import {SkillRegistry} from '../../src/skills/registry.js';

const DEVICE = 'clean10-timeout-synthetic';
const SECRET = 'clean10SyntheticBearerSecretDoNotLog123';

class TimedOutAfterDispatch extends AgentBroker {
  dispatches = 0;
  requestIds: string[] = [];
  override list() {
    return [{
      id:DEVICE, name:'CLEAN-10 synthetic device',
      platform:process.platform, arch:process.arch, agentVersion:'fixture',
      capabilities:['files.write','files.read'],
      instanceId:'11111111-1111-4111-8111-111111111111',
      connectedAt:new Date().toISOString(),
    }];
  }
  override async request(
    _target:string, _capability:string, _input:unknown,
    _timeoutMs:number, requestId?:string,
  ):Promise<never> {
    this.dispatches++;
    this.requestIds.push(requestId ?? '');
    const error = new Error('Bearer ' + SECRET + ' ETIMEDOUT after synthetic dispatch') as Error & {code:string};
    error.code = 'ETIMEDOUT';
    throw error;
  }
}

async function connect(broker:TimedOutAfterDispatch, root:string) {
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const server = createNexowireMcpServer({
    broker, providers,
    idempotency:new IdempotencyStore(root),
    workspaces:new WorkspaceStore(root),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client = new Client({name:'clean10-timeout-reconnect',version:'1'});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st),client.connect(ct)]);
  return {client, close:async()=>{await client.close();await server.close();}};
}

test('CLEAN-10: timeout after dispatch, reconnect, duplicate UUID and changed-payload key do not replay', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'nw-clean10-timeout-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const broker = new TimedOutAfterDispatch();
  const args = {
    device_id:DEVICE, path:'synthetic-only', mode:'overwrite',
    content:'fixture-bytes', idempotency_key:'clean10-timeout-uuid',
  };
  let operationId:string;
  const initial = await connect(broker,root);
  try {
    const result = await initial.client.callTool({name:'file_write',arguments:args});
    const first = result.structuredContent as Record<string,any>;
    assert.equal(first.ok,false);
    assert.equal(first.idempotency.persistedStatus,'unknown');
    assert.equal(first.idempotency.replayed,false);
    operationId = first.idempotency.operationId;
    assert.equal(first.operationId, operationId);
    assert.match(operationId,/^[a-f0-9-]{36}$/i);
    assert.deepEqual(broker.requestIds,[operationId]);
    assert.equal(first.error.attribution.retrySafety,'reconcile_first');
    assert.ok(!JSON.stringify(result).includes(SECRET));
    const duplicate = (await initial.client.callTool({
      name:'file_write',arguments:args,
    })).structuredContent as Record<string,any>;
    assert.equal(duplicate.idempotency.operationId,operationId);
    assert.equal(duplicate.idempotency.persistedStatus,'unknown');
    assert.equal(broker.dispatches,1);
  } finally {
    await initial.close();
  }

  // A new Hub/MCP server instance represents reconnect/restart over the same disk.
  const reconnected = await connect(broker,root);
  try {
    const retry = (await reconnected.client.callTool({
      name:'file_write',arguments:args,
    })).structuredContent as Record<string,any>;
    assert.equal(retry.ok,false);
    assert.equal(retry.idempotency.operationId,operationId!);
    assert.equal(retry.idempotency.persistedStatus,'unknown');
    assert.equal(broker.dispatches,1,'reconnected Hub must not redispatch');

    const keyReuse = (await reconnected.client.callTool({
      name:'file_write',
      arguments:{...args,content:'different-synthetic-payload'},
    })).structuredContent as Record<string,any>;
    assert.equal(keyReuse.ok,false);
    assert.equal(keyReuse.error.code,'IDEMPOTENCY_KEY_REUSED');
    assert.equal(broker.dispatches,1,'reused key with new payload must be rejected');
  } finally {
    await reconnected.close();
  }
});
