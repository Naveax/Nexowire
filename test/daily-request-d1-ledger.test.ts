import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type D1DatabaseLike, type D1PreparedStatementLike, type D1ResultLike,
  D1ControlPlaneStore,
} from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { DailyRequestD1Ledger } from '../src/product/daily-request-d1-ledger.js';
import {MemoryBillingStore} from '../src/product/memory-billing-store.js';
import {ProposedDailyEntitlementResolver} from '../src/product/daily-entitlement-proposal.js';
import {ProposedTrustedDailyReservation} from '../src/product/trusted-daily-reservation-proposal.js';

class SQLiteStatement implements D1PreparedStatementLike {
  constructor(private readonly statement:StatementSync,private readonly values:unknown[]=[]){}
  bind(...values:unknown[]):D1PreparedStatementLike {
    return new SQLiteStatement(this.statement,values);
  }
  async first<T>():Promise<T|null>{
    return (this.statement.get(...this.values as Parameters<StatementSync['get']>)??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>> {
    return {success:true,results:this.statement.all(...this.values as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>> {
    return {success:true,meta:{changes:Number(this.statement.run(...this.values as Parameters<StatementSync['run']>).changes)}};
  }
}
class SQLiteAdapter implements D1DatabaseLike {
  constructor(private readonly database:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new SQLiteStatement(this.database.prepare(sql))}
  async batch(statements:D1PreparedStatementLike[]):Promise<D1ResultLike[]> {
    this.database.exec('BEGIN');
    try {
      const results=[];
      for(const item of statements) results.push(await item.run());
      this.database.exec('COMMIT');
      return results;
    } catch(e) {
      this.database.exec('ROLLBACK');
      throw e;
    }
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
async function fixture() {
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-s2-daily-'));
  const dbPath=path.join(folder,'test.db');
  const a=new DatabaseSync(dbPath);
  a.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000');
  for(const file of migrations){
    a.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',file),'utf8'));
  }
  // Load this as a staging-only fixture: never auto-apply via production migrations.
  a.exec(readFileSync(path.join(process.cwd(),'test','fixtures','scale-v2-daily-requests-staging.sql'),'utf8'));
  const b=new DatabaseSync(dbPath);
  b.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000');
  const control=new ControlPlaneService(new D1ControlPlaneStore(new SQLiteAdapter(a)),{
    now:()=>new Date('2026-10-15T12:00:00.000Z'),
  });
  const owner=await control.ensureAccount({id:'s2-owner-primary'});
  const secondOwner=await control.ensureAccount({id:'s2-owner-secondary'});
  const ledgers=[new DailyRequestD1Ledger(new SQLiteAdapter(a)),new DailyRequestD1Ledger(new SQLiteAdapter(b))] as const;
  return {
    a,b,ledgers,owner,secondOwner,
    close(){b.close();a.close();rmSync(folder,{recursive:true,force:true})},
  };
}
const first=new Date('2026-10-15T23:59:59.999Z');
const next=new Date('2026-10-16T00:00:00.001Z');
const input=(subject:string,id:string,limit=1000,at=first)=>({
  quotaSubjectId:subject,invocationId:id,trustedDailyLimit:limit,acceptedAt:at,
});

test('S2 additive migration is isolated from existing monthly quota table',async()=>{
  const f=await fixture();
  try {
    const monthlyBefore=f.a.prepare('SELECT COUNT(*) as count FROM quota_usage_events').get() as {count:number};
    const daily=await f.ledgers[0].reserve(input(f.owner.quotaSubjectId,'standalone-daily-0001'));
    assert.equal(daily.status,'reserved');
    assert.equal(daily.usedRequests,1);
    const monthlyAfter=f.a.prepare('SELECT COUNT(*) as count FROM quota_usage_events').get() as {count:number};
    assert.equal(monthlyBefore.count,monthlyAfter.count);
  }finally{f.close()}
});

test('S2 real SQLite trigger denies 1001st accepted Free call and never creates an over-cap event',async()=>{
  const f=await fixture();
  try {
    for(let i=0;i<1000;i++){
      const result=await f.ledgers[i%2 === 0 ? 0 : 1].reserve(input(
        f.owner.quotaSubjectId,'daily-invoke-'+String(i).padStart(5,'0'),
      ));
      assert.equal(result.status,'reserved');
      assert.equal(result.usedRequests,i+1);
    }
    const denied=await f.ledgers[1].reserve(input(f.owner.quotaSubjectId,'daily-invoke-1001'));
    assert.equal(denied.status,'exhausted');
    assert.equal(denied.usedRequests,1000);
    const row=f.b.prepare('SELECT COUNT(*) AS n FROM daily_request_invocations').get() as {n:number};
    assert.equal(row.n,1000);
  }finally{f.close()}
});

test('S2 same invocation ID cannot run again after UTC rollover on a second connection',async()=>{
  const f=await fixture();
  try {
    const id='stable-cross-utc-0001',subject=f.owner.quotaSubjectId;
    assert.equal((await f.ledgers[0].reserve(input(subject,id,1000,first))).status,'reserved');
    const duplicate=await f.ledgers[1].reserve(input(subject,id,1000,next));
    assert.equal(duplicate.status,'duplicate');
    assert.equal(duplicate.usedRequests,0);
    const fresh=await f.ledgers[1].reserve(input(subject,'fresh-next-day-0002',1000,next));
    assert.equal(fresh.status,'reserved');
    assert.equal(fresh.usedRequests,1);
    const independent=await f.ledgers[0].reserve(input(f.secondOwner.quotaSubjectId,id,1000,next));
    assert.equal(independent.status,'reserved');
    assert.equal(independent.usedRequests,1);
  }finally{f.close()}
});

test('S2 two independent file-backed SQLite handles admit once for concurrent replay',async()=>{
  const f=await fixture();
  try{
    const subject=f.owner.quotaSubjectId;
    const results=await Promise.all(Array.from({length:16},(_,i)=>f.ledgers[i%2 === 0 ? 0 : 1].reserve(
      input(subject,'parallel-replay-0003'),
    )));
    assert.equal(results.filter(x=>x.status==='reserved').length,1);
    assert.equal(results.filter(x=>x.status==='duplicate').length,15);
    const count=f.a.prepare('SELECT used_requests FROM daily_request_periods WHERE quota_subject_id = ? AND day_key = ?')
      .get(subject,'2026-10-15') as {used_requests:number};
    assert.equal(count.used_requests,1);
  }finally{f.close()}
});

test('S2 999-to-1000 boundary across two connections permits only one unique parallel call',async()=>{
  const f=await fixture();
  try {
    const subject=f.owner.quotaSubjectId;
    for(let i=0;i<999;i++){
      await f.ledgers[0].reserve(input(subject,'fill-limited-'+String(i).padStart(6,'0')));
    }
    const results=await Promise.all(Array.from({length:12},(_,i)=>f.ledgers[i%2 === 0 ? 0 : 1].reserve(
      input(subject,'boundary-attempt-'+String(i).padStart(5,'0')),
    )));
    assert.equal(results.filter(x=>x.status==='reserved').length,1);
    assert.equal(results.filter(x=>x.status==='exhausted').length,11);
    const row=f.b.prepare('SELECT used_requests FROM daily_request_periods WHERE quota_subject_id = ? AND day_key = ?')
      .get(subject,'2026-10-15') as {used_requests:number};
    assert.equal(row.used_requests,1000);
  }finally{f.close()}
});

test('S2 trusted plan downgrade blocks above new cap, upgrades honor existing usage',async()=>{
  const f=await fixture();
  try {
    const subject=f.owner.quotaSubjectId;
    for(let i=0;i<4;i++){
      assert.equal((await f.ledgers[0].reserve(input(subject,'plan-step-000'+i,5))).status,'reserved');
    }
    assert.equal((await f.ledgers[1].reserve(input(subject,'downgrade-step-0001',2))).status,'exhausted');
    assert.equal((await f.ledgers[1].reserve(input(subject,'upgrade-step-0002',10))).status,'reserved');
    assert.equal((await f.ledgers[0].reserve(input(subject,'upgrade-step-0002',10))).status,'duplicate');
  }finally{f.close()}
});

test('S2 unknown D1 failures and invalid inputs fail closed instead of reserving work',async()=>{
  const db:D1DatabaseLike={
    prepare():D1PreparedStatementLike {throw new Error('UNKNOWN_REMOTE_D1_OUTAGE')},
    async batch(){throw new Error('UNKNOWN_REMOTE_D1_OUTAGE')},
  };
  const ledger=new DailyRequestD1Ledger(db);
  await assert.rejects(ledger.reserve(input('quota-fake-owner','unknown-db-test-0001')),/UNKNOWN_REMOTE_D1_OUTAGE/);
  await assert.rejects(ledger.reserve(input('too short','bad-event-0001')),/Invalid quota subject/);
  await assert.rejects(ledger.reserve(input('quota-fake-owner','bad',1000)),/Invalid invocation/);
  await assert.rejects(ledger.reserve(input('quota-fake-owner','valid-event-0002',0)),/Invalid trusted daily limit/);
});

test('S2 trusted authority feeds real SQLite D1 ledger without client-controlled tier, limit or subject',async()=>{
  const f=await fixture();
  try {
    const control=new D1ControlPlaneStore(new SQLiteAdapter(f.a));
    const billing=new MemoryBillingStore();
    const make=(paid=false)=>new ProposedTrustedDailyReservation(
      new ProposedDailyEntitlementResolver({control,billing},{
        paidEntitlementsEnabled:paid,now:()=>first,
      }),
      f.ledgers[0],()=>first,
    );
    const fresh=await make().reserveAuthenticated(f.owner.id,'trusted-free-0001');
    assert.equal(fresh.status,'reserved');
    if(fresh.status!=='reserved')return;
    assert.equal(fresh.dailyLimit,1000);
    assert.equal(fresh.usedRequests,1);
    const dupe=await make().reserveAuthenticated(f.owner.id,'trusted-free-0001');
    assert.equal(dupe.status,'duplicate');

    const subject=await control.getQuotaSubject(f.owner.quotaSubjectId);
    assert.ok(subject);
    await control.putQuotaSubject({...subject,kind:'subscription'});
    await control.putAccount({...f.owner,planId:'plus'});

    const disabled=await make().reserveAuthenticated(f.owner.id,'trusted-plus-0002');
    assert.deepEqual(disabled,{status:'denied',reason:'paid-plans-disabled'});
    const noProvider=await make(true).reserveAuthenticated(f.owner.id,'trusted-plus-0002');
    assert.deepEqual(noProvider,{status:'denied',reason:'provider-entitlement-missing'});

    await billing.putSubscription({
      provider:'lemonsqueezy',providerSubscriptionId:'trusted-provider-sub',
      providerCustomerId:'trusted-provider-owner',accountId:f.owner.id,
      planId:'plus',variantId:'trusted-plus-variant',status:'active',
      renewsAt:'2026-11-01T00:00:00.000Z',endsAt:null,trialEndsAt:null,
      providerUpdatedAt:'2026-10-15T20:00:00.000Z',
      createdAt:'2026-10-01T00:00:00.000Z',
      updatedAt:'2026-10-15T20:00:00.000Z',
    });
    const trusted=await make(true).reserveAuthenticated(f.owner.id,'trusted-plus-0002');
    assert.equal(trusted.status,'reserved');
    if(trusted.status==='reserved') {
      assert.equal(trusted.dailyLimit,5000);
      assert.equal(trusted.usedRequests,2);
    }
    const rows=f.a.prepare(
      'SELECT COUNT(*) as n FROM daily_request_invocations WHERE quota_subject_id = ?',
    ).get(f.owner.quotaSubjectId) as {n:number};
    assert.equal(rows.n,2);
  }finally{f.close()}
});

test('S2 staging preflight fails closed if provider or D1 state becomes unavailable',async()=>{
  const f=await fixture();
  try{
    const control=new D1ControlPlaneStore(new SQLiteAdapter(f.a));
    const resolver=new ProposedDailyEntitlementResolver({
      control,
      billing:new MemoryBillingStore(),
    },{now:()=>first});
    const unavailableLedger=new ProposedTrustedDailyReservation(resolver,{
      reserve:async()=>{throw new Error('NO_SAFE_RESERVATION')},
    },()=>first);
    await assert.rejects(
      unavailableLedger.reserveAuthenticated(f.owner.id,'failed-reservation-0003'),
      /NO_SAFE_RESERVATION/,
    );
    const absent=await unavailableLedger.reserveAuthenticated('missing-account','not-reserved-0004');
    assert.deepEqual(absent,{status:'denied',reason:'account-not-found'});
  }finally{f.close()}
});
