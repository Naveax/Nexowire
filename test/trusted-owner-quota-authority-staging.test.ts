import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {issueOperatorRouteAttestation} from '../src/mcp/signed-transport-scope-proposal.js';
import {
  ProposedTrustedOwnerQuotaAuthority,
  type StagingAuthenticateToken,
  type StagingLogicalToolRequest,
} from '../src/product/trusted-owner-quota-authority-proposal.js';

const a='owner-account-001', b='owner-account-002';
const devA1='owner-device-A01',devA2='owner-device-A02',devB='owner-device-B01';
const tokenA='valid-test-account-A-token',tokenB='valid-test-account-B-token';
const initial=new Date('2026-10-16T10:00:00.000Z');
const fingerprint=createHash('sha256').update('server-canonical:tool-list:read').digest('hex');
const otherFingerprint=createHash('sha256').update('server-canonical:another-tool').digest('hex');
const sql=[
  'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
  'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
].map(file=>readFileSync(path.join(process.cwd(),file),'utf8')).join('\n');
const auth:StagingAuthenticateToken=async token=>{
  if(token===tokenA)return {accountId:a,sessionGeneration:2};
  if(token===tokenB)return {accountId:b,sessionGeneration:5};
  return null;
};
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(sql);
  seed(db);
  const clock={value:initial};
  const authority=new ProposedTrustedOwnerQuotaAuthority(db,auth,()=>clock.value);
  const req:StagingLogicalToolRequest={
    bearerToken:tokenA,deviceId:devA1,invocationId:'invocation-number-00001',
    toolFingerprint:fingerprint,operationClass:'read',
  };
  const send=(patch:Partial<StagingLogicalToolRequest>={})=>
    authority.reserveLogicalTool({...req,...patch});
  const used=(who=a,day='2026-10-16')=>Number((db.prepare(
    'SELECT used FROM proposed_owner_quota_daily WHERE account_id=? AND day_utc=?',
  ).get(who,day) as {used:number}|undefined)?.used??0);
  return {db,authority,clock,req,send,used,close:()=>db.close()};
}
function seed(db:DatabaseSync){
  db.prepare(
    'INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)',
  ).run(a,'custom',100,1,2);
  db.prepare(
    'INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)',
  ).run(b,'free',null,1,5);
  const assignedDevices:[string,string,'safe'|'full'][]=[
    [devA1,a,'full'],[devA2,a,'safe'],[devB,b,'full'],
  ];
  for(const [id,owner,mode] of assignedDevices)db.prepare(
    'INSERT INTO proposed_owner_quota_devices VALUES(?,?,1,?)',
  ).run(id,owner,mode);
}
test('server DB—not client-requested JSON—sets daily 100 quota and exposes no execution grant',async()=>{
  const x=setup();try{
    const v=await x.authority.reserveLogicalTool({
      ...x.req,dailyLimit:850000,entitlementVerified:true,
    } as unknown as StagingLogicalToolRequest);
    assert.equal(v.status,'reserved');
    assert.equal(v.dailyLimit,100);
    assert.equal(v.remaining,99);
    assert.equal(v.authorizesToolExecution,false);
    assert.equal(x.used(),1);
  }finally{x.close()}
});
test('same logical tool replay is not re-charged; changed fingerprint/device is collision',async()=>{
  const x=setup();try{
    assert.equal((await x.send()).status,'reserved');
    assert.equal((await x.send()).status,'duplicate');
    assert.equal((await x.send({toolFingerprint:otherFingerprint})).status,'invocation-collision');
    assert.equal((await x.send({deviceId:devA2})).status,'invocation-collision');
    assert.equal(x.used(),1);
  }finally{x.close()}
});
test('100th allowed and 101st denied, upgrade only changes number not device permissions',async()=>{
  const x=setup();try{
    for(let i=0;i<100;i++){
      const v=await x.send({invocationId:'quota-call-'+i});
      assert.equal(v.status,'reserved',String(i));
    }
    assert.equal((await x.send({invocationId:'101st-quota-call'})).status,
      'daily-exhausted');
    assert.equal(x.used(),100);
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET custom_daily_limit=? WHERE account_id=?',
    ).run(850000,a);
    const next=await x.send({invocationId:'after-paid-upgrade'});
    assert.equal(next.status,'reserved');
    assert.equal(next.dailyLimit,850000);
    assert.equal(x.used(),101);
    // Access mode is independent of the billing plan.
    assert.equal((await x.send({
      deviceId:devA2,invocationId:'no-write-on-safe',
      operationClass:'write',
    })).status,'device-denied');
  }finally{x.close()}
});
test('an account shares one daily ledger across both of its devices',async()=>{
  const x=setup();try{
    assert.equal((await x.send()).status,'reserved');
    const second=await x.send({
      deviceId:devA2,invocationId:'second-device-read',
    });
    assert.equal(second.status,'reserved');
    assert.equal(second.used,2);
    assert.equal(x.used(),2);
  }finally{x.close()}
});
test('different authorized accounts have independent daily allowances',async()=>{
  const x=setup();try{
    const one=await x.send();
    const two=await x.send({
      bearerToken:tokenB,deviceId:devB,
      invocationId:'account-b-first',
    });
    assert.equal(one.dailyLimit,100);
    assert.equal(two.dailyLimit,1000);
    assert.equal(two.used,1);
    assert.equal(x.used(a),1);
    assert.equal(x.used(b),1);
  }finally{x.close()}
});
test('mismatched or unknown device and Safe-mode write are rejected without charging',async()=>{
  const x=setup();try{
    for(const change of [
      {deviceId:devB},
      {deviceId:'unknown-device-001'},
      {deviceId:devA2,operationClass:'write' as const},
    ]){
      assert.equal((await x.send(change)).status,'device-denied');
    }
    assert.equal(x.used(),0);
  }finally{x.close()}
});
test('logout, account disable, device ownership transfer and disabled device fail closed',async()=>{
  const x=setup();try{
    assert.equal((await x.send()).status,'reserved');
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET session_generation=3 WHERE account_id=?',
    ).run(a);
    assert.equal((await x.send()).status,'unauthorized');
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET session_generation=2,enabled=0 WHERE account_id=?',
    ).run(a);
    assert.equal((await x.send({invocationId:'new-after-disabled'})).status,'unauthorized');
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET enabled=1 WHERE account_id=?',
    ).run(a);
    x.db.prepare(
      'UPDATE proposed_owner_quota_devices SET owner_account_id=? WHERE device_id=?',
    ).run(b,devA1);
    assert.equal((await x.send()).status,'device-denied');
    x.db.prepare(
      'UPDATE proposed_owner_quota_devices SET owner_account_id=?,enabled=0 WHERE device_id=?',
    ).run(a,devA1);
    assert.equal((await x.send({invocationId:'disabled-device-new'})).status,'device-denied');
    assert.equal(x.used(),1);
  }finally{x.close()}
});
test('invalid or unrecognized first-party bearer does not create any quota rows',async()=>{
  const x=setup();try{
    const result=await x.send({bearerToken:'invalid-but-long-test-token'});
    assert.equal(result.status,'unauthorized');
    assert.equal(x.used(),0);
    assert.equal(x.db.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_quota_invocations',
    ).get()!.n,0);
  }finally{x.close()}
});
test('custom ceiling 850000 respects the real integer boundary without fake network benchmark',async()=>{
  const x=setup();try{
    x.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET custom_daily_limit=850000 WHERE account_id=?',
    ).run(a);
    x.db.prepare(
      'INSERT INTO proposed_owner_quota_daily VALUES(?,?,?)',
    ).run(a,'2026-10-16',849999);
    const last=await x.send();
    assert.equal(last.status,'reserved');
    assert.equal(last.used,850000);
    const refused=await x.send({invocationId:'already-full-quota'});
    assert.equal(refused.status,'daily-exhausted');
    assert.equal(x.used(),850000);
  }finally{x.close()}
});
test('UTC day reset never erases global invocation replay',async()=>{
  const x=setup();try{
    assert.equal((await x.send()).status,'reserved');
    x.clock.value=new Date('2026-10-17T00:00:01.000Z');
    assert.equal((await x.send()).status,'duplicate');
    const fresh=await x.send({invocationId:'after-midnight-fresh'});
    assert.equal(fresh.used,1);
    assert.equal(x.used(a,'2026-10-17'),1);
    assert.equal(x.used(a,'2026-10-16'),1);
  }finally{x.close()}
});
test('signed shared ingress counts metadata and auth denial, not as daily tool credit',async()=>{
  const x=setup();try{
    const kp=generateKeyPairSync('ed25519');
    const privatePem=kp.privateKey.export({format:'pem',type:'pkcs8'}).toString();
    const publicPem=kp.publicKey.export({format:'pem',type:'spki'}).toString();
    const signedRoute=issueOperatorRouteAttestation({
      version:1,audience:'nexowire-local-first-mcp',
      issuer:'owner-control-plane-001',keyId:'operator-key-01',
      tunnelId:'trusted-tunnel-001',callerKind:'application',
      callerId:'verified-app-001',publicResourceUrl:'https://pc.example.test/mcp',
      routeGeneration:3,issuedAtMs:initial.getTime(),
      expiresAtMs:initial.getTime()+900000,
    },privatePem);
    let generation=3;
    const hook=x.authority.bindSignedIngress({
      signedRoute,operatorPublicKeyPem:publicPem,
      expectedIssuer:'owner-control-plane-001',expectedKeyId:'operator-key-01',
      expectedPublicResourceUrl:'https://pc.example.test/mcp',
      minimumRouteGeneration:()=>generation,
    });
    const entry=()=>hook.meter.observe(hook.trustedScope,x.clock.value);
    assert.equal(entry().allowed,true); // metadata
    assert.equal(entry().allowed,true); // denied auth
    assert.equal((await x.send({bearerToken:'invalid-but-long-token'})).status,'unauthorized');
    assert.equal(entry().allowed,true); // actual read
    assert.equal((await x.send()).status,'reserved');
    assert.equal(x.used(),1);
    generation=4;
    assert.throws(entry,/no longer authorized/);
    const counts=x.db.prepare(
      'SELECT observed,admitted FROM proposed_ingress_transport_totals WHERE scope_id=?',
    ).get(hook.trustedScope) as {observed:number,admitted:number};
    assert.deepEqual([counts.observed,counts.admitted],[3,3]);
    const toolMinute=x.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='custom_usage_transport_window'",
    ).get() as {n:number};
    assert.equal(toolMinute.n,0); // NO second per-tool transport throttler
  }finally{x.close()}
});
test('trusted clock rollback is denied, after quota remains unchanged',async()=>{
  const x=setup();try{
    assert.equal((await x.send()).status,'reserved');
    x.clock.value=new Date(initial.getTime()-1);
    await assert.rejects(x.send({invocationId:'clock-roll-back-attempt'}),/rollback/);
    assert.equal(x.used(),1);
  }finally{x.close()}
});
test('missing owner quota schema, invalid plan, malformed token or tool hash all fail closed',async()=>{
  const x=setup();try{
    x.db.exec('DROP TABLE proposed_owner_quota_accounts');
    await assert.rejects(x.send(),/no such table/);
  }finally{x.close()}
  const y=setup();try{
    y.db.prepare(
      'UPDATE proposed_owner_quota_accounts SET custom_daily_limit=? WHERE account_id=?',
    ).run(850001,a);
    await assert.rejects(y.send(),/100 to 850000/);
    await assert.rejects(y.send({toolFingerprint:'forged'}),/fingerprint/);
    await assert.rejects(y.send({bearerToken:'short'}),/token input/);
    assert.equal(y.used(),0);
  }finally{y.close()}
});
test('independent connections and independent authority objects enforce the same daily counter',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'nw-owner-quota-'));
  const filename=path.join(folder,'owner.sqlite3');
  const db1=new DatabaseSync(filename),db2=new DatabaseSync(filename);
  try{
    db1.exec(sql);seed(db1);
    const one=new ProposedTrustedOwnerQuotaAuthority(db1,auth,()=>initial);
    const two=new ProposedTrustedOwnerQuotaAuthority(db2,auth,()=>initial);
    const base={
      bearerToken:tokenA,deviceId:devA1,toolFingerprint:fingerprint,
      operationClass:'read' as const,
    };
    const result=await Promise.all([
      one.reserveLogicalTool({...base,invocationId:'worker-A-request'}),
      two.reserveLogicalTool({...base,invocationId:'worker-B-request'}),
    ]);
    assert.deepEqual(result.map(r=>r.status),['reserved','reserved']);
    assert.deepEqual(result.map(r=>r.used),[1,2]);
    const count=db1.prepare('SELECT used FROM proposed_owner_quota_daily').get() as {used:number};
    assert.equal(count.used,2);
    assert.equal((await two.reserveLogicalTool({...base,
      invocationId:'worker-A-request'})).status,'duplicate');
  }finally{
    db1.close();db2.close();rmSync(folder,{recursive:true,force:true});
  }
});
test('missing trusted authentication function result or internal auth error never grants',async()=>{
  const x=setup();try{
    const fail=new ProposedTrustedOwnerQuotaAuthority(x.db,async()=>{
      throw new Error('OAuth issuer offline');
    },()=>initial);
    await assert.rejects(fail.reserveLogicalTool(x.req),/issuer offline/);
    assert.equal(x.used(),0);
  }finally{x.close()}
});
