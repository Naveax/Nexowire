import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  startProposedOwnerQuotaLoopbackRpc,
  signDevOwnerQuotaRpcEnvelope,
  type SignedOwnerQuotaRpcEnvelope,
} from '../src/product/owner-quota-loopback-rpc-proposal.js';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../src/product/trusted-owner-quota-authority-proposal.js';

const account='account-owner-001',device1='device-signed-A001',device2='device-signed-B001';
const bearer='owner-account-test-token-001';
const issuedAt=new Date('2026-10-16T19:00:00.000Z');
const pair1=generateKeyPairSync('ed25519'),pair2=generateKeyPairSync('ed25519');
const priv1=pair1.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const priv2=pair2.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const pub1=pair1.publicKey.export({format:'pem',type:'spki'}).toString();
const pub2=pair2.publicKey.export({format:'pem',type:'spki'}).toString();
const fpRead=createHash('sha256').update('owner-server-tool:read-demo').digest('hex');
const fpWrite=createHash('sha256').update('owner-server-tool:write-demo').digest('hex');
const tools=new Map([
  ['read-tool-v1',{operationClass:'read' as const,toolFingerprint:fpRead}],
  ['write-tool-v1',{operationClass:'write' as const,toolFingerprint:fpWrite}],
]);
function createDb(){
  const db=new DatabaseSync(':memory:');
  for(const file of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),file),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(account,'custom',100,1,3);
  const devices:[string,'full'|'safe',string][]=[
    [device1,'full',pub1],[device2,'safe',pub2],
  ];
  for(const [dev,mode,key] of devices){
    db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,1,?)')
      .run(dev,account,mode);
    db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
      .run(dev,key);
  }
  return db;
}
const defaultBody={
  bearerToken:bearer,invocationId:'invocation-accepted-001',toolId:'read-tool-v1',
};
function signed(patch:Partial<SignedOwnerQuotaRpcEnvelope>={},
  key=priv1):SignedOwnerQuotaRpcEnvelope{
  const bare={
    version:1 as const,
    deviceId:patch.deviceId??device1,
    nonce:patch.nonce??'nonce-test-signed-001',
    issuedAtMs:patch.issuedAtMs??issuedAt.getTime(),
    body:patch.body??defaultBody,
  };
  return signDevOwnerQuotaRpcEnvelope({envelope:bare,devicePrivateKeyPem:key});
}
async function make(){
  const db=createDb(),now={value:issuedAt};
  const authority=new ProposedTrustedOwnerQuotaAuthority(
    db,async token=>token===bearer?{accountId:account,sessionGeneration:3}:null,
    ()=>now.value,
  );
  const service=await startProposedOwnerQuotaLoopbackRpc({
    db,authority,trustedToolCatalog:tools,now:()=>now.value,
  });
  const post=async(envelope:unknown,opts:RequestInit={})=>{
    const res=await fetch(service.origin,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(envelope),...opts,
    });
    return {status:res.status,body:await res.json() as Record<string,unknown>,res};
  };
  const used=()=>Number((db.prepare('SELECT used FROM proposed_owner_quota_daily')
    .get() as {used:number}|undefined)?.used??0);
  return {db,now,service,authority,post,used,async stop(){
    await service.close();db.close();
  }};
}
test('RPC origin is fixed localhost, not a public listener',async()=>{
  const x=await make();try{
    const u=new URL(x.service.origin);
    assert.equal(u.hostname,'127.0.0.1');
    assert.equal(u.protocol,'http:');
    assert.equal(u.pathname,'/internal/owner-quota/v1/reserve');
  }finally{await x.stop()}
});
test('server-verified device signature and first-party account auth reserve once',async()=>{
  const x=await make();try{
    const v=await x.post(signed());
    assert.equal(v.status,200);
    assert.equal((v.body.decision as Record<string,unknown>).status,'reserved');
    assert.equal((v.body.decision as Record<string,unknown>).dailyLimit,100);
    assert.equal((v.body.decision as Record<string,unknown>).authorizesToolExecution,false);
    assert.equal(x.used(),1);
    assert.equal(v.res.headers.get('cache-control'),'no-store');
  }finally{await x.stop()}
});
test('identical signed network request cannot replay even across new connections',async()=>{
  const x=await make();try{
    const event=signed();
    assert.equal((await x.post(event)).status,200);
    const replay=await x.post(event);
    assert.equal(replay.status,409);
    assert.equal(replay.body.error,'device_nonce_replayed');
    assert.equal(x.used(),1);
    const fresh=await x.post(signed({nonce:'nonce-other-002'}));
    assert.equal((fresh.body.decision as Record<string,unknown>).status,'duplicate');
    assert.equal(x.used(),1);
  }finally{await x.stop()}
});
test('separate PCs share account daily usage; Safe mode cannot get write allowance',async()=>{
  const x=await make();try{
    const a=await x.post(signed());
    const b=await x.post(signed({deviceId:device2,
      nonce:'nonce-device-b-002',
      body:{...defaultBody,invocationId:'read-device-b-002'}},priv2));
    assert.equal((a.body.decision as Record<string,unknown>).used,1);
    assert.equal((b.body.decision as Record<string,unknown>).used,2);
    const denied=await x.post(signed({deviceId:device2,
      nonce:'nonce-device-b-003',
      body:{...defaultBody,invocationId:'attempt-write-b',toolId:'write-tool-v1'}},priv2));
    assert.equal((denied.body.decision as Record<string,unknown>).status,'device-denied');
    assert.equal(x.used(),2);
  }finally{await x.stop()}
});
test('attacker cannot sign for another device or alter body after signing',async()=>{
  const x=await make();try{
    const wrong=await x.post(signed({deviceId:device2},priv1));
    assert.equal(wrong.status,401);
    assert.equal(x.used(),0);
    const original=signed();
    const modified={...original,body:{...original.body,toolId:'write-tool-v1'}};
    assert.equal((await x.post(modified)).status,401);
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('additional unsigned operation class, plan, account or limit fields are rejected',async()=>{
  const x=await make();try{
    const env=signed();
    const forged={...env,body:{...env.body,
      operationClass:'read',dailyLimit:850000,accountId:'other-account-001'}};
    const v=await x.post(forged);
    assert.equal(v.status,400);
    assert.equal(x.used(),0);
    const signedClientOverride={...env,dailyLimit:850000};
    assert.equal((await x.post(signedClientOverride)).status,400);
  }finally{await x.stop()}
});
test('nonce is consumed even when OAuth token is invalid; no second chance',async()=>{
  const x=await make();try{
    const env=signed({nonce:'nonce-bad-account-token',
      body:{...defaultBody,bearerToken:'unknown-test-token-0001'}});
    const first=await x.post(env);
    assert.equal((first.body.decision as Record<string,unknown>).status,'unauthorized');
    assert.equal(x.used(),0);
    assert.equal((await x.post(env)).status,409);
  }finally{await x.stop()}
});
test('revoked device key and session generation are rechecked on each new request',async()=>{
  const x=await make();try{
    x.db.prepare(
      'UPDATE proposed_owner_rpc_device_keys SET enabled=0 WHERE device_id=?',
    ).run(device1);
    assert.equal((await x.post(signed())).status,401);
    x.db.prepare(
      'UPDATE proposed_owner_rpc_device_keys SET enabled=1 WHERE device_id=?',
    ).run(device1);
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET session_generation=4 WHERE account_id=?',
    ).run(account);
    const v=await x.post(signed({nonce:'nonce-epoch-revoked'}));
    assert.equal((v.body.decision as Record<string,unknown>).status,'unauthorized');
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('server catalog maps real tool permission; unknown tool cannot reserve',async()=>{
  const x=await make();try{
    const env=signed({body:{...defaultBody,toolId:'not-in-owner-catalog'}});
    const v=await x.post(env);
    assert.equal(v.status,403);
    assert.equal(v.body.error,'unavailable_tool');
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('timestamp expiry, future proof and per-device nonce schema fail closed',async()=>{
  const x=await make();try{
    x.now.value=new Date(issuedAt.getTime()+30001);
    assert.equal((await x.post(signed())).status,401);
    x.now.value=issuedAt;
    const bad=signed({issuedAtMs:issuedAt.getTime()+30001,
      nonce:'nonce-future-invalid'});
    assert.equal((await x.post(bad)).status,401);
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('RPC refuses GET, arbitrary paths, wrong content type and oversize body',async()=>{
  const x=await make();try{
    const g=await fetch(x.service.origin);
    assert.equal(g.status,404);
    const arbitrary=await fetch(new URL('/agent',x.service.origin),{
      method:'POST',body:'{}',headers:{'content-type':'application/json'},
    });
    assert.equal(arbitrary.status,404);
    const wrong=await fetch(x.service.origin,{method:'POST',body:'{}',
      headers:{'content-type':'text/plain'}});
    assert.equal(wrong.status,415);
    const huge=await fetch(x.service.origin,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({payload:'x'.repeat(17000)}),
    });
    assert.equal(huge.status,413);
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('spoofed X-Forwarded, Host and Origin do not change the account or device',async()=>{
  const x=await make();try{
    const e=signed();
    const req=await x.post(e,{headers:{
      'content-type':'application/json','x-forwarded-user':'admin-user-001',
      'x-device-id':device2,'origin':'https://evil.example.test',
    }});
    assert.equal((req.body.decision as Record<string,unknown>).status,'reserved');
    assert.equal(x.used(),1);
  }finally{await x.stop()}
});
test('owner DB outage fails closed and never returns approval',async()=>{
  const x=await make();try{
    x.db.exec('DROP TABLE proposed_owner_rpc_device_keys');
    const v=await x.post(signed());
    assert.equal(v.status,503);
    assert.equal(v.body.error,'owner_device_proof_unavailable');
    assert.equal(x.used(),0);
  }finally{await x.stop()}
});
test('bounded nonce cleanup removes only expired replay rows',async()=>{
  const x=await make();try{
    assert.equal((await x.post(signed())).status,200);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_rpc_nonce_ledger',
    ).get()!.n,1);
    x.now.value=new Date(issuedAt.getTime()+181000);
    const accepted=await x.post(signed({
      nonce:'nonce-after-cleanup',
      issuedAtMs:x.now.value.getTime(),
      body:{...defaultBody,invocationId:'new-tool-after-cleanup'},
    }));
    assert.equal(accepted.status,200);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_rpc_nonce_ledger',
    ).get()!.n,1);
    // The old signature cannot be used after nonce has expired.
    assert.equal((await x.post(signed())).status,401);
    assert.equal(x.used(),2);
  }finally{await x.stop()}
});
test('trusted server clock rollback is denied, no nonce inserted or quota charged',async()=>{
  const x=await make();try{
    assert.equal((await x.post(signed())).status,200);
    x.now.value=new Date(issuedAt.getTime()-1);
    const denied=await x.post(signed({
      nonce:'nonce-clock-backwards-001',
      issuedAtMs:x.now.value.getTime(),
      body:{...defaultBody,invocationId:'clock-backwards-tool'},
    }));
    assert.equal(denied.status,503);
    assert.equal(denied.body.error,'owner_rpc_clock_rollback');
    assert.equal(x.used(),1);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_rpc_nonce_ledger',
    ).get()!.n,1);
  }finally{await x.stop()}
});
test('different device nonces can be concurrent, same account still charged exactly twice',async()=>{
  const x=await make();try{
    const [a,b]=await Promise.all([
      x.post(signed({nonce:'nonce-parallel-first',body:{
        ...defaultBody,invocationId:'parallel-call-first',
      }})),
      x.post(signed({deviceId:device2,nonce:'nonce-parallel-second',
        body:{...defaultBody,invocationId:'parallel-call-second'}},priv2)),
    ]);
    assert.equal(a.status,200);
    assert.equal(b.status,200);
    assert.deepEqual([
      (a.body.decision as Record<string,unknown>).status,
      (b.body.decision as Record<string,unknown>).status,
    ],['reserved','reserved']);
    assert.equal(x.used(),2);
  }finally{await x.stop()}
});
