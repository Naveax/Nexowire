import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {AddressInfo} from 'node:net';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {createControlPlaneAgentCredentialVerifier} from '../src/hub/control-plane-agent-auth.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';

/** Real disposable TCP HTTP authority -> Hub WebSocket -> AgentBroker. */
async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return (address as AddressInfo).port;
}
async function waitUntil(predicate:()=>boolean,deadlineMs=3500){
  const signal=AbortSignal.timeout(deadlineMs);
  while(!predicate()){
    if(signal.aborted)throw Error('bounded condition not reached');
    await pause(15,undefined,{signal});
  }
}
async function fixture(t:import('node:test').TestContext){
  const device='v206-dispatch-device';
  const credential='nwx_dev_v206_dispatch_authority_token';
  const service='v206-disposable-service-token-1234567890';
  let revoked=false;
  let verifierCalls=0;
  const authority=createServer((req,res)=>{
    const data:Buffer[]=[];
    req.on('data',(b:Buffer)=>data.push(b));
    req.once('end',()=>{
      verifierCalls++;
      let supplied='';
      try{supplied=JSON.parse(Buffer.concat(data).toString('utf8')).credential??'';}catch{}
      const authenticated=req.method==='POST'&&req.url==='/api/v1/internal/device/authenticate'&&
        req.headers.authorization==='Bearer '+service&&supplied===credential&&!revoked;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(authenticated?{authenticated:true,device:{deviceId:device}}:
        {authenticated:false}));
    });
  });
  const port=await listen(authority);
  const broker=new AgentBroker({reconnectGraceMs:100});
  const verifier=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'http://127.0.0.1:'+port,serviceToken:service,timeoutMs:1250,
  });
  const hub=createServer();
  const wss=attachAgentWebSocketServer(hub,broker,[],{
    remoteOnly:true,remoteCredentialVerifier:verifier,
    authorizationCheckMs:60000,authorizationTimeoutMs:1500,heartbeatMs:60000,
  });
  const hubPort=await listen(hub);
  const agent=new WebSocket('ws://127.0.0.1:'+hubPort+'/agent',{
    handshakeTimeout:3000,headers:{authorization:'Bearer '+credential},
  });
  agent.on('error',()=>{});
  t.after(async()=>{
    agent.terminate();
    for(const ws of wss.clients)ws.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    hub.closeAllConnections();
    await new Promise<void>(resolve=>hub.close(()=>resolve()));
    authority.closeAllConnections();
    await new Promise<void>(resolve=>authority.close(()=>resolve()));
  });
  await once(agent,'open',{signal:AbortSignal.timeout(4000)});
  const instanceId=randomUUID();
  agent.send(JSON.stringify({type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId,
    device:{id:device,name:'Disposable',platform:process.platform,
      arch:process.arch,agentVersion:'test',capabilities:['files.write']}}));
  await waitUntil(()=>broker.has(device));
  let dispatched=0;
  agent.on('message',raw=>{
    try{const msg=JSON.parse(raw.toString());
      if(msg.type==='request'&&msg.capability==='files.write')dispatched++;
    }catch{}
  });
  return {broker,device,agent,instanceId,
    revoke:()=>{revoked=true;},
    get verifierCalls(){return verifierCalls;},
    get dispatched(){return dispatched;}};
}
test('V2-06 R2 revocation between 60s checks denies mutation at dispatch with exact AUTH_REVOKED reason',{
  timeout:10000,
},async t=>{
  const f=await fixture(t);
  assert.equal(f.verifierCalls,1,'real HTTP authority must authenticate initial 101');
  f.revoke();
  assert.equal(f.broker.has(f.device),true,
    'WebSocket is still open before the 60s scheduled check; no false offline denial');
  const requestId=randomUUID();
  await assert.rejects(f.broker.request(f.device,'files.write',{path:'disposable'},700,requestId),
    {code:'AGENT_AUTH_REVOKED'},
    'a revoked device must be denied by the dispatch-time authority, not an unrelated timeout/offline error');
  assert.equal(f.verifierCalls,2,'dispatch must perform a new actual HTTP authorization check');
  assert.equal(f.dispatched,0,'ZERO mutation frames after revoke, not just zero completed writes');
});
test('V2-06 R2 duplicate mutation UUID while pending is rejected; lost ACK remains UNKNOWN without replay',{
  timeout:10000,
},async t=>{
  const f=await fixture(t);
  const requestId=randomUUID();
  const first=f.broker.request(f.device,'files.write',{path:'disposable'},700,requestId)
    .then(()=>({code:'UNEXPECTED_SUCCESS'}),error=>({code:error?.code as string|undefined}));
  await waitUntil(()=>f.dispatched===1);
  await assert.rejects(f.broker.request(f.device,'files.write',{path:'disposable'},700,requestId),
    {code:'AGENT_REQUEST_EXISTS'},'same mutation UUID cannot produce two pending Agent sends');
  assert.equal((await first).code,'MUTATION_STATE_UNKNOWN',
    'missing ACK after dispatch is UNKNOWN, not CANCELLED or safely retryable');
  assert.equal(f.dispatched,1,'no automatic second frame');
  // Stale response arrives after terminal UNKNOWN, with its exact old UUID.
  f.agent.send(JSON.stringify({type:'response',requestId,ok:true,data:{wrong:'late-ack'}}));
  await pause(50);
  assert.equal(f.dispatched,1,'stale ACK must not trigger mutation replay');
});
