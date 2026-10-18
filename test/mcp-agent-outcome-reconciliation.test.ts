import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {NexowireError} from '../src/core/errors.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {AgentProvider} from '../src/providers/agent-provider.js';
import {IdempotencyStore} from '../src/operations/idempotency-store.js';
import {AuditLog} from '../src/audit/log.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';

class RecordedAgentErrorBroker extends AgentBroker {
  calls=0;
  constructor(readonly code:string){super()}
  override list(){
    return [{
      id:'reconciliation-device',name:'Disposable Agent Error Test',
      platform:process.platform,arch:process.arch,agentVersion:'test',
      capabilities:['files.write'],
      instanceId:'11111111-1111-4111-8111-111111111111',
      connectedAt:new Date().toISOString(),
    }];
  }
  override async request():Promise<unknown>{
    this.calls++;
    throw new NexowireError(this.code,'Synthetic Agent response; no real mutation');
  }
}
for(const [code,expected] of [
  ['AGENT_OPERATION_COMPLETION_UNCONFIRMED','unknown'],
  ['AGENT_OPERATION_ALREADY_RECORDED','unknown'],
  ['PERMISSION_DENIED','failed'],
] as const){
  test('Hub + MCP idempotency classify Agent '+code+' as '+expected,async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-agent-outcome-'));
    const broker=new RecordedAgentErrorBroker(code);
    const providers=new ProviderRegistry();
    providers.register(new AgentProvider(broker));
    const store=new IdempotencyStore(root);
    const audit=new AuditLog(path.join(root,'audit.jsonl'));
    const server=createNexowireMcpServer({
      broker,providers,idempotency:store,audit,
      toolAuthorization:{kind:'stored',scope:'mcp',
        credential:{
          id:'reconciliation-operator',scope:'mcp',
          createdAt:'2026-10-18T00:00:00.000Z',
          role:'operator',allowedDeviceIds:['reconciliation-device'],
        },
      },
      workspaces:new WorkspaceStore(root),
      skills:new SkillRegistry(path.join(process.cwd(),'skills')),
    });
    const client=new Client({name:'agent-outcome-reconciliation',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try{
      await Promise.all([server.connect(b),client.connect(a)]);
      const args={
        device_id:'reconciliation-device',
        path:'disposable-synthetic-result.txt',
        content:'fake mutation payload must not leak',
        mode:'overwrite',
        idempotency_key:'agent-outcome-'+code.toLowerCase(),
      };
      const first=await client.callTool({name:'file_write',arguments:args});
      assert.equal(first.isError,true);
      const state=first.structuredContent as {
        error?:{code?:string};
        idempotency?:{persistedStatus?:string};
      };
      assert.equal(state.error?.code,code);
      assert.equal(state.idempotency?.persistedStatus,expected);
      assert.equal((await store.get(args.idempotency_key))?.status,expected);
      const auditEvents=await audit.query({status:expected,limit:10});
      assert.equal(auditEvents.events.length,1);
      assert.equal(auditEvents.events[0]?.errorCode,code);
      const retry=await client.callTool({name:'file_write',arguments:args});
      assert.equal(retry.isError,true);
      const retryContent=retry.structuredContent as {
        error?:{code?:string};
        idempotency?:{replayed?:boolean;persistedStatus?:string};
      };
      // While the Hub remains alive it returns its cached *error* along
      // with replayed:true. After restart, it rejects using durable status.
      assert.equal(retryContent.error?.code,code);
      assert.equal(retryContent.idempotency?.replayed,true);
      assert.equal(retryContent.idempotency?.persistedStatus,expected);
      assert.equal(broker.calls,1,'unknown or failed mutation must never auto-replay');
      const raw=await fs.readFile(path.join(root,'idempotency-records.json'),'utf8');
      assert.equal(raw.includes('fake mutation payload'),false);
    }finally{
      await client.close();
      await server.close();
      await fs.rm(root,{recursive:true,force:true});
    }
  });
}
