import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../src/core/agent-broker.js';
import {ProviderRegistry} from '../src/core/provider-registry.js';
import {AgentProvider} from '../src/providers/agent-provider.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {createNexowireMcpServer} from '../src/mcp/create-server.js';
import {WorkspaceStore} from '../src/workspace/store.js';
import {SkillRegistry} from '../src/skills/registry.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

test('two independent sandboxed Nexowire agents exchange bounded file chunks without MCP payload exposure',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-two-devices-'));
 const sourceRoot=path.join(root,'src'),destRoot=path.join(root,'dst');
 await fs.mkdir(sourceRoot);await fs.mkdir(destRoot);
 const sourcePath=path.join(sourceRoot,'payload.bin');
 const destPath=path.join(destRoot,'final.bin');
 const file=Buffer.alloc(220*1024);for(let i=0;i<file.length;i++)file[i]=i%241;
 await fs.writeFile(sourcePath,file);
 const http=createServer(),broker=new AgentBroker();
 const wss=attachAgentWebSocketServer(http,broker,'two-device-token');
 await new Promise<void>(res=>http.listen(0,'127.0.0.1',res));
 const registry=new ProviderRegistry();registry.register(new AgentProvider(broker));
 const mcp=createNexowireMcpServer({broker,providers:registry,
   workspaces:new WorkspaceStore(path.join(root,'workspace')),
   skills:new SkillRegistry(path.join(process.cwd(),'skills'))});
 const client=new Client({name:'two-device-transfer-test',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([mcp.connect(b),client.connect(a)]);
 const sockets:WebSocket[]=[];
 t.after(async()=>{
  await client.close();await mcp.close();
  for(const socket of sockets)socket.close();
  for(const socket of wss.clients)socket.close();
  await new Promise<void>(res=>http.close(()=>res()));
  await fs.rm(root,{recursive:true,force:true});
 });
 const address=http.address();
 assert.ok(address&&typeof address==='object');
 let sourceReads=0,destinationWrites=0,atomicCommits=0;
 const open=async(name:string,root:string,capabilities:string[])=>{
  const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/agent',{
   headers:{Authorization:'Bearer two-device-token'}
  });
  sockets.push(ws);
  await new Promise<void>((res,rej)=>{ws.once('open',res);ws.once('error',rej)});
  ws.on('message',raw=>{
   const msg=JSON.parse(raw.toString()) as {
     type:string;requestId:string;capability:string;input:unknown;
   };
   if(msg.type!=='request')return;
   if(name==='source'&&msg.capability==='files.read')sourceReads++;
   if(name==='destination'&&msg.capability==='files.write')destinationWrites++;
   if(name==='destination'&&msg.capability==='files.move'&&
     typeof msg.input==='object'&&msg.input!==null&&
     (msg.input as {atomic_no_overwrite?:boolean}).atomic_no_overwrite===true)atomicCommits++;
   void(async()=>{
    try{
     const response=await executeCapability(msg.capability,msg.input,new PathPolicy([root]));
     ws.send(JSON.stringify({type:'response',requestId:msg.requestId,ok:true,data:response}));
    }catch(error){
     ws.send(JSON.stringify({type:'response',requestId:msg.requestId,ok:false,
      error:{code:'FIXTURE_REJECTED',
        message:error instanceof Error?error.message:'operation rejected'}}));
    }
   })();
  });
  ws.send(JSON.stringify({
   type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,
   instanceId:name==='source'?'33333333-3333-4333-8333-333333333333':
     '44444444-4444-4444-8444-444444444444',
   device:{id:name,name,platform:process.platform,arch:process.arch,
     agentVersion:'test',capabilities}
  }));
 };
 await open('source',sourceRoot,['files.stat','files.hash','files.read']);
 await open('destination',destRoot,['files.write','files.hash','files.move','files.delete']);
 for(let n=0;n<100&&(!broker.has('source')||!broker.has('destination'));n++)
  await new Promise(res=>setTimeout(res,10));
 assert.equal(broker.has('source'),true);
 assert.equal(broker.has('destination'),true);
 const tools=await client.listTools();
 assert.ok(tools.tools.some(x=>x.name==='file_transfer_between_devices'));
 const call=()=>client.callTool({name:'file_transfer_between_devices',arguments:{
  source_device_id:'source',destination_device_id:'destination',
  source_path:sourcePath,destination_path:destPath,max_bytes:1024*1024
 }});
 const first=await call();
 const body=first.structuredContent as {
   ok:boolean;data?:{bytesTransferred:number;sha256:string};error?:{code:string}
 };
 assert.equal(body?.ok,true,JSON.stringify(body));
 assert.equal(body.data?.bytesTransferred,file.length);
 assert.equal(body.data?.sha256,sha(file));
 assert.deepEqual(await fs.readFile(destPath),file);
 assert.equal(sourceReads,5);
 assert.equal(destinationWrites,5);
 assert.equal(atomicCommits,1,'transfer must request atomic no-overwrite publication');
 assert.equal(JSON.stringify(first).includes(file.subarray(0,50).toString('base64')),false);
 const second=await call();
 const rejected=second.structuredContent as {ok:boolean;error?:{code:string}};
 assert.equal(rejected.ok,false,'existing destination cannot be overwritten');
 assert.deepEqual(await fs.readFile(destPath),file);
 assert.deepEqual((await fs.readdir(destRoot)).filter(n=>n.includes('nexowire-upload-')),[]);
 const bad=await client.callTool({name:'file_transfer_between_devices',arguments:{
  source_device_id:'unknown',destination_device_id:'destination',
  source_path:sourcePath,destination_path:path.join(destRoot,'other.bin')
 }});
 assert.equal((bad.structuredContent as {ok:boolean}).ok,false);
 await assert.rejects(fs.stat(path.join(destRoot,'other.bin')));
});
