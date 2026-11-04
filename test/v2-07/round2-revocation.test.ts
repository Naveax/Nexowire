import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import WebSocket, {WebSocketServer} from 'ws';
import {AgentBroker} from '../../src/core/agent-broker.js';
import {AgentHelloSchema, AGENT_PROTOCOL_VERSION} from '../../src/protocol/agent.js';

type Authorizer = () => Promise<boolean>;
type Received = {type: string; requestId: string; capability: string};
const delay = (ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const observed = (p:Promise<unknown>) => p.then(
  value => ({ok:true as const,value}),
  (error:unknown) => ({ok:false as const,code:(error as {code?:string}).code}),
);

async function eventually(check:()=>boolean, timeoutMs=1_500):Promise<void> {
  const until=Date.now()+timeoutMs;
  while(!check() && Date.now()<until)await delay(5);
  assert.ok(check(),'fixture condition must be met within its deadline');
}

async function fixture(t: import('node:test').TestContext) {
  // This exercises the V2-07 broker epoch/dispatch callback using real
  // loopback WebSocket frames, NOT the V2-03 ingress trust boundary.
  const server=createServer();
  const wss=new WebSocketServer({server});
  const broker=new AgentBroker({reconnectGraceMs:300,maxReadOnlyReplays:1});
  const verifiers:Authorizer[]=[];
  const clients:WebSocket[]=[];
  const accepted:WebSocket[]=[];
  wss.on('connection',socket=>{
    accepted.push(socket);
    const reauthorize=verifiers.shift();
    socket.once('message',raw=>{
      const hello=AgentHelloSchema.parse(JSON.parse(raw.toString()));
      broker.register(socket,hello,reauthorize);
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  t.after(async()=>{
    for(const socket of clients)socket.terminate();
    for(const socket of accepted)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  async function connect(
    deviceId:string,
    instanceId:string,
    epoch:number,
    authorizer:Authorizer,
  ) {
    verifiers.push(authorizer);
    const socket=new WebSocket('ws://127.0.0.1:'+port);
    socket.on('error',()=>undefined);
    clients.push(socket);
    const received:Received[]=[];
    socket.on('message',raw=>{
      const value=JSON.parse(raw.toString()) as Received;
      if(value.type==='request')received.push(value);
    });
    await new Promise<void>((resolve,reject)=>{
      socket.once('open',resolve);
      socket.once('error',reject);
    });
    socket.send(JSON.stringify({
      type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId,
      device:{id:deviceId,name:'Synthetic '+deviceId,
        platform:'linux',arch:'x64',agentVersion:'test',
        capabilities:['machine.snapshot','files.write']},
    }));
    await eventually(()=>broker.getConnectionHealth(deviceId)?.epoch===epoch);
    return {socket,received,serverSocket:accepted[accepted.length-1]!};
  }
  return {broker,connect};
}

test('round2: revocation before the 60s socket check blocks new mutation with zero frames',async t=>{
  const f=await fixture(t);
  let revoked=false;
  let checks=0;
  const a=await f.connect('revoked-device',randomUUID(),1,async()=>{
    checks++;
    return !revoked;
  });
  assert.equal(f.broker.getConnectionHealth('revoked-device')?.state,'AUTHENTICATED_ONLINE');
  revoked=true;
  const res=await observed(f.broker.request('revoked-device','files.write',{path:'synthetic'},600));
  assert.deepEqual(res,{ok:false,code:'AGENT_AUTH_REVOKED'});
  assert.equal(checks,1,'per-mutation authorization must be called');
  await delay(30);
  assert.equal(a.received.length,0,'revoked device receives no mutating frame');
});

test('round2: unavailable or rejecting device authority fails closed with no dispatch',async t=>{
  const f=await fixture(t);
  const a=await f.connect('unavailable',randomUUID(),1,async()=>{
    throw new Error('synthetic owner authority offline');
  });
  const res=await observed(f.broker.request('unavailable','files.write',{},500));
  assert.deepEqual(res,{ok:false,code:'AGENT_AUTH_REVOKED'});
  assert.equal(a.received.length,0);
});

test('round2: revoke during async authorization fails closed before dispatch',async t=>{
  const f=await fixture(t);
  let release!:()=>void;
  let started=false;
  let revoked=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const a=await f.connect('raced-revoke',randomUUID(),1,async()=>{
    started=true;
    await gate;
    return !revoked;
  });
  const result=observed(f.broker.request('raced-revoke','files.write',{synthetic:true},800));
  await eventually(()=>started);
  revoked=true;
  release();
  assert.deepEqual(await result,{ok:false,code:'AGENT_AUTH_REVOKED'});
  assert.equal(a.received.length,0);
});

test('round2: reauthorize on old socket cannot authorize a new Agent epoch',async t=>{
  const f=await fixture(t);
  let release!:()=>void;
  let started=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const old=await f.connect('same-device',randomUUID(),1,async()=>{
    started=true;
    await gate;
    return true;
  });
  const pending=observed(f.broker.request('same-device','files.write',
    {synthetic:true},900,randomUUID()));
  await eventually(()=>started);
  const fresh=await f.connect('same-device',randomUUID(),2,async()=>true);
  release();
  const outcome=await pending;
  assert.equal(outcome.ok,false);
  assert.equal(outcome.code,'AGENT_OFFLINE');
  await delay(30);
  assert.equal(old.received.length,0);
  assert.equal(fresh.received.length,0,'old authorization cannot dispatch to new epoch');
});

test('round2: concurrent same UUID cannot dispatch twice after async authorization',async t=>{
  const f=await fixture(t);
  const id=randomUUID();
  let checks=0;
  const a=await f.connect('duplicate-admission',randomUUID(),1,async()=>{
    checks++;
    await delay(15);
    return true;
  });
  const first=observed(f.broker.request('duplicate-admission','files.write',
    {payload:'same'},800,id));
  const second=observed(f.broker.request('duplicate-admission','files.write',
    {payload:'same'},800,id));
  await eventually(()=>a.received.length===1);
  assert.equal(a.received[0]?.requestId,id);
  assert.equal(checks,2,'both contenders must validate independently');
  const conflict=await second;
  assert.deepEqual(conflict,{ok:false,code:'AGENT_REQUEST_EXISTS'});
  a.socket.terminate();  // lost ACK before mutating response, never resend
  assert.deepEqual(await first,{ok:false,code:'MUTATION_STATE_UNKNOWN'});
  const next=await f.connect('duplicate-admission',randomUUID(),2,async()=>true);
  await delay(40);
  assert.equal(next.received.length,0,'reconnect must not replay UUID');
});

test('round2: post-dispatch revocation and lost ACK remain UNKNOWN, never auto-replayed',async t=>{
  const f=await fixture(t);
  const operationId=randomUUID();
  let authorized=true;
  const sameInstanceId=randomUUID();
  const old=await f.connect('ack-lost',sameInstanceId,1,async()=>authorized);
  const first=observed(f.broker.request('ack-lost','files.write',
    {operation:'one'},1_000,operationId));
  await eventually(()=>old.received.length===1);
  authorized=false;
  old.socket.terminate();
  await eventually(()=>!f.broker.has('ack-lost'));
  const next=await f.connect('ack-lost',sameInstanceId,2,async()=>authorized);
  assert.deepEqual(await first,{ok:false,code:'MUTATION_STATE_UNKNOWN'});
  assert.equal(next.received.length,0);
  const denied=await observed(f.broker.request('ack-lost','files.write',
    {operation:'one'},500,operationId));
  assert.deepEqual(denied,{ok:false,code:'AGENT_AUTH_REVOKED'});
  assert.equal(next.received.length,0);
});

test('round2: stale ACK cannot finish a pending read on an incarnated Agent',async t=>{
  const f=await fixture(t);
  const req=randomUUID(),instance=randomUUID();
  const old=await f.connect('stale-ack',instance,1,async()=>true);
  const read=observed(f.broker.request('stale-ack','machine.snapshot',
    {},1_000,req));
  await eventually(()=>old.received.length===1);
  const fresh=await f.connect('stale-ack',instance,2,async()=>true);
  await eventually(()=>fresh.received.length===1);
  old.serverSocket.emit('message',JSON.stringify({
    type:'response',requestId:req,ok:true,data:{unsafe:true},
  }));
  await delay(20);
  assert.equal(f.broker.getConnectionHealth('stale-ack')?.lastAgentAckAt,undefined);
  fresh.socket.send(JSON.stringify({
    type:'response',requestId:req,ok:true,data:{verified:true},
  }));
  assert.deepEqual(await read,{ok:true,value:{verified:true}});
});
