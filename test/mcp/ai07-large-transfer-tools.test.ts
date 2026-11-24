import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerLargeTransferTools,type LargeTransferRuntime} from '../../src/mcp/large-transfer-tools.js';
import type {LargeTransferRemote,LargeTransferAuthority} from '../../src/mcp/durable-large-transfer.js';
import type {BearerAuthorization} from '../../src/security/auth.js';
const sha=createHash('sha256').digest('hex');
const auth:BearerAuthorization={kind:'control-plane',scope:'mcp',accountId:'owner',role:'user',allowedDeviceIds:['s','t'],deviceAccessModes:{s:'full',t:'full'}};
async function fixture(t:import('node:test').TestContext,identity:BearerAuthorization,enabled=true){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-large-mcp-'));
  const server=new McpServer({name:'transfer-fixture',version:'1.0.0'});
  const client=new Client({name:'test',version:'1.0.0'});
  // The SDK installs tools/list only after the first registration. Production
  // has other tools; keep that condition in this negative registration fixture.
  server.registerTool('fixture_status',{description:'Unrelated fixture tool',inputSchema:{}},async()=>({content:[{type:'text',text:'fixture'}]}));
  let reads=0,writes=0,publishes=0,stage=false,complete=false;
  const remote:LargeTransferRemote={
    async limits(){return {maxHashBytes:4*1024**3,maxOffsetBytes:Number.MAX_SAFE_INTEGER};},
    async stat(d,p){reads++;return d==='s'||stage&&p.endsWith('.part')||complete&&!p.endsWith('.part')?{type:'file',size:0}:undefined;},
    async hash(){return sha;},async read(){throw Error('unexpected empty read');},
    async writeFenced(_b,_l,p,content,first){writes++;assert.equal(content,'');assert.equal(first,true);stage=true;return {requestId:p.requestId,epoch:p.epoch,offset:p.offset,length:p.length,sha256:p.sha256};},
    async publishFenced(b,_l,p){publishes++;stage=false;complete=true;return {jobId:b.id,requestId:p.requestId,epoch:p.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:0,sha256:sha,proof:'synthetic-only-fixture-proof-32-bytes'};},
  };
  const authority:LargeTransferAuthority={
    async assertGrant(s){assert.equal(s.ownerId,'owner');assert.equal(s.projectId,'configured-project');},async acquire(){return {epoch:1,token:'test-only-lease-token-not-production'};},async assertCurrent(){},async proveWriteNoEffect(){return false;},
    async verifyFinal(){return true;},async commitPublished(b,l,r){return {jobId:b.id,requestId:r.requestId,epoch:l.epoch,sha256:b.sha256,commitId:randomUUID()};},
    async recoverPublished(){return undefined;},async recoverNativeReceipt(){return undefined;},async commitRecoveredPublication(){throw Error('unexpected recovery');},
  };
  const runtime:LargeTransferRuntime={journalPath:path.join(root,'journal.sqlite'),projectId:'configured-project',native:remote,authority};
  registerLargeTransferTools(server,identity,enabled?runtime:undefined,remote,async()=>{});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);
  t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
  return {client,counts:()=>({reads,writes,publishes})};
}
test('large transfer MCP surface is absent without trusted runtime or account identity',async t=>{
  const a=await fixture(t,auth,false),b=await fixture(t,{kind:'static',scope:'mcp'});
  for(const f of [a,b]){
    assert.deepEqual((await f.client.listTools()).tools.map(x=>x.name),['fixture_status']);
    const result=await f.client.callTool({name:'large_file_transfer_start',arguments:{source_device_id:'s',target_device_id:'t',source_path:'source',target_path:'target'}});
    assert.equal(result.isError,true);
    assert.deepEqual(f.counts(),{reads:0,writes:0,publishes:0});
  }
});
test('MCP full explicit device grants are required before native read or mutation',async t=>{
  const f=await fixture(t,{...auth,deviceAccessModes:{s:'full',t:'safe'}});
  const r=await f.client.callTool({name:'large_file_transfer_start',arguments:{source_device_id:'s',target_device_id:'t',source_path:'source',target_path:'target'}});
  assert.equal((r.structuredContent as {ok:boolean}).ok,false);
  assert.deepEqual(f.counts(),{reads:0,writes:0,publishes:0});
});
test('MCP durable job survives separate calls, scoped status and bounded advance',async t=>{
  const f=await fixture(t,auth);
  const common={source_device_id:'s',target_device_id:'t'};
  const start=await f.client.callTool({name:'large_file_transfer_start',arguments:{...common,source_path:'source',target_path:'target'}});
  const response=start.structuredContent as {ok:boolean;data:{id:string;state:string}};
  assert.equal(response.ok,true);assert.equal(response.data.state,'READY');
  const transfer_id=response.data.id;
  const denied=await f.client.callTool({name:'large_file_transfer_status',arguments:{...common,target_device_id:'foreign',transfer_id}});
  assert.equal((denied.structuredContent as {ok:boolean}).ok,false);
  const step=await f.client.callTool({name:'large_file_transfer_advance',arguments:{...common,transfer_id,max_chunks:1}});
  assert.equal((step.structuredContent as {data:{state:string}}).data.state,'VERIFIED');
  const final=await f.client.callTool({name:'large_file_transfer_advance',arguments:{...common,transfer_id,max_chunks:1}});
  assert.equal((final.structuredContent as {data:{state:string}}).data.state,'COMPLETE');
  const status=await f.client.callTool({name:'large_file_transfer_status',arguments:{...common,transfer_id}});
  assert.equal((status.structuredContent as {data:{state:string}}).data.state,'COMPLETE');
  assert.equal(f.counts().writes,1);assert.equal(f.counts().publishes,1);
  assert.equal(JSON.stringify(status).includes('test-only-lease-token'),false);
});
