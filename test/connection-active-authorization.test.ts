import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer,type AgentWebSocketServerOptions} from '../src/hub/agent-websocket.js';
import {CredentialStore} from '../src/security/credential-store.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';
import {createControlPlaneAgentCredentialVerifier} from '../src/hub/control-plane-agent-auth.js';

const DEVICE='connection-core-device';
const TOKEN='nwx_dev_disposable-session-credential';
async function until(predicate:()=>boolean){
  const end=Date.now()+4000;
  while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.ok(predicate(),'condition must hold within bounded test deadline');
}
async function fixture(t:TestContext,options:AgentWebSocketServerOptions){
  const server=createServer();const broker=new AgentBroker({reconnectGraceMs:100});
  const wss=attachAgentWebSocketServer(server,broker,[],{
    heartbeatMs:5000,authorizationCheckMs:250,authorizationTimeoutMs:250,...options,
  });
  const sockets:WebSocket[]=[];
  t.after(async()=>{
    for(const socket of sockets)socket.terminate();
    for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(r=>wss.close(()=>r()));
    await new Promise<void>(r=>server.close(()=>r()));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`ws://127.0.0.1:${address.port}/agent`;
  function dial(token=TOKEN){
    const socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token}});
    socket.on('error',()=>{});sockets.push(socket);return socket;
  }
  async function connect(token=TOKEN){
    const socket=dial(token);
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    socket.send(JSON.stringify({type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId:randomUUID(),
      device:{id:DEVICE,name:'Disposable',platform:process.platform,arch:process.arch,
        agentVersion:'test',capabilities:['machine.snapshot','files.write']}}));
    await until(()=>broker.has(DEVICE));return socket;
  }
  return {broker,wss,dial,connect};
}

test('persisted credential revocation terminates an already-open Agent socket',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-active-auth-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new CredentialStore(root);await store.initialize();
  const issued=await store.issue('agent');
  const f=await fixture(t,{credentialStore:store});const socket=await f.connect(issued.token);
  await store.revoke(issued.credential.id);
  await until(()=>socket.readyState===WebSocket.CLOSED&&!f.broker.has(DEVICE));
  await assert.rejects(f.broker.request(DEVICE,'machine.snapshot',{},100),{code:'AGENT_OFFLINE'});
});

for(const failure of ['revoked','different-device','exception','timeout'] as const){
  test(`open remote session fails closed on ${failure}, without anonymous fallback`,async t=>{
    let invalid=false;let calls=0;
    const f=await fixture(t,{remoteCredentialVerifier:async()=>{
      calls++;
      if(!invalid)return {deviceId:DEVICE};
      if(failure==='exception')throw Error('private backend failure');
      if(failure==='timeout')return await new Promise(()=>{});
      return failure==='different-device'?{deviceId:'another-owner-device'}:undefined;
    }});
    const socket=await f.connect();invalid=true;
    await until(()=>socket.readyState===WebSocket.CLOSED&&!f.broker.has(DEVICE));
    assert.equal(calls,2,'no overlapping or repeated revalidation after failure');
    assert.equal(f.broker.has('another-owner-device'),false);
  });
}

test('pending handshake timeout cannot be revived by late verification success',async t=>{
  let release!:(v:{deviceId:string})=>void;
  let signal:AbortSignal|undefined;
  const f=await fixture(t,{remoteCredentialVerifier:(_header,s)=>{
    signal=s;return new Promise(resolve=>{release=resolve;});
  }});
  const socket=f.dial();let opened=false;socket.once('open',()=>{opened=true;});
  const status=await new Promise<number>(resolve=>{
    socket.once('unexpected-response',(_req,response)=>{resolve(response.statusCode!);response.resume();socket.terminate();});
  });
  assert.equal(status,401);assert.equal(signal?.aborted,true);
  release({deviceId:DEVICE});await new Promise(r=>setTimeout(r,20));
  assert.equal(opened,false);assert.equal(f.wss.clients.size,0);assert.equal(f.broker.has(DEVICE),false);
});

test('healthy remote session revalidates serially; closing aborts its pending verification',async t=>{
  let calls=0;let pendingSignal:AbortSignal|undefined;let release!:(v:{deviceId:string})=>void;
  const f=await fixture(t,{remoteCredentialVerifier:async(_header,signal)=>{
    calls++;
    if(calls<3)return {deviceId:DEVICE};
    pendingSignal=signal;return await new Promise(resolve=>{release=resolve;});
  }});
  const socket=await f.connect();await until(()=>calls===3);
  socket.terminate();await until(()=>pendingSignal?.aborted===true);
  release({deviceId:DEVICE});await until(()=>!f.broker.has(DEVICE));
  assert.equal(calls,3);
});

test('control-plane fetch receives caller cancellation during active authorization',async()=>{
  let observed:AbortSignal|undefined;
  const verifier=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'https://control.example.test',serviceToken:'disposable-service-token-12345',
    fetchImpl:async(_url,init)=>{
      observed=init?.signal??undefined;
      return await new Promise((_resolve,reject)=>observed!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    },
  });
  const controller=new AbortController();const result=verifier('Bearer '+TOKEN,controller.signal);
  controller.abort();assert.equal(await result,undefined);assert.equal(observed?.aborted,true);
});
