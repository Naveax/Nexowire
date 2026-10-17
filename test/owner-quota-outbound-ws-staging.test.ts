import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  startProposedOwnerQuotaOutboundWsHub,
  ProposedOutboundQuotaWsClient,
  verifyStagingQuotaWsUrl,
  type OutboundQuotaFrame,
} from '../src/product/owner-quota-outbound-ws-proposal.js';
import {
  startProposedOwnerQuotaLoopbackRpc,signDevOwnerQuotaRpcEnvelope,
} from '../src/product/owner-quota-loopback-rpc-proposal.js';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../src/product/trusted-owner-quota-authority-proposal.js';

const account='owner-ws-account-001';
const d1='owner-ws-device-001',d2='owner-ws-device-002';
const bearer='signed-first-party-token-ws-001';
const keys1=generateKeyPairSync('ed25519'),keys2=generateKeyPairSync('ed25519');
const priv1=keys1.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const pub1=keys1.publicKey.export({type:'spki',format:'pem'}).toString();
const priv2=keys2.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const pub2=keys2.publicKey.export({type:'spki',format:'pem'}).toString();
function dbSetup(){
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),file),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(account,'custom',100,1,1);
  for(const [dev,mode,pub] of [
    [d1,'full',pub1],[d2,'safe',pub2],
  ] as [string,'full'|'safe',string][]){
    db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,1,?)')
      .run(dev,account,mode);
    db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
      .run(dev,pub);
  }
  return db;
}
function envelope(input:{
  deviceId?:string;nonce?:string;invocation?:string;
  toolId?:string;bearer?:string;key?:string;
}={}){
  return signDevOwnerQuotaRpcEnvelope({
    envelope:{
      version:1,
      deviceId:input.deviceId??d1,
      nonce:input.nonce??'owner-ws-nonce-00001',
      issuedAtMs:Date.now(),
      body:{
        bearerToken:input.bearer??bearer,
        invocationId:input.invocation??'owner-ws-invocation-0001',
        toolId:input.toolId??'read-tool-0001',
      },
    },
    devicePrivateKeyPem:input.key??priv1,
  });
}
function frame(id:string,body= envelope()):OutboundQuotaFrame{
  return {version:1,kind:'reserve',requestId:id,envelope:body};
}
async function fixture(){
  const db=dbSetup();
  const auth=new ProposedTrustedOwnerQuotaAuthority(db,async token=>
    token===bearer?{accountId:account,sessionGeneration:1}:null);
  const toolCatalog=new Map([
    ['read-tool-0001',{
      operationClass:'read' as const,
      toolFingerprint:createHash('sha256').update('ws-owner:read').digest('hex'),
    }],
    ['write-tool-0001',{
      operationClass:'write' as const,
      toolFingerprint:createHash('sha256').update('ws-owner:write').digest('hex'),
    }],
  ]);
  const rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority:auth,trustedToolCatalog:toolCatalog,
  });
  const hub=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:rpc.origin,
  });
  const clients:ProposedOutboundQuotaWsClient[]=[];
  const dial=()=>{const c=new ProposedOutboundQuotaWsClient(hub.url);clients.push(c);return c};
  const used=()=>Number((db.prepare(
    'SELECT used FROM proposed_owner_quota_daily',
  ).get() as {used:number}|undefined)?.used??0);
  return {db,rpc,hub,clients,dial,used,async done(){
    for(const c of clients)c.close();
    await hub.close();await rpc.close();db.close();
  }};
}
test('client opens only outbound loopback WS and never starts inbound listener',async()=>{
  const x=await fixture();try{
    assert.match(x.hub.url,/^ws:\/\/127\.0\.0\.1:\d+\/internal\/owner-quota\/v1\/outbound$/);
    assert.equal(verifyStagingQuotaWsUrl(x.hub.url),x.hub.url);
    for(const bad of [
      'ws://0.0.0.0:32001/internal/owner-quota/v1/outbound',
      'ws://192.168.1.44:32001/internal/owner-quota/v1/outbound',
      'wss://example.com/internal/owner-quota/v1/outbound',
      'ws://127.0.0.1:32001/agent',
      'ws://127.0.0.1:32001/internal/owner-quota/v1/outbound?x=1',
      'ws://admin:pass@127.0.0.1:32001/internal/owner-quota/v1/outbound',
    ])assert.throws(()=>verifyStagingQuotaWsUrl(bad));
  }finally{await x.done()}
});
test('one signed outbound frame reserves exactly one owner-side quota unit, no tool execution',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    const r=await c.reserve(frame('owner-ws-request-001'));
    assert.equal(r.httpStatus,200);
    const data=r.data as {decision:{status:string,used:number,authorizesToolExecution:boolean}};
    assert.equal(data.decision.status,'reserved');
    assert.equal(data.decision.used,1);
    assert.equal(data.decision.authorizesToolExecution,false);
    assert.equal(x.used(),1);
  }finally{await x.done()}
});
test('network replay with signed same nonce denied, new nonce same logical call deduplicated',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    const signed=envelope();
    assert.equal((await c.reserve(frame('owner-ws-request-001',signed))).httpStatus,200);
    const replay=await c.reserve(frame('owner-ws-request-002',signed));
    assert.equal(replay.httpStatus,409);
    const retried=await c.reserve(frame('owner-ws-request-003',
      envelope({nonce:'owner-ws-fresh-nonce-002'})));
    assert.equal(retried.httpStatus,200);
    assert.equal((retried.data as {decision:{status:string}}).decision.status,'duplicate');
    assert.equal(x.used(),1);
  }finally{await x.done()}
});
test('two devices make independent outbound connections but share one account daily quota',async()=>{
  const x=await fixture();try{
    const a=x.dial(),b=x.dial();
    const [ra,rb]=await Promise.all([
      a.reserve(frame('owner-ws-request-A001')),
      b.reserve(frame('owner-ws-request-B001',envelope({
        deviceId:d2,key:priv2,nonce:'owner-ws-b-nonce-001',
        invocation:'owner-ws-b-invocation-001',
      }))),
    ]);
    assert.equal(ra.httpStatus,200);
    assert.equal(rb.httpStatus,200);
    assert.deepEqual([
      (ra.data as {decision:{status:string}}).decision.status,
      (rb.data as {decision:{status:string}}).decision.status,
    ],['reserved','reserved']);
    assert.equal(x.used(),2);
  }finally{await x.done()}
});
test('disabled device, wrong device private key and Safe write fail without quota',async()=>{
  const x=await fixture();try{
    const a=x.dial();
    const forged=await a.reserve(frame('owner-ws-forged-0001',envelope({
      deviceId:d2,nonce:'forged-ws-nonce-001',key:priv1,
    })));
    assert.equal(forged.httpStatus,401);
    const safeWrite=await a.reserve(frame('owner-ws-safewrite-001',envelope({
      deviceId:d2,key:priv2,nonce:'safe-ws-nonce-001',
      invocation:'safe-ws-write-invocation',toolId:'write-tool-0001',
    })));
    assert.equal((safeWrite.data as {decision:{status:string}}).decision.status,
      'device-denied');
    x.db.prepare('UPDATE proposed_owner_rpc_device_keys SET enabled=0 WHERE device_id=?')
      .run(d1);
    const disabled=await a.reserve(frame('owner-ws-disabled-001',envelope({
      nonce:'disabled-ws-nonce-001',
    })));
    assert.equal(disabled.httpStatus,401);
    assert.equal(x.used(),0);
  }finally{await x.done()}
});
test('account OAuth epoch change denies future reservations on connected socket',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    assert.equal((await c.reserve(frame('owner-ws-before-epoch'))).httpStatus,200);
    x.db.prepare('UPDATE proposed_owner_quota_accounts SET session_generation=2 WHERE account_id=?')
      .run(account);
    const after=await c.reserve(frame('owner-ws-after-epoch',envelope({
      nonce:'owner-ws-after-epoch-nonce',
      invocation:'owner-ws-after-epoch-tool',
    })));
    assert.equal((after.data as {decision:{status:string}}).decision.status,'unauthorized');
    assert.equal(x.used(),1);
  }finally{await x.done()}
});
test('a completed correlation ID cannot be recycled for another tool call',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    const first=await c.reserve(frame('owner-ws-request-0007'));
    assert.equal(first.httpStatus,200);
    await assert.rejects(c.reserve(frame('owner-ws-request-0007',
      envelope({nonce:'owner-ws-next-nonce-0008',
        invocation:'owner-ws-next-invocation-0008'}))),/Duplicate or excessive/);
    assert.equal(x.used(),1);
  }finally{await x.done()}
});
test('new outbound connection with fresh signed nonce retains daily invocation dedup',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    assert.equal((await c.reserve(frame('owner-ws-initial-req'))).httpStatus,200);
    c.close();
    const renewed=x.dial();
    const next=await renewed.reserve(frame('owner-ws-after-disconnect',
      envelope({nonce:'owner-ws-reconnect-nonce-001'})));
    assert.equal((next.data as {decision:{status:string}}).decision.status,
      'duplicate');
    assert.equal(x.used(),1);
  }finally{await x.done()}
});
test('unknown or forbidden WebSocket route is rejected with no quota change',async()=>{
  const x=await fixture();try{
    const url=x.hub.url.replace('/internal/owner-quota/v1/outbound','/agent');
    const raw=new WebSocket(url);
    await new Promise<void>(resolve=>{
      raw.once('error',()=>resolve());
      raw.once('close',()=>resolve());
    });
    assert.equal(x.used(),0);
  }finally{await x.done()}
});
test('WS stays unauthenticated until signed owner RPC verifies device envelope',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    const tampered=envelope();
    const corrupted={...tampered,body:{...tampered.body,toolId:'write-tool-0001'}};
    const r=await c.reserve(frame('owner-ws-tampered-001',corrupted));
    assert.equal(r.httpStatus,401);
    assert.equal(x.used(),0);
  }finally{await x.done()}
});
test('invalid frame or excessively large payload cannot invoke owner RPC',async()=>{
  const x=await fixture();try{
    const raw=new WebSocket(x.hub.url);
    await new Promise<void>((resolve,reject)=>{
      raw.once('open',()=>resolve());raw.once('error',reject);
    });
    const ended=new Promise<void>(resolve=>raw.once('close',()=>resolve()));
    raw.send(JSON.stringify({kind:'do-admin-action',payload:{cmd:'powershell'}}));
    await ended;
    assert.equal(x.used(),0);
  }finally{await x.done()}
});
test('owner quota backend unavailable fails closed instead of approving',async()=>{
  const x=await fixture();try{
    const c=x.dial();
    x.db.exec('DROP TABLE proposed_owner_rpc_device_keys');
    const r=await c.reserve(frame('owner-ws-storage-001'));
    assert.equal(r.httpStatus,503);
    assert.equal((r.data as {error:string}).error,'owner_device_proof_unavailable');
    assert.equal(x.used(),0);
  }finally{await x.done()}
});
