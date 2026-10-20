import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIsolatedD1Staging,probeIsolatedD1Staging,
  SCALE_V2_REQUIRED_D1_TABLES,
} from '../src/ops/scale-v2-d1-staging-preflight.js';

const staging=Object.freeze({
  NEXOWIRE_CF_STAGING_APPROVAL:'ISOLATED_D1_READ_ONLY',
  NEXOWIRE_CF_STAGING_ACCOUNT_ID:'a'.repeat(32),
  NEXOWIRE_CF_STAGING_DATABASE_ID:'12345678-1234-4123-8123-123456789abc',
  NEXOWIRE_CF_STAGING_DATABASE_NAME:'nexowire-scale-v2-staging-acceptance',
  NEXOWIRE_CF_STAGING_WORKER_URL:
    'https://nexowire-scale-v2-staging-acceptance.example.workers.dev/',
  NEXOWIRE_CF_STAGING_READ_TOKEN:'test-only-no-real-cloudflare-token',
});
function ready(){
  const r=validateIsolatedD1Staging(staging);
  assert.equal(r.status,'READY_FOR_READONLY_PROBE');
  if(r.status!=='READY_FOR_READONLY_PROBE')throw Error('blocked');
  return r;
}
test('no staging identity: blocked without touching any Cloudflare target',()=>{
  assert.deepEqual(validateIsolatedD1Staging({}).status,'BLOCKED');
  const f=validateIsolatedD1Staging({
    ...staging,
    NEXOWIRE_CF_STAGING_APPROVAL:'',
  });
  assert.equal(f.status,'BLOCKED');
  if(f.status==='BLOCKED')assert.ok(f.reasons.includes('ISOLATED_STAGING_APPROVAL_MISSING'));
});
test('production database name and unsafe URL fail closed even with syntactically valid credentials',()=>{
  for(const badName of ['nexowire-control-plane','nexowire-control-plane-production','nexowire-staging','REPLACE_WITH_D1_DATABASE_ID']){
    assert.equal(validateIsolatedD1Staging({
      ...staging,NEXOWIRE_CF_STAGING_DATABASE_NAME:badName,
    }).status,'BLOCKED');
  }
  for(const u of [
    'http://nexowire-scale-v2-staging.example.workers.dev/',
    'https://nexowire-control-plane.workers.dev/',
    'https://u:p@nexowire-staging.example.workers.dev/',
    'https://nexowire-staging.example.workers.dev/a',
    'https://nexowire-staging.example.workers.dev/?db=prod',
    'https://nexowire-staging.example.workers.dev:9443/',
  ])assert.equal(validateIsolatedD1Staging({
    ...staging,NEXOWIRE_CF_STAGING_WORKER_URL:u,
  }).status,'BLOCKED',u);
});
test('Cloudflare D1 database ID must match remote GET metadata before any SELECT',async()=>{
  const a=ready();
  let calls=0;
  const mock:typeof fetch=async()=>{
    calls++;
    return Response.json({success:true,result:{uuid:a.databaseId,
      name:'nexowire-control-plane'}});
  };
  const result=await probeIsolatedD1Staging(a,'fake-only',mock);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.reason,'D1_IDENTITY_DOES_NOT_MATCH_ISOLATED_STAGING');
  assert.equal(calls,1);
});
test('real API contract probe uses metadata GET and fixed SELECT only, never D1 mutation',async()=>{
  const a=ready();const requests:Array<{url:string;method:string;body:string}>=[];
  const mock:typeof fetch=async(input,init)=>{
    const url=String(input);
    const method=init?.method??'GET';
    const body=String(init?.body??'');
    requests.push({url,method,body});
    if(method==='GET'){
      return Response.json({success:true,result:{uuid:a.databaseId,
        name:a.databaseName}});
    }
    assert.equal(method,'POST');
    const query=JSON.parse(body) as {sql:string;params:string[]};
    assert.match(query.sql,/^SELECT name FROM sqlite_master/);
    assert.deepEqual(query.params,SCALE_V2_REQUIRED_D1_TABLES);
    return Response.json({success:true,result:[{success:true,
      results:SCALE_V2_REQUIRED_D1_TABLES.map(name=>({name})),
      meta:{rows_read:12}}]});
  };
  const evidence=await probeIsolatedD1Staging(a,'fake-only',mock);
  assert.equal(evidence.status,'REMOTE_D1_SCHEMA_OBSERVED');
  assert.equal(evidence.liveD1Tested,true);
  assert.equal(evidence.distributedWorkerAcceptance,false);
  assert.equal(evidence.costAccepted,false);
  assert.equal(evidence.paymentProofAcceptance,false);
  assert.equal(requests.length,2);
  assert.deepEqual(requests.map(r=>r.method),['GET','POST']);
});
test('remote missing quota table is BLOCKED; never promote schema probe to production pass',async()=>{
  const a=ready();
  const mock:typeof fetch=async(_input,init)=>{
    if(init?.method==='GET')return Response.json({success:true,result:{
      uuid:a.databaseId,name:a.databaseName}});
    return Response.json({success:true,result:[{success:true,
      results:SCALE_V2_REQUIRED_D1_TABLES.filter(n=>n!=='v2_quota_reservations')
        .map(name=>({name})),meta:{rows_read:10}}]});
  };
  const result=await probeIsolatedD1Staging(a,'fake-only',mock);
  assert.equal(result.status,'BLOCKED');
  assert.deepEqual(result.missingTables,['v2_quota_reservations']);
  assert.equal(result.productionEntitlementsAccepted,false);
});
test('network errors and remote rejection stay BLOCKED without disclosing credential',async()=>{
  const a=ready();
  const result=await probeIsolatedD1Staging(a,'secret-never-print',async()=>{
    throw new Error('secret-never-print');
  });
  assert.equal(result.status,'BLOCKED');
  assert.ok(!JSON.stringify(result).includes('secret-never-print'));
});
