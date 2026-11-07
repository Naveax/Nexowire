import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import WebSocket, {WebSocketServer} from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';
import {
  bindRemoteAgentMutationReauthorization,
  hasTrustedRemoteAgentGrant,
} from '../src/mcp/http.js';
import type {RemoteAgentAuthorization} from '../src/hub/control-plane-agent-auth.js';

const DEVICE='disposable-remote-agent';
const HEADER='Bearer nwx_dev_disposable_test_credential';

async function until(predicate:()=>boolean,description:string,timeoutMs=3000){
  const deadline=Date.now()+timeoutMs;
  while(!predicate()&&Date.now()<deadline)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(predicate(),description);
}

async function fixture(t:TestContext){
  const broker=new AgentBroker({requireMutationReauthorization:true,reconnectGraceMs:100});
  const server=createServer();
  let admissionCalls=0;
  let dispatchCalls=0;
  let revoked=false;
  let currentEpoch=7;
  const grant=()=>({
    deviceId:DEVICE,ownerId:'owner-disposable',
    authorizationEpoch:currentEpoch,leaseExpiresAtMs:Date.now()+10_000,
  });
  const verifier=async()=>{
    dispatchCalls++;
    return revoked?undefined:grant();
  };
  const wss=attachAgentWebSocketServer(server,broker,[],{
    remoteOnly:true,heartbeatMs:250,helloTimeoutMs:1200,
    authorizationCheckMs:500,authorizationTimeoutMs:600,
    remoteCredentialVerifier:async()=>{
      admissionCalls++;
      return revoked?undefined:grant();
    },
    remoteMutationAuthorizationFactory:(evidence:RemoteAgentAuthorization,authorizationHeader)=>{
      if(!hasTrustedRemoteAgentGrant(evidence))return undefined;
      return bindRemoteAgentMutationReauthorization({
        grant:evidence,
        authorizationHeader,
        verify:verifier,
        timeoutMs:500,
      });
    },
  });
  const clients:WebSocket[]=[];
  t.after(async()=>{
    for(const client of clients)client.terminate();
    for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const url=`ws://127.0.0.1:${address.port}/agent`;
  async function dial(deviceId=DEVICE){
    const socket=new WebSocket(url,{headers:{authorization:HEADER}});
    socket.on('error',()=>{});
    clients.push(socket);
    await new Promise<void>((resolve,reject)=>{
      socket.once('open',resolve);
      socket.once('error',reject);
    });
    socket.send(JSON.stringify({
      type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,
      instanceId:randomUUID(),
      device:{id:deviceId,name:'Disposable',platform:process.platform,
        arch:process.arch,agentVersion:'test',
        capabilities:['machine.snapshot','files.write']},
    }));
    return socket;
  }
  return {
    broker,wss,dial,
    setRevoked:(v:boolean)=>{revoked=v;},
    rotateEpoch:()=>{currentEpoch++;},
    metrics:()=>({admissionCalls,dispatchCalls}),
  };
}

test('strict owner/device/epoch socket: real command ACK then revocation blocks the next mutation frame',async t=>{
  const f=await fixture(t);
  const socket=await f.dial();
  await until(()=>f.broker.has(DEVICE),'strict Agent handshake must register the device');
  const frames:unknown[]=[];
  socket.on('message',raw=>{
    const msg=JSON.parse(raw.toString()) as {type?:string;requestId?:string};
    if(msg.type!=='request'||!msg.requestId)return;
    frames.push(msg);
    socket.send(JSON.stringify({
      type:'response',requestId:msg.requestId,ok:true,data:{acknowledged:true},
    }));
  });
  const result=await f.broker.request(DEVICE,'machine.snapshot',{},1800,randomUUID());
  assert.deepEqual(result,{acknowledged:true});
  assert.equal(frames.length,1);
  assert.ok(f.metrics().dispatchCalls>=1);
  f.setRevoked(true);
  await assert.rejects(
    f.broker.request(DEVICE,'files.write',{path:'disposable.txt',content:'never'},1200,randomUUID()),
    {code:'AGENT_AUTH_REVOKED'},
  );
  assert.equal(frames.length,1,'revoked owner must not dispatch a second frame');
});

test('strict remote Agent refuses a different device identity after HTTP 101',async t=>{
  const f=await fixture(t);
  const socket=await f.dial('different-disposable-device');
  await until(()=>socket.readyState===WebSocket.CLOSED,'wrong device hello must close');
  assert.equal(f.broker.has(DEVICE),false);
  assert.equal(f.broker.has('different-disposable-device'),false);
  assert.equal(f.wss.clients.size,0);
});

test('strict remote Agent rejects stale authorization epoch without duplicate request execution',async t=>{
  const f=await fixture(t);
  const socket=await f.dial();
  await until(()=>f.broker.has(DEVICE),'connected before epoch rotation');
  let received=0;
  socket.on('message',raw=>{
    const msg=JSON.parse(raw.toString()) as {type?:string};
    if(msg.type==='request')received++;
  });
  f.rotateEpoch();
  await assert.rejects(
    f.broker.request(DEVICE,'machine.snapshot',{},1000,randomUUID()),
    {code:'AGENT_AUTH_REVOKED'},
  );
  assert.equal(received,0);
  assert.equal(f.metrics().dispatchCalls,1,'revoked socket must not repeat authority checks');
});
