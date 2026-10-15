import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
 type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike,
 D1ControlPlaneStore,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {ProposedDualQuotaD1Ledger} from '../src/product/dual-quota-d1-proposal.js';

class Stmt implements D1PreparedStatementLike{
 constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
 bind(...args:unknown[]):D1PreparedStatementLike{return new Stmt(this.stmt,args)}
 async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
 async all<T>():Promise<D1ResultLike<T>>{return{success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
 async run<T>():Promise<D1ResultLike<T>>{return{success:true,meta:{changes:Number(this.stmt.run(...this.args as Parameters<StatementSync['run']>).changes)}}}
}
class DB implements D1DatabaseLike{
 constructor(private readonly db:DatabaseSync){}
 prepare(sql:string):D1PreparedStatementLike{return new Stmt(this.db.prepare(sql))}
 async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
   this.db.exec('BEGIN');
   try{const a=[];for(const item of items)a.push(await item.run());this.db.exec('COMMIT');return a}
   catch(e){this.db.exec('ROLLBACK');throw e}
 }
}
const migrations=[
 '0001_control_plane.sql','0002_external_identities.sql',
 '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
 '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
 '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
 '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
 '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql',
];
async function fixture(){
 const folder=mkdtempSync(path.join(tmpdir(),'nexowire-s2-dual-'));
 const file=path.join(folder,'dual.db');
 const db1=new DatabaseSync(file);
 db1.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000');
 for(const f of migrations){db1.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',f),'utf8'))}
 for(const f of [
   'scale-v2-daily-requests-staging.sql','scale-v2-dual-quota-staging.sql',
 ]){
   db1.exec(readFileSync(path.join(process.cwd(),'test/fixtures',f),'utf8'));
 }
 const db2=new DatabaseSync(file);
 db2.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000');
 const service=new ControlPlaneService(new D1ControlPlaneStore(new DB(db1)),{
   now:()=>new Date('2026-10-15T12:00:00Z'),
 });
 const account=await service.ensureAccount({id:'dual-test-owner'});
 const other=await service.ensureAccount({id:'dual-other-owner'});
 const ledgers=[new ProposedDualQuotaD1Ledger(new DB(db1)),new ProposedDualQuotaD1Ledger(new DB(db2))] as const;
 const count=(sub:string,month='2026-10',day='2026-10-15')=>{
  const monthly=db1.prepare(
    'SELECT used_credits FROM quota_usage_periods WHERE quota_subject_id=? AND period_key=?',
  ).get(sub,month) as {used_credits:number}|undefined;
  const daily=db1.prepare(
    'SELECT used_requests FROM daily_request_periods WHERE quota_subject_id=? AND day_key=?',
  ).get(sub,day) as {used_requests:number}|undefined;
  const oldEvents=db1.prepare('SELECT COUNT(*) AS n FROM quota_usage_events WHERE quota_subject_id=?').get(sub) as {n:number};
  const newEvents=db1.prepare('SELECT COUNT(*) AS n FROM daily_request_invocations WHERE quota_subject_id=?').get(sub) as {n:number};
  const jointEvents=db1.prepare('SELECT COUNT(*) AS n FROM dual_quota_reservations WHERE quota_subject_id=?').get(sub) as {n:number};
  return {monthly:monthly?.used_credits??0,daily:daily?.used_requests??0,oldEvents:oldEvents.n,newEvents:newEvents.n,jointEvents:jointEvents.n};
 };
 return{db1,db2,account,other,ledgers,count,close(){
   db2.close();db1.close();rmSync(folder,{recursive:true,force:true});
 }};
}
const stamp=new Date('2026-10-15T23:59:59.900Z');
const next=new Date('2026-10-16T00:00:00.100Z');
function req(subject:string,id:string,options:{
  acceptedAt?:Date;dailyLimit?:number;monthlyCredits?:number;toolCredits?:number;
}={}){
 return {quotaSubjectId:subject,invocationId:id,acceptedAt:options.acceptedAt??stamp,
   dailyLimit:options.dailyLimit??1000,monthlyCredits:options.monthlyCredits??1000,
   toolCredits:options.toolCredits??1,billingMode:'free' as const};
}
test('one SQL operation atomically reserves one daily request and weighted monthly credits',async()=>{
 const f=await fixture();
 try{
  const r=await f.ledgers[0].reserve(req(f.account.quotaSubjectId,'dual-first-call-0001',{toolCredits:5}));
  assert.equal(r.status,'reserved');
  assert.equal(r.usedDaily,1);
  assert.equal(r.usedMonthlyCredits,5);
  assert.deepEqual(f.count(f.account.quotaSubjectId),{
    monthly:5,daily:1,oldEvents:1,newEvents:1,jointEvents:1,
  });
 }finally{f.close()}
});
test('monthly exhaustion rolls back daily trigger + original monthly row + dual reservation',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  assert.equal((await f.ledgers[0].reserve(req(sub,'monthly-fill-0002',{toolCredits:5,monthlyCredits:5}))).status,'reserved');
  const before=f.count(sub);
  const result=await f.ledgers[1].reserve(req(sub,'monthly-denied-0003',{toolCredits:1,monthlyCredits:5}));
  assert.equal(result.status,'monthly-exhausted');
  assert.deepEqual(f.count(sub),before);
 }finally{f.close()}
});
test('daily exhaustion rolls back BOTH quota counters and reservation',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  assert.equal((await f.ledgers[0].reserve(req(sub,'daily-first-0004',{dailyLimit:1,toolCredits:5}))).status,'reserved');
  const before=f.count(sub);
  const result=await f.ledgers[1].reserve(req(sub,'daily-denied-0005',{dailyLimit:1,toolCredits:1}));
  assert.equal(result.status,'daily-exhausted');
  assert.deepEqual(f.count(sub),before);
 }finally{f.close()}
});
test('16 concurrent same IDs across two SQLite connections admit exactly once in BOTH ledgers',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  const responses=await Promise.all(Array.from({length:16},(_,i)=>
   f.ledgers[i%2===0?0:1].reserve(req(sub,'dual-parallel-id-0006',{toolCredits:5}))));
  assert.equal(responses.filter(x=>x.status==='reserved').length,1);
  assert.equal(responses.filter(x=>x.status==='duplicate').length,15);
  const c=f.count(sub);assert.equal(c.monthly,5);assert.equal(c.daily,1);
  assert.equal(c.oldEvents,1);assert.equal(c.newEvents,1);assert.equal(c.jointEvents,1);
 }finally{f.close()}
});
test('monthly limit may allow a request while daily limit denies, with no partial monthly charge',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  assert.equal((await f.ledgers[0].reserve(req(sub,'dual-limit-0007',{dailyLimit:1,monthlyCredits:1000}))).status,'reserved');
  const result=await f.ledgers[1].reserve(req(sub,'dual-limit-0008',{dailyLimit:1,monthlyCredits:1000}));
  assert.equal(result.status,'daily-exhausted');assert.equal(f.count(sub).monthly,1);
 }finally{f.close()}
});
test('cross UTC day/month duplicate is rejected while new invocation gets a new day counter',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  assert.equal((await f.ledgers[0].reserve(req(sub,'dual-rollover-0009'))).status,'reserved');
  assert.equal((await f.ledgers[1].reserve(req(sub,'dual-rollover-0009',{acceptedAt:next}))).status,'duplicate');
  assert.equal((await f.ledgers[1].reserve(req(sub,'dual-rollover-0010',{acceptedAt:next}))).status,'reserved');
  assert.equal(f.count(sub,'2026-10','2026-10-15').daily,1);
  assert.equal(f.count(sub,'2026-10','2026-10-16').daily,1);
  assert.equal(f.count(sub).monthly,2);
 }finally{f.close()}
});
test('monthly period rollover is distinct from permanent event dedup and subject isolation',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  const monthNext=new Date('2026-11-01T00:00:00.000Z');
  assert.equal((await f.ledgers[0].reserve(req(sub,'cross-month-0011'))).status,'reserved');
  assert.equal((await f.ledgers[1].reserve(req(sub,'cross-month-0011',{acceptedAt:monthNext}))).status,'duplicate');
  assert.equal((await f.ledgers[1].reserve(req(sub,'cross-month-0012',{acceptedAt:monthNext}))).status,'reserved');
  assert.equal(f.count(sub,'2026-11','2026-11-01').monthly,1);
  assert.equal((await f.ledgers[1].reserve(req(f.other.quotaSubjectId,'cross-month-0011',{acceptedAt:monthNext}))).status,'reserved');
 }finally{f.close()}
});
test('999/1000 boundary with 12 unique parallel attempts admits one with both ledgers consistent',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  for(let i=0;i<999;i++){
   const r=await f.ledgers[i%2===0?0:1].reserve(req(sub,'fill-'+String(i).padStart(7,'0')));
   assert.equal(r.status,'reserved');
  }
  const responses=await Promise.all(Array.from({length:12},(_,i)=>
    f.ledgers[i%2===0?0:1].reserve(req(sub,'boundary-'+String(i).padStart(6,'0')))));
  assert.equal(responses.filter(x=>x.status==='reserved').length,1);
  assert.equal(responses.filter(x=>x.status==='daily-exhausted'||x.status==='monthly-exhausted').length,11);
  const c=f.count(sub);assert.equal(c.daily,1000);assert.equal(c.monthly,1000);
  assert.equal(c.oldEvents,1000);assert.equal(c.newEvents,1000);assert.equal(c.jointEvents,1000);
 }finally{f.close()}
});
test('legacy monthly-only event cannot be recharged through dual route, and daily must roll back',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  f.db1.prepare(
   'INSERT INTO quota_usage_events (quota_subject_id, period_key, event_id, credits, billing_mode, monthly_credits, period_start, period_end, charged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sub,'2026-10','legacy-cutover-0013',5,'free',1000,
    '2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','2026-10-15T23:59:59.900Z');
  const before=f.count(sub);
  await assert.rejects(
   f.ledgers[1].reserve(req(sub,'legacy-cutover-0013')),
   /UNIQUE|constraint/i,
  );
  assert.deepEqual(f.count(sub),before);
  // Unknown migration conflict is not a granted reservation or a free retry.
 }finally{f.close()}
});
test('daily-only event already admitted blocks dual reservation without monthly partial debit',async()=>{
 const f=await fixture();
 try{
  const sub=f.account.quotaSubjectId;
  f.db1.prepare(
   'INSERT INTO daily_request_invocations (quota_subject_id, invocation_id, day_key, daily_limit, accepted_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sub,'daily-cutover-0014','2026-10-15',1000,'2026-10-15T23:59:59.900Z');
  const before=f.count(sub);
  await assert.rejects(
   f.ledgers[1].reserve(req(sub,'daily-cutover-0014')),
   /UNIQUE|constraint/i,
  );
  assert.deepEqual(f.count(sub),before);
 }finally{f.close()}
});
test('unknown backend outage and invalid unsigned quotas fail closed',async()=>{
 const db:D1DatabaseLike={
  prepare(){throw new Error('D1_UNAVAILABLE')},
  async batch(){throw new Error('D1_UNAVAILABLE')},
 };
 const ledger=new ProposedDualQuotaD1Ledger(db);
 await assert.rejects(ledger.reserve(req('subject-test-001','outage-call-0013')),/D1_UNAVAILABLE/);
 await assert.rejects(ledger.reserve(req('bad','bad-id')),/Invalid quota subject/);
 await assert.rejects(ledger.reserve(req('subject-test-001','invalid-cap-0014',{dailyLimit:0})),/Invalid daily limit/);
 await assert.rejects(ledger.reserve(req('subject-test-001','invalid-cost-0015',{toolCredits:0})),/Invalid tool credits/);
});
