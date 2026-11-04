import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import type {AddressInfo} from 'node:net';
import WebSocket from 'ws';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {createControlPlaneAgentCredentialVerifier} from '../src/hub/control-plane-agent-auth.js';
import {createLocalFirstIngressServer,closeLocalFirstAgentSockets} from '../src/mcp/local-first-ingress.js';
import {AGENT_PROTOCOL_VERSION} from '../src/protocol/agent.js';

const SERVICE='disposable-service-token-v206-0123456789';
const CREDENTIAL='nwx_dev_disposable_v206_credential';
type Grant={deviceId:string;expiresAt:number;revoked:boolean};

async function listen(server:Server){
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return (address as AddressInfo).port;
}
async function close(server:Server){
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
}
/** Actual TCP+HTTP credential authority, actual Hub WebSocket, actual origin bridge. */
async function fixture(t:import('node:test').TestContext){
  const grants=new Map<string,Grant>([[CREDENTIAL,{deviceId:'device-v206',expiresAt:Date.now()+60000,revoked:false}]]);
  let authorizationRequests=0;
  const controlPlane=createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/api/v1/internal/device/authenticate'||
       req.headers.authorization!=='Bearer '+SERVICE){
      res.writeHead(403);res.end('{}');return;
    }
    const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>chunks.push(chunk));
    req.on('end',()=>{
      authorizationRequests++;
      let credential:string|undefined;
      try{credential=JSON.parse(Buffer.concat(chunks).toString('utf8')).credential;}catch{}
      const g=grants.get(credential??'');
      const allowed=Boolean(g&&!g.revoked&&g.expiresAt>Date.now());
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(allowed?{authenticated:true,device:{deviceId:g!.deviceId}}:
        {authenticated:false}));
    });
  });
  const controlPort=await listen(controlPlane);
  const verifier=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'http://127.0.0.1:'+controlPort,serviceToken:SERVICE,timeoutMs:1500,
  });
  const hub=createServer(),broker=new AgentBroker({reconnectGraceMs:100});
  const wss=attachAgentWebSocketServer(hub,broker,[],{
    remoteOnly:true,remoteCredentialVerifier:verifier,
    authorizationCheckMs:250,authorizationTimeoutMs:1500,heartbeatMs:5000,
  });
  const hubPort=await listen(hub);
  const origin=createLocalFirstIngressServer({
    hubPort,listenPort:43111,allowAgentWebSocket:true,publicHostname:'mcp.example.test',
  });
  const originPort=await listen(origin);
  const clients:WebSocket[]=[];
  t.after(async()=>{
    for(const socket of clients)socket.terminate();
    closeLocalFirstAgentSockets(origin);
    for(const socket of wss.clients)socket.terminate();
    await close(origin);
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await close(hub);
    await close(controlPlane);
  });
  const url='ws://127.0.0.1:'+originPort+'/agent';
  function dial(credential:string){
    const socket=new WebSocket(url,{headers:{authorization:'Bearer '+credential},handshakeTimeout:4000});
    socket.on('error',()=>{});clients.push(socket);return socket;
  }
  async function rejected(credential:string){
    const socket=dial(credential);
    return await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('bounded WSS rejection timed out')),4000);
      socket.once('unexpected-response',(_req,res)=>{
        clearTimeout(timer);res.resume();socket.terminate();resolve(res.statusCode??0);
      });
      socket.once('open',()=>{clearTimeout(timer);socket.terminate();reject(Error('HTTP 101 before verified device authentication'));});
      socket.once('close',()=>{clearTimeout(timer);});
    });
  }
  async function connect(credential:string=CREDENTIAL,helloId='device-v206'){
    const socket=dial(credential);
    await once(socket,'open',{signal:AbortSignal.timeout(4500)});
    socket.send(JSON.stringify({type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,
      instanceId:randomUUID(),
      device:{id:helloId,name:'Disposable',platform:process.platform,arch:process.arch,
        agentVersion:'test',capabilities:['machine.snapshot','files.write']}}));
    return socket;
  }
  async function brokerReady(){
    const timeout=AbortSignal.timeout(4500);
    while(!broker.has('device-v206')){
      if(timeout.aborted)throw Error('bound device did not reach Hub');
      await pause(15,undefined,{signal:timeout});
    }
  }
  return {grants,broker,wss,origin,dial,rejected,connect,brokerReady,
    get authorizationRequests(){return authorizationRequests;}};
}

test('V2-06 WSS remote-only Hub rejects wrong/shared/expired token before HTTP 101',
  {timeout:15000},async t=>{
  const f=await fixture(t);
  assert.equal(await f.rejected('nwx_dev_legacy_shared'),401);
  assert.equal(await f.rejected('nwx_dev_wrong_device'),401);
  f.grants.get(CREDENTIAL)!.expiresAt=Date.now()-1;
  assert.equal(await f.rejected(CREDENTIAL),401);
  assert.equal(f.wss.clients.size,0,'no unauthorized websocket upgraded');
  assert.equal(f.broker.has('device-v206'),false,'no unauthorized Agent registered');
  assert.equal(f.authorizationRequests,3,'three actual HTTP authority checks occurred');
});

test('V2-06 WSS device credential cannot register a different device in Agent hello',
  {timeout:15000},async t=>{
  const f=await fixture(t);
  const socket=await f.connect(CREDENTIAL,'other-device');
  const [code]=await once(socket,'close',{signal:AbortSignal.timeout(5000)});
  assert.equal(code,1008,'device-bound Hub denies mismatched hello');
  assert.equal(f.broker.has('other-device'),false);
  assert.equal(f.broker.has('device-v206'),false);
});

test('V2-06 real HTTP revocation closes WSS, retains dispatched mutation UNKNOWN and no replay',
  {timeout:15000},async t=>{
  const f=await fixture(t);
  const socket=await f.connect();
  await f.brokerReady();
  let dispatched=0;
  const dispatchedEvent=new Promise<void>(resolve=>socket.once('message',()=>{dispatched++;resolve();}));
  const outcome=f.broker.request('device-v206','files.write',
    {path:'disposable-only',content:'not written'},5000).then(
    ()=>({code:'unexpected-success'}),error=>({code:error?.code as string|undefined}));
  await Promise.race([dispatchedEvent,pause(4500).then(()=>{throw Error('mutation dispatch not observed');})]);
  f.grants.get(CREDENTIAL)!.revoked=true;
  await once(socket,'close',{signal:AbortSignal.timeout(5000)});
  assert.equal((await outcome).code,'MUTATION_STATE_UNKNOWN');
  assert.equal(dispatched,1,'a lost ACK must not trigger automatic mutation replay');
  assert.equal(f.broker.has('device-v206'),false);
  assert.equal(f.wss.clients.size,0,'Hub has no post-revoke WebSocket');
});
