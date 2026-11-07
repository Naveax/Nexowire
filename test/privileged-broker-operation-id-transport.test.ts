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
