import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';

// Independent RED acceptance at public MCP ABI, not a 1 GiB memory fixture.
// #596 bounded storage and #598 HTTP caps are not one-call transfer orchestration.
test('QA #588: scoped one-call transfer start/status/cancel must be advertised',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'qa16-588-mcp-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const server=createNexowireMcpServer({
    broker:new AgentBroker(),
    providers:new ProviderRegistry(),
    workspaces:new WorkspaceStore(tmp),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
    toolAuthorization:{
      kind:'control-plane',scope:'mcp',
      accountId:'qa16-owner-synthetic',role:'admin',
      allowedDeviceIds:['qa-source','qa-target'],
    },
  });
  const client=new Client({name:'qa16-onecall-negative',version:'1.0.0'});
  const [c,s]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(s),client.connect(c)]);
    const advertised=(await client.listTools()).tools;
    const tools=new Map(advertised.map(entry=>[entry.name,entry]));
    const names=[
      ['transfer_start','artifact_transfer_start','artifact_bridge_transfer_start'],
      ['transfer_status','artifact_transfer_status','artifact_bridge_transfer_status'],
      ['transfer_cancel','artifact_transfer_cancel','artifact_bridge_transfer_cancel'],
    ];
    for(const [index,aliases] of names.entries()){
      const chosen=aliases.find(name=>tools.has(name));
      assert.ok(chosen,
        'BLOCKED #588: missing authenticated durable transfer '+
        ['start','status','cancel'][index]+
        '; bounded ingest_device_file/PARTIAL is not a one-call 1GiB transfer');
      const schema=tools.get(chosen)!.inputSchema.properties ?? {};
      if(index===0){
        for(const field of ['source_device_id','source_path','target_device_id','target_path']){
          assert.ok(Object.hasOwn(schema,field),
            'BLOCKED #588: missing device-scoped field '+field);
        }
        assert.equal(Object.hasOwn(schema,'content_base64'),false);
        assert.equal(Object.hasOwn(schema,'chunks'),false);
      }
    }
  }finally{
    await client.close();
    await server.close();
  }
});
