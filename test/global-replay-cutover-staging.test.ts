import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type D1DatabaseLike, type D1PreparedStatementLike, type D1ResultLike,
  D1ControlPlaneStore,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {ProposedDualQuotaD1Ledger} from '../src/product/dual-quota-d1-proposal.js';
import {hostedMcpUsageEventId} from '../src/mcp/hosted-metering.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly query: StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.query,args)}
  async first<T>():Promise<T|null>{
    return (this.query.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.query.all(...this.args as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    return {success:true,meta:{changes:Number(this.query.run(...this.args as Parameters<StatementSync['run']>).changes)}};
  }
}
class Adapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try{const result=[];for(const item of items)result.push(await item.run());this.db.exec('COMMIT');return result}
    catch(error){this.db.exec('ROLLBACK');throw error}
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
 const folder=mkdtempSync(path.join(os.tmpdir(),'nexowire-s2-cutover-'));
 const db=new DatabaseSync(path.join(folder,'staging.db'));
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
 for(const migration of migrations){
  db.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',migration),'utf8'));
 }
 for(const file of ['scale-v2-daily-requests-staging.sql','scale-v2-dual-quota-staging.sql']){
  db.exec(readFileSync(path.join(process.cwd(),'test/fixtures',file),'utf8'));
 }
 const service=new ControlPlaneService(new D1ControlPlaneStore(new Adapter(db)),{
  now:()=>new Date('2026-10-15T12:00:00Z'),
 });
 const account=await service.ensureAccount({id:'cutover-account-0001'});
 const other=await service.ensureAccount({id:'cutover-account-0002'});
 const ledger=new ProposedDualQuotaD1Ledger(new Adapter(db));
 const canonical=(id:string)=>hostedMcpUsageEventId({accountId:account.id,invocationId:id});
 const insertLegacyMonthly=(subject:string,eventId:string,month:'2026-09'|'2026-10')=>{
  const start=month+'-01T00:00:00.000Z';
  const end=month==='2026-09'?'2026-10-01T00:00:00.000Z':'2026-11-01T00:00:00.000Z';
  db.prepare('INSERT INTO quota_usage_events (quota_subject_id,period_key,event_id,credits,billing_mode,monthly_credits,period_start,period_end,charged_at) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(subject,month,eventId,5,'free',1000,start,end,start);
 };
 const insertLegacyDaily=(subject:string,eventId:string)=>{
  db.prepare('INSERT INTO daily_request_invocations (quota_subject_id,invocation_id,day_key,daily_limit,accepted_at) VALUES (?,?,?,?,?)')
   .run(subject,eventId,'2026-10-15',1000,'2026-10-15T12:00:00.000Z');
 };
 const activate=()=>{
  const sql=readFileSync(path.join(process.cwd(),'test/fixtures/scale-v2-global-replay-cutover-staging.sql'),'utf8');
  db.exec('BEGIN');
  try{db.exec(sql);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
 };
 const reserve=(subject:string,eventId:string,when='2026-10-15T12:00:00.000Z')=>ledger.reserve({
  quotaSubjectId:subject,invocationId:eventId,acceptedAt:new Date(when),
  dailyLimit:1000,monthlyCredits:1000,toolCredits:5,billingMode:'free',
 });
 const counters=(subject:string)=>{
  const daily=db.prepare('SELECT COUNT(*) AS n FROM daily_request_invocations WHERE quota_subject_id=?').get(subject) as {n:number};
  const monthly=db.prepare('SELECT COUNT(*) AS n FROM quota_usage_events WHERE quota_subject_id=?').get(subject) as {n:number};
  const dual=db.prepare('SELECT COUNT(*) AS n FROM dual_quota_reservations WHERE quota_subject_id=?').get(subject) as {n:number};
  return {daily:daily.n,monthly:monthly.n,dual:dual.n};
 };
 const fence=()=>Number((db.prepare('SELECT COUNT(*) AS n FROM mcp_global_replay_fence').get() as {n:number}).n);
 return {db,account,other,ledger,canonical,insertLegacyMonthly,insertLegacyDaily,activate,reserve,counters,fence,
  close(){db.close();rmSync(folder,{recursive:true,force:true})}};
}

test('historical last-month monthly-only execution is fenced across a new UTC month',async()=>{
 const f=await fixture();try{
  const id=f.canonical('legacy-september-0001');
  f.insertLegacyMonthly(f.account.quotaSubjectId,id,'2026-09');
  f.activate();
  assert.equal(f.fence(),1);
  const before=f.counters(f.account.quotaSubjectId);
  await assert.rejects(f.reserve(f.account.quotaSubjectId,id),/UNIQUE|constraint/i);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),before);
 }finally{f.close()}
});

test('fresh dual reservation writes fence and both counters, but cannot replay on another quota subject',async()=>{
 const f=await fixture();try{
  f.activate();
  const id=f.canonical('new-cross-subject-0002');
  const result=await f.reserve(f.account.quotaSubjectId,id);
  assert.equal(result.status,'reserved');
  assert.equal(f.fence(),1);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),{daily:1,monthly:1,dual:1});
  const before=f.counters(f.other.quotaSubjectId);
  await assert.rejects(f.reserve(f.other.quotaSubjectId,id),/UNIQUE|constraint/i);
  assert.deepEqual(f.counters(f.other.quotaSubjectId),before);
  assert.equal(f.fence(),1);
 }finally{f.close()}
});

test('legacy monthly-only route is closed for new MCP invocations after cutover',async()=>{
 const f=await fixture();try{
  f.activate();
  const id=f.canonical('old-monthly-route-0003');
  assert.throws(()=>f.insertLegacyMonthly(f.account.quotaSubjectId,id,'2026-10'),
   /legacy_monthly_hosted_mcp_path_closed/);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),{daily:0,monthly:0,dual:0});
 }finally{f.close()}
});

test('legacy daily-only route is closed for new MCP invocations after cutover',async()=>{
 const f=await fixture();try{
  f.activate();
  const id=f.canonical('old-daily-route-0004');
  assert.throws(()=>f.insertLegacyDaily(f.account.quotaSubjectId,id),
   /legacy_daily_hosted_mcp_path_closed/);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),{daily:0,monthly:0,dual:0});
 }finally{f.close()}
});

test('unresolved historical repeat across old monthly periods aborts cutover transaction',async()=>{
 const f=await fixture();try{
  const id=f.canonical('old-repeat-0005');
  f.insertLegacyMonthly(f.account.quotaSubjectId,id,'2026-09');
  f.insertLegacyMonthly(f.account.quotaSubjectId,id,'2026-10');
  assert.throws(()=>f.activate(),/UNIQUE|constraint/i);
  const table=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_global_replay_fence'").get();
  assert.equal(table,undefined);
 }finally{f.close()}
});

test('preexisting daily-only canonical invocation is backfilled without monthly credit',async()=>{
 const f=await fixture();try{
  const id=f.canonical('daily-existing-0006');
  f.insertLegacyDaily(f.account.quotaSubjectId,id);
  f.activate();
  assert.equal(f.fence(),1);
  const before=f.counters(f.account.quotaSubjectId);
  await assert.rejects(f.reserve(f.account.quotaSubjectId,id),/UNIQUE|constraint/i);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),before);
 }finally{f.close()}
});

test('noncanonical dual key fails closed during cutover without partial charges',async()=>{
 const f=await fixture();try{
  f.activate();
  await assert.rejects(f.reserve(f.account.quotaSubjectId,'not-canonical-0007'),
   /noncanonical_hosted_mcp_event_id/);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),{daily:0,monthly:0,dual:0});
  assert.equal(f.fence(),0);
 }finally{f.close()}
});

test('backfilled monthly+daily same canonical event becomes one fence entry, not two',async()=>{
 const f=await fixture();try{
  const id=f.canonical('combined-legacy-0008');
  f.insertLegacyMonthly(f.account.quotaSubjectId,id,'2026-10');
  f.insertLegacyDaily(f.account.quotaSubjectId,id);
  f.activate();
  assert.equal(f.fence(),1);
  const before=f.counters(f.account.quotaSubjectId);
  await assert.rejects(f.reserve(f.account.quotaSubjectId,id,'2026-11-01T00:00:00.000Z'),
   /UNIQUE|constraint/i);
  assert.deepEqual(f.counters(f.account.quotaSubjectId),before);
 }finally{f.close()}
});
