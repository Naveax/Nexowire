import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {PrivilegedBrokerClient} from '../src/agent/privileged-broker-client.js';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

// Disposable loopback transport only. Never start an elevated process or
// execute Windows changes. The real Broker still enforces independent CAS.
const TOKEN='nexowire-disposable-broker-transport-token';

async function loopbackFixture(t:TestContext){
  const received:Array<Record<string,unknown>>=[];
  const server=createServer(async(req,res)=>{
    let raw='';
    for await(const chunk of req)raw+=chunk.toString();
    received.push(JSON.parse(raw) as Record<string,unknown>);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,data:{transportOnly:true}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  return {received,client:new PrivilegedBrokerClient({
    url:`http://127.0.0.1:${address.port}`,token:TOKEN,
  })};
}

test('Broker client transports the existing operation UUID with the frozen effect request',async t=>{
  const f=await loopbackFixture(t);
  const id=randomUUID();
  const input={name:'Synthetic-Not-Installed',action:'status'};
  assert.deepEqual(await f.client.execute('windows.installer.status',input,id),
    {transportOnly:true});
  assert.equal(f.received.length,1);
  assert.equal(f.received[0]?.operation_id,id);
  assert.equal(f.received[0]?.capability,'windows.installer.status');
  assert.deepEqual(f.received[0]?.input,input);
});

test('Native Agent broker-mode executor forwards its request UUID, never creates a new one',async t=>{
  const f=await loopbackFixture(t);
  const id=randomUUID();
  const result=await executeCapability(
    'windows.installer.status',{},new PathPolicy([os.homedir()]),
    {privilegeMode:'broker',privilegedBroker:f.client,requestId:id,accessMode:'full'},
  );
  assert.deepEqual(result,{transportOnly:true});
  assert.equal(f.received.length,1);
  assert.equal(f.received[0]?.operation_id,id);
});

test('disposable real Broker + client consumes one existing UUID and denies duplicate without re-execution',{
  skip:process.platform!=='win32',
},async t=>{
  const {startPrivilegedBroker}=await import('../src/agent/privileged-broker.js');
  const consumed=new Set<string>();
  let effects=0;
  const binding={
    authorityId:'authority_fixture',ownerId:'owner_1',deviceId:'device_1',
    sessionId:'session_1',ownerEpoch:4,deviceEpoch:8,sessionEpoch:6,
    generation:9,highTokenProofId:'synthetic_high_proof',
    protectedBrokerProofId:'synthetic_image_proof',
    expiresAtMs:Date.now()+20_000,
  };
  const ticket='test_nonce_bound_ticket_0123456789';
  const receipt=(state:'RESERVED'|'COMMITTED',req:{
    operationId:string;capability:string;inputSha256:string;binding:typeof binding;
  },nonce:string)=>({
    state,operationId:req.operationId,capability:req.capability,
    inputSha256:req.inputSha256,challengeNonce:nonce,ticket,binding:req.binding,
    proof:'disposable_fixture_verification_only',
  });
  const adapter={
    readVerifiedBinding:async()=>({...binding}),
    begin:async(req:{operationId:string;capability:string;inputSha256:string;binding:typeof binding},nonce:string)=>consumed.has(req.operationId)
      ?null:receipt('RESERVED',req,nonce),
    commit:async(req:{operationId:string;capability:string;inputSha256:string;binding:typeof binding},issuedTicket:string,nonce:string)=>{
      if(consumed.has(req.operationId)||issuedTicket!==ticket)return null;
      consumed.add(req.operationId);
      return receipt('COMMITTED',req,nonce);
    },
    verifyReceipt:async()=>true,
    readVerifiedBindingNow:()=>({...binding}),
  };
  const broker=await startPrivilegedBroker({
    host:'127.0.0.1',port:0,tokens:[TOKEN],requireElevation:false,
    effectAdmission:adapter,
    execute:async(_capability,verifiedInput)=>{
      effects++;
      return {ack:true,verifiedInput};
    },
  });
  t.after(()=>broker.close());
  const client=new PrivilegedBrokerClient({url:broker.url,token:TOKEN});
  const id=randomUUID(),input={scope:'machine',name:'DISPOSABLE-NO-OS-EFFECT'};
  assert.deepEqual(await client.execute('windows.environment.set',input,id),
    {ack:true,verifiedInput:input});
  assert.equal(effects,1);
  await assert.rejects(
    client.execute('windows.environment.set',input,id),
    (error:unknown)=>error instanceof Error&&
      'code' in error&&error.code==='BROKER_EFFECT_ADMISSION_REQUIRED',
  );
  assert.equal(effects,1,'replayed UUID must never execute the callback twice');
});
