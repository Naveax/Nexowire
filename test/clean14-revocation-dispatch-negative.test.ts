import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';

/**
 * Independent, intentionally RED V2-07 handoff regression.
 * All sockets and credentials are disposable loopback fixtures. A revocation
 * that arrives after 101 but before the 60s socket timer MUST deny the next
 * mutation dispatch. The current AgentBroker has no such authority fence.
 */
test('CLEAN-14 P1-C / V2-07 RED: revoked owner/device cannot dispatch mutation before 60s socket check',{
  timeout:8000,
},async t=>{
  const deviceId='disposable-v2-02-device';
  const token='nwx_dev_disposable-v2-02-credential';
  let revoked=false;
  const server=createServer();
  const broker=new AgentBroker({reconnectGraceMs:100});
  const wss=attachAgentWebSocketServer(server,broker,[],{
    remoteOnly:true,
    heartbeatMs:60000,
    authorizationCheckMs:60000,
    authorizationTimeoutMs:1000,
    remoteCredentialVerifier:async header=>
      header==='Bearer '+token&&!revoked?{deviceId}:undefined,
  });
  const agentSockets:WebSocket[]=[];
  t.after(async()=>{
    for(const socket of agentSockets)socket.terminate();
    for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const agent=new WebSocket(`ws://127.0.0.1:${address.port}/agent`,{
    headers:{authorization:'Bearer '+token},
  });
  agentSockets.push(agent);
  agent.on('error',()=>{});
  await new Promise<void>((resolve,reject)=>{
    agent.once('open',resolve);
    agent.once('error',reject);
  });
  agent.send(JSON.stringify({
    type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId:randomUUID(),
    device:{id:deviceId,name:'Disposable',platform:process.platform,
      arch:process.arch,agentVersion:'test',capabilities:['files.write']},
  }));
  const deadline=Date.now()+3000;
  while(!broker.has(deviceId)&&Date.now()<deadline)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(broker.has(deviceId),true,'fixture must establish an authenticated 101 session');

  // Authority has revoked the device; 60-second websocket revalidation has
  // not run. Dispatch-time mutation checks must reject this exact window.
  revoked=true;
  const received=new Promise<boolean>(resolve=>{
    const timer=setTimeout(()=>resolve(false),350);
    agent.on('message',raw=>{
      try{
        const message=JSON.parse(raw.toString()) as {type?:string;capability?:string};
        if(message.type==='request'&&message.capability==='files.write'){
          clearTimeout(timer);
          resolve(true);
        }
      }catch{}
    });
  });
  // The disposable Agent never executes files.write. Seeing the request is
  // sufficient proof that revoked authority reached the dispatch boundary.
  const operation=broker.request(deviceId,'files.write',{path:'synthetic'},800);
  void operation.catch(()=>undefined);
  assert.equal(await received,false,
    'revoked owner/device dispatched a mutation before 60-second socket revalidation');
});
