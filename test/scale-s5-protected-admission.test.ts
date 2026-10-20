import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {calculateS5ProtectedShares,ProposedS5ProtectedTenantAdmission,type FairConfig}
  from '../src/ops/scale-s5-protected-admission.js';
const A='trusted-account-a1',B='trusted-account-b2',C='trusted-account-c3';
const SCOPE='trusted-staging-scope';
const SHA=createHash('sha256').update('canonical-read-operation').digest('hex');
const ALTERED=createHash('sha256').update('different-payload').digest('hex');
const NOW=new Date('2026-10-18T12:00:00.000Z');
function fixture(limit:number,tenants:FairConfig['tenants']){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
  const meter=new ProposedS5ProtectedTenantAdmission(db,{scope:SCOPE,globalRollingMinuteLimit:limit,tenants});
  return {db,meter};
}
test('S5 baseline global budget starvation reproduced with current first-come meter',async()=>{
  const {ProposedAllIngressTransportMeter}=await import('../src/mcp/all-ingress-transport-meter-proposal.js');
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(path.resolve('test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const m=new ProposedAllIngressTransportMeter(db,600);
    for(let i=0;i<600;i++)assert.equal(m.observe(SCOPE,NOW).allowed,true);
    for(let i=0;i<20;i++)assert.equal(m.observe(SCOPE,NOW).allowed,false);
  }finally{db.close()}
});
test('S5 300/300 strict isolated shares protect late-arriving quiet tenant',()=>{
  const {db,meter}=fixture(600,[{tenantId:A,weight:1},{tenantId:B,weight:1}]);
  try{
    assert.deepEqual(Object.fromEntries(meter.tenantAllocation()),{[A]:300,[B]:300});
    for(let i=0;i<600;i++){
      const r=meter.observe(A,'trusted-a-invocation-'+i,SHA,NOW);
      assert.equal(r.status,i<300?'reserved':'tenant-exhausted');
      assert.equal(r.authorizesToolExecution,false);
    }
    for(let i=0;i<20;i++){
      assert.equal(meter.observe(B,'trusted-b-invocation-'+i,SHA,NOW).status,'reserved');
    }
    const count=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_window').get() as {n:number}).n;
    assert.equal(count,320);
    const by=db.prepare('SELECT tenant_id,COUNT(*) AS n FROM s5_fair_window GROUP BY tenant_id ORDER BY tenant_id').all() as Array<{tenant_id:string;n:number}>;
    assert.deepEqual(by.map(r=>r.n),[300,20]);
  }finally{db.close()}
});
test('S5 95/5 skew weighted plan protects minimum quiet user share',()=>{
  const {db,meter}=fixture(600,[{tenantId:A,weight:95},{tenantId:B,weight:5}]);
  try{
    assert.equal(meter.tenantAllocation().get(A),570);
    assert.equal(meter.tenantAllocation().get(B),30);
    for(let i=0;i<620;i++){
      assert.equal(meter.observe(A,'noisy-a-attempt-'+i,SHA,NOW).status,
        i<570?'reserved':'tenant-exhausted');
    }
    for(let i=0;i<30;i++)assert.equal(meter.observe(B,'quiet-b-attempt-'+i,SHA,NOW).status,'reserved');
    assert.equal(meter.observe(B,'quiet-b-extra-030',SHA,NOW).status,'tenant-exhausted');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM s5_fair_window').get() as {n:number}).n,600);
  }finally{db.close()}
});
test('S5 cross tenant forged principal, replay collision and unknown plan never grant',()=>{
  const {db,meter}=fixture(24,[{tenantId:A,weight:1},{tenantId:B,weight:1}]);
  try{
    const id='test-same-invocation-id01';
    assert.equal(meter.observe(A,id,SHA,NOW).status,'reserved');
    assert.equal(meter.observe(A,id,SHA,NOW).status,'duplicate');
    assert.equal(meter.observe(A,id,ALTERED,NOW).status,'collision');
    assert.equal(meter.observe(B,id,SHA,NOW).status,'collision');
    assert.equal(meter.observe('client-forged-plan-pro',id,SHA,NOW).status,'unknown-tenant');
    const r=meter.observe(B,'valid-b-invocation-0001',SHA,NOW);
    assert.equal(r.status,'reserved');
    const count=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations').get() as {n:number}).n;
    assert.equal(count,2);
  }finally{db.close()}
});
test('S5 exact rolling boundary and backward clock fail closed',()=>{
  const {db,meter}=fixture(2,[{tenantId:A,weight:1},{tenantId:B,weight:1}]);
  try{
    assert.equal(meter.observe(A,'test-window-invoke-0001',SHA,NOW).status,'reserved');
    const before=new Date(NOW.getTime()+59999);
    assert.equal(meter.observe(A,'test-window-invoke-0002',SHA,before).status,'tenant-exhausted');
    const boundary=new Date(NOW.getTime()+60000);
    assert.equal(meter.observe(A,'test-window-invoke-0003',SHA,boundary).status,'reserved');
    assert.throws(()=>meter.observe(A,'test-window-invoke-0004',SHA,NOW),/clock rollback/);
  }finally{db.close()}
});
test('S5 shared-file SQLITE_BUSY denies without phantom admission',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'s5-fair-busy-'));
  const file=path.join(folder,'fair.sqlite');
  const writer=new DatabaseSync(file);
  const reader=new DatabaseSync(file);
  try{
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    writer.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    reader.exec('PRAGMA busy_timeout=1');
    writer.exec('BEGIN IMMEDIATE');
    const fair=new ProposedS5ProtectedTenantAdmission(reader,{scope:SCOPE,
      globalRollingMinuteLimit:10,tenants:[{tenantId:A,weight:1}]});
    assert.throws(()=>fair.observe(A,'locked-test-invocation-1',SHA,NOW),/database is locked|SQLITE_BUSY/);
    writer.exec('ROLLBACK');
    assert.equal((writer.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations').get() as {n:number}).n,0);
    assert.equal((writer.prepare('SELECT COUNT(*) AS n FROM s5_fair_window').get() as {n:number}).n,0);
  }finally{try{writer.exec('ROLLBACK')}catch{};reader.close();writer.close();
    rmSync(folder,{recursive:true,force:true});}
});
test('S5 invalid protected-share plans are rejected',()=>{
  for(const spec of [
    {scope:SCOPE,globalRollingMinuteLimit:2,tenants:[{tenantId:A,weight:1},{tenantId:B,weight:1},{tenantId:C,weight:1}]},
    {scope:SCOPE,globalRollingMinuteLimit:601,tenants:[{tenantId:A,weight:1}]},
    {scope:SCOPE,globalRollingMinuteLimit:600,tenants:[{tenantId:A,weight:0}]},
    {scope:SCOPE,globalRollingMinuteLimit:600,tenants:[{tenantId:A,weight:1},{tenantId:A,weight:1}]},
  ])assert.throws(()=>calculateS5ProtectedShares(spec));
});
