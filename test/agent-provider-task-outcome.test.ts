import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {AgentProvider} from '../src/providers/agent-provider.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';

class SyntheticProcessBroker extends AgentBroker {
  constructor(public outcome:unknown){super()}
  override list(){
    return [{
      id:'shell-result-device',name:'Synthetic Tool Exit Device',
      platform:process.platform,arch:process.arch,agentVersion:'test',
      capabilities:['shell.exec','wsl.exec','files.read'],
      instanceId:'11111111-1111-4111-8111-111111111111',
      connectedAt:new Date().toISOString(),
    }];
  }
  override async request():Promise<unknown>{return this.outcome}
}
for(const tc of [
  {name:'exit zero',raw:{stdout:'ok',exitCode:0,data:{timedOut:false}},
    taskStatus:'succeeded',taskSuccess:true},
  {name:'nonzero exit',raw:{stdout:'',stderr:'test failure',exitCode:5,
    data:{timedOut:false}},taskStatus:'failed',taskSuccess:false},
  {name:'Windows crash exit code',raw:{exitCode:0xC0000409,
    data:{timedOut:false}},taskStatus:'failed',taskSuccess:false},
  {name:'timed out with zero exit',raw:{exitCode:0,
    data:{timedOut:true}},taskStatus:'timed_out',taskSuccess:false},
  {name:'no exit code yet',raw:{exitCode:null,data:{timedOut:false}},
    taskStatus:'unknown',taskSuccess:null},
  {name:'missing exit code',raw:{stdout:'incomplete'},
    taskStatus:'unknown',taskSuccess:null},
] as const){
  test('AgentProvider separates successful Agent transport from '+tc.name,async()=>{
    const broker=new SyntheticProcessBroker(tc.raw);
    const provider=new AgentProvider(broker);
    const result=await provider.execute({
      targetId:'shell-result-device',
      capability:'shell.exec',
      input:{command:'synthetic-not-executed'},
      requestId:'00000000-0000-4000-8000-000000000001',
    });
    assert.equal(result.ok,true);
    assert.equal(result.taskStatus,tc.taskStatus);
    assert.equal(result.taskSuccess,tc.taskSuccess);
    if('exitCode' in tc.raw){
      assert.equal(result.exitCode,tc.raw.exitCode);
    }
  });
}
test('non-shell tools never imply that a command ran',async()=>{
  const provider=new AgentProvider(new SyntheticProcessBroker({data:{value:1}}));
  const result=await provider.execute({
    targetId:'shell-result-device',capability:'files.read',input:{path:'synthetic'},
  });
  assert.equal(result.ok,true);
  assert.equal(result.taskStatus,undefined);
  assert.equal(result.taskSuccess,undefined);
});
test('MCP shell_exec structured output marks command error despite ok:true',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-task-status-'));
  const broker=new SyntheticProcessBroker({
    stdout:'',stderr:'command failed',exitCode:7,data:{timedOut:false},
  });
  const providers=new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const server=createNexowireMcpServer({
    broker,providers,
    workspaces:new WorkspaceStore(root),
    skills:new SkillRegistry(path.join(process.cwd(),'skills')),
  });
  const client=new Client({name:'shell-task-status-acceptance',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(b),client.connect(a)]);
    const result=await client.callTool({
      name:'shell_exec',
      arguments:{device_id:'shell-result-device',command:'synthetic-do-not-run'},
    });
    const d=result.structuredContent as {
      ok:boolean;exitCode:number;taskStatus:string;taskSuccess:boolean;
    };
    assert.equal(d.ok,true,'transport remains backward compatible');
    assert.equal(d.exitCode,7);
    assert.equal(d.taskStatus,'failed');
    assert.equal(d.taskSuccess,false);
    assert.equal(result.isError,undefined,
      'MCP isError continues to represent transport failure, not shell exit');
  }finally{
    await client.close();
    await server.close();
    await fs.rm(root,{recursive:true,force:true});
  }
});
