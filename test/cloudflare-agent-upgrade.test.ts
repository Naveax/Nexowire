import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {createLocalFirstIngressServer,closeLocalFirstAgentSockets,verifyLocalFirstPublicUpstream} from '../src/mcp/local-first-ingress.js';
import {cloudflareConnectionConfig} from '../src/mcp/local-first-cloudflare.js';
import {loadConfig} from '../src/config.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';

async function until(predicate:()=>boolean){const end=Date.now()+4000;
  while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());}
async function fixture(t:TestContext){
  const hub=createServer(),broker=new AgentBroker({reconnectGraceMs:100});
  const tokens=new Map([['nwx_dev_pc-one','pc-one'],['nwx_dev_pc-two','pc-two']]);
  const wss=attachAgentWebSocketServer(hub,broker,['nwx_dev_legacy-shared'],{
    remoteOnly:true,authorizationCheckMs:250,authorizationTimeoutMs:250,
    remoteCredentialVerifier:async header=>{const id=tokens.get(header?.replace('Bearer ','')??'');return id?{deviceId:id}:undefined;},
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  const address=hub.address();assert.ok(address&&typeof address!=='string');
  const origin=createLocalFirstIngressServer({hubPort:address.port,listenPort:43111,
    publicHostname:'mcp.example.test',allowAgentWebSocket:true});
  await new Promise<void>(r=>origin.listen(0,'127.0.0.1',r));
  const listener=origin.address();assert.ok(listener&&typeof listener!=='string');
  const sockets:WebSocket[]=[];
  t.after(async()=>{
    for(const s of sockets)s.terminate();closeLocalFirstAgentSockets(origin);
    for(const s of wss.clients)s.terminate();
    await new Promise<void>(r=>origin.close(()=>r()));
    await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>hub.close(()=>r()));
  });
  const url=`ws://127.0.0.1:${listener.port}/agent`;
  const dial=(token:string)=>{const s=new WebSocket(url,{headers:{authorization:'Bearer '+token}});s.on('error',()=>{});sockets.push(s);return s;};
  async function connect(id:string,token:string){const s=dial(token);
    await new Promise<void>((resolve,reject)=>{s.once('open',resolve);s.once('error',reject);});
    s.send(JSON.stringify({type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId:randomUUID(),
      device:{id,name:id,platform:process.platform,arch:process.arch,agentVersion:'test',capabilities:['machine.snapshot','files.write']}}));
    return s;
  }
  return {broker,tokens,connect,dial};
}
test('two device-bound Agents reach the same Hub through the fixed Cloudflare origin without Tailscale',async t=>{
  const f=await fixture(t);
  for(const [id,token] of [['pc-one','nwx_dev_pc-one'],['pc-two','nwx_dev_pc-two']]){
    const socket=await f.connect(id!,token!);
    socket.on('message',raw=>{const req=JSON.parse(raw.toString());
      socket.send(JSON.stringify({type:'response',requestId:req.requestId,ok:true,data:{device:id}}));});
  }
  await until(()=>f.broker.has('pc-one')&&f.broker.has('pc-two'));
  assert.deepEqual(await f.broker.request('pc-one','machine.snapshot',{},1000),{device:'pc-one'});
  assert.deepEqual(await f.broker.request('pc-two','machine.snapshot',{},1000),{device:'pc-two'});
});
test('shared local fallback credential is rejected before downstream WebSocket upgrade',async t=>{
  const f=await fixture(t);const socket=f.dial('nwx_dev_legacy-shared');let opened=false;
  socket.once('open',()=>{opened=true;});
  const code=await new Promise<number>(resolve=>socket.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode!);socket.terminate();}));
  assert.equal(code,401);assert.equal(opened,false);
});
test('wrong hello identity cannot register through the tunnel',async t=>{
  const f=await fixture(t);const socket=await f.connect('pc-two','nwx_dev_pc-one');
  const code=await new Promise<number>(resolve=>socket.once('close',resolve));
  assert.equal(code,1008);assert.equal(f.broker.has('pc-two'),false);assert.equal(f.broker.has('pc-one'),false);
});
test('revocation crosses the bridge and leaves a dispatched mutation UNKNOWN without replay',async t=>{
  const f=await fixture(t);const socket=await f.connect('pc-one','nwx_dev_pc-one');await until(()=>f.broker.has('pc-one'));
  let dispatched=0;socket.on('message',()=>{dispatched++;});
  const outcome=f.broker.request('pc-one','files.write',{path:'disposable',content:'not executed'},2000)
    .then(()=>undefined,error=>error);
  await until(()=>dispatched===1);f.tokens.delete('nwx_dev_pc-one');
  await until(()=>socket.readyState===WebSocket.CLOSED&&!f.broker.has('pc-one'));
  assert.equal((await outcome)?.code,'MUTATION_STATE_UNKNOWN');assert.equal(dispatched,1);
});
test('publishing Agent path requires both explicit profile opt-in and actual remote-only Hub contract',async()=>{
  const config=loadConfig({NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-1234',NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp'});
  const profile={version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),binary:process.execPath,
    binarySha256:'a'.repeat(64),credentialsFile:process.execPath,publishAgentEndpoint:true};
  assert.throws(()=>cloudflareConnectionConfig(profile,config),/remote-only/);
  config.remoteAgentAuthOnly=true;
  assert.ok(new RegExp(cloudflareConnectionConfig(profile,config).tunnelConfig.ingress[0]!.path!).test('/agent'));
  await assert.rejects(verifyLocalFirstPublicUpstream({hubPort:43110,expectedResourceUrl:config.mcpResourceUrl!,
    requireRemoteAgentAdmission:true,fetchImpl:async()=>Response.json({ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true}})}),/remote-only/);
  assert.throws(()=>attachAgentWebSocketServer(createServer(),new AgentBroker(),[],{remoteOnly:true}),/authority/);
});
