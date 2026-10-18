import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type D1DatabaseLike, type D1PreparedStatementLike, type D1ResultLike,
  D1ControlPlaneStore } from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { ProposedV2QuotaD1Ledger } from '../src/product/v2-quota-d1-staging.js';
import type { QuotaEntitlementDecisionV2 } from '../src/product/subscription-entitlements-v2-proposal.js';
type Allowed=Extract<QuotaEntitlementDecisionV2,{status:'allowed'}>;

class Statement implements D1PreparedStatementLike{
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...a:unknown[]):D1PreparedStatementLike{return new Statement(this.stmt,a)}
  async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
  async run<T>():Promise<D1ResultLike<T>>{return {success:true,meta:{changes:Number(this.stmt.run(...this.args as Parameters<StatementSync['run']>).changes)}}}
}
class Adapter implements D1DatabaseLike{
  constructor(private readonly sqlite:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.sqlite.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.sqlite.exec('BEGIN');
    try{const results=[];for(const item of items)results.push(await item.run());this.sqlite.exec('COMMIT');return results}
    catch(e){this.sqlite.exec('ROLLBACK');throw e}
  }
}
const migrations=['0001_control_plane.sql','0002_external_identities.sql',
  '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
  '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
  '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
  '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
  '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql'];
const stamp=new Date('2026-10-18T23:59:59.900Z');
const rollover=new Date('2026-10-19T00:00:00.100Z');
async function fixture(){
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-v2-s4-'));
  const file=path.join(folder,'v2.db');
  const a=new DatabaseSync(file);
  a.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000');
  for(const migration of migrations)a.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',migration),'utf8'));
  for(const name of ['scale-v2-daily-requests-staging.sql',
    'scale-v2-dual-quota-staging.sql','scale-v2-tenant-minute-dual-staging.sql']){
    a.exec(readFileSync(path.join(process.cwd(),'test/fixtures',name),'utf8'));
  }
  const b=new DatabaseSync(file);
  b.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000');
  const service=new ControlPlaneService(new D1ControlPlaneStore(new Adapter(a)),{now:()=>stamp});
  const owner=await service.ensureAccount({id:'v2-owner-alpha'});
  const other=await service.ensureAccount({id:'v2-owner-beta'});
  function auth(accountId:string,tenant:string,subject:string, tier:'free'|'plus'|'pro'|'enterprise'='free',
      daily=1000,monthly=1000,minute:number|null=null,rev=1){
    a.prepare('INSERT INTO v2_quota_authority(account_id,tenant_id,quota_subject_id,revision,tier,daily_limit,minute_limit,monthly_credits,state) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,tenant_id) DO UPDATE SET quota_subject_id=excluded.quota_subject_id,revision=excluded.revision,tier=excluded.tier,daily_limit=excluded.daily_limit,minute_limit=excluded.minute_limit,monthly_credits=excluded.monthly_credits,state=excluded.state')
      .run(accountId,tenant,subject,rev,tier,daily,minute,monthly,'active');
    return {status:'allowed',tier,accountId,tenantId:tenant,quotaSubjectId:subject,
      deviceId:null,revision:rev,dailyLimit:daily,rollingMinuteLimit:minute,
      monthlyWeightedCredits:monthly,termsHash:null} as Allowed;
  }
  const quota=auth(owner.id,'tenant-alpha',owner.quotaSubjectId);
  const otherQuota=auth(other.id,'tenant-beta',other.quotaSubjectId);
  const ledgers=[new ProposedV2QuotaD1Ledger(new Adapter(a)),
    new ProposedV2QuotaD1Ledger(new Adapter(b))] as const;
  const count=(subject:string)=>{
    const daily=a.prepare('SELECT COUNT(*) AS n FROM daily_request_invocations WHERE quota_subject_id=?').get(subject) as {n:number};
    const monthly=a.prepare('SELECT COUNT(*) AS n FROM quota_usage_events WHERE quota_subject_id=?').get(subject) as {n:number};
    const v2=a.prepare('SELECT COUNT(*) AS n FROM v2_quota_reservations WHERE quota_subject_id=?').get(subject) as {n:number};
    const minute=a.prepare('SELECT COUNT(*) AS n FROM v2_quota_minute_events WHERE quota_subject_id=?').get(subject) as {n:number};
    return {daily:daily.n,monthly:monthly.n,v2:v2.n,minute:minute.n};
  };
  return {a,b,owner,other,auth,quota,otherQuota,ledgers,count,
    close(){b.close();a.close();rmSync(folder,{recursive:true,force:true})}};
}
const req=(entitlement:Allowed,id:string,now=stamp,toolCredits=1)=>({
  entitlement,invocationId:id,now,toolCredits,
  requestFingerprint:createHash('sha256').update('canonical-root:'+id).digest('hex'),
});
test('S2/S4 single atomic insert charges one logical root and retains 5x legacy weighting',async()=>{
  const f=await fixture();try{
    const r=await f.ledgers[0].reserve(req(f.quota,'hosted-root-0001',stamp,5));
    assert.equal(r.status,'reserved');
    assert.equal(r.usedDaily,1);
    assert.equal(r.usedMonthlyCredits,5);
    assert.equal(r.usedRollingMinute,1);
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:1,monthly:1,v2:1,minute:1});
  }finally{f.close()}
});
test('same hosted root from second SQLite writer is a duplicate across UTC midnight',async()=>{
  const f=await fixture();try{
    assert.equal((await f.ledgers[0].reserve(req(f.quota,'root-utc-replay-02'))).status,'reserved');
    const duplicate=await f.ledgers[1].reserve(req(f.quota,'root-utc-replay-02',rollover));
    assert.equal(duplicate.status,'duplicate');
    assert.equal((await f.ledgers[1].reserve(req(f.quota,'new-utc-root-003',rollover))).status,'reserved');
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:2,monthly:2,v2:2,minute:2});
  }finally{f.close()}
});
test('rolling minute cap persists across UTC midnight and frees only after 60s',async()=>{
  const f=await fixture();try{
    const grant=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'free',1000,1000,2,2);
    assert.equal((await f.ledgers[0].reserve(req(grant,'rolling-root-0001'))).status,'reserved');
    assert.equal((await f.ledgers[1].reserve(req(grant,'rolling-root-0002',rollover))).status,'reserved');
    const before=f.count(grant.quotaSubjectId);
    assert.equal((await f.ledgers[0].reserve(req(grant,'rolling-root-0003',rollover))).status,'minute-exhausted');
    assert.deepEqual(f.count(grant.quotaSubjectId),before);
    const later=new Date(stamp.getTime()+60001);
    assert.equal((await f.ledgers[1].reserve(req(grant,'rolling-root-0004',later))).status,'reserved');
  }finally{f.close()}
});
test('daily and monthly denials rollback all three counters with no partial credit',async()=>{
  const f=await fixture();try{
    const daily=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'free',1,1000,null,2);
    assert.equal((await f.ledgers[0].reserve(req(daily,'daily-ceiling-001',stamp,5))).status,'reserved');
    const before=f.count(daily.quotaSubjectId);
    assert.equal((await f.ledgers[1].reserve(req(daily,'daily-ceiling-002'))).status,'daily-exhausted');
    assert.deepEqual(f.count(daily.quotaSubjectId),before);
    const monthly=f.auth(f.owner.id,'tenant-alpha',daily.quotaSubjectId,'free',1000,5,null,3);
    assert.equal((await f.ledgers[1].reserve(req(monthly,'monthly-ceiling-003'))).status,'monthly-exhausted');
    assert.deepEqual(f.count(daily.quotaSubjectId),before);
  }finally{f.close()}
});
test('16 parallel same-ID requests admit once; distinct parallel calls hit atomic cap',async()=>{
  const f=await fixture();try{
    const grant=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'free',2,1000,null,2);
    const results=await Promise.all(Array.from({length:16},(_,i)=>
      (i%2===0?f.ledgers[0]:f.ledgers[1]).reserve(req(grant,'parallel-id-000001'))));
    assert.equal(results.filter(x=>x.status==='reserved').length,1);
    assert.equal(results.filter(x=>x.status==='duplicate').length,15);
    const distinct=await Promise.all(Array.from({length:10},(_,i)=>
      (i%2===0?f.ledgers[0]:f.ledgers[1]).reserve(req(grant,'unique-parallel-'+String(i).padStart(5,'0')))));
    assert.equal(distinct.filter(x=>x.status==='reserved').length,1);
    assert.equal(distinct.filter(x=>x.status==='daily-exhausted').length,9);
    assert.deepEqual(f.count(grant.quotaSubjectId),{daily:2,monthly:2,v2:2,minute:2});
  }finally{f.close()}
});
test('revoked/stale epoch, forged cap, wrong tenant, stolen device and changed plan are denied',async()=>{
  const f=await fixture();try{
    const grant=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'free',1000,1000,2,5);
    const attempt=async(a:Allowed,id:string)=>f.ledgers[0].reserve(req(a,id));
    const forged={...grant,dailyLimit:850000};
    assert.equal((await attempt(forged,'forged-cap-0001')).status,'revoked');
    const wrongTenant={...grant,tenantId:'tenant-beta'};
    assert.equal((await attempt(wrongTenant,'wrong-tenant-0002')).status,'revoked');
    const wrongDevice={...grant,deviceId:'device-foreign'};
    assert.equal((await attempt(wrongDevice,'wrong-device-0003')).status,'revoked');
    const otherGrant={...grant,accountId:f.other.id};
    assert.equal((await attempt(otherGrant,'wrong-account-0004')).status,'revoked');
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=revision+1 WHERE account_id=?').run('revoked',f.owner.id);
    assert.equal((await attempt(grant,'revoked-epoch-005')).status,'revoked');
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=? WHERE account_id=?').run('active',7,f.owner.id);
    assert.equal((await attempt(grant,'stale-epoch-0006')).status,'revoked');
    assert.deepEqual(f.count(grant.quotaSubjectId),{daily:0,monthly:0,v2:0,minute:0});
  }finally{f.close()}
});
test('enterprise tenant cannot share active subject with a different organization',async()=>{
  const f=await fixture();try{
    const sub=f.quota.quotaSubjectId;
    f.a.prepare("UPDATE quota_subjects SET kind='subscription' WHERE id=?").run(sub);
    f.a.prepare("UPDATE accounts SET plan_id='custom' WHERE id=?").run(f.owner.id);
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=revision+1 WHERE account_id=?').run('revoked',f.owner.id);
    const enterprise=f.auth(f.owner.id,'enterprise-alpha',sub,'enterprise',850000,1000000,600,2);
    // Another tenant holding the same resource would leak customer quota.
    f.auth(f.other.id,'enterprise-beta',sub,'enterprise',850000,1000000,600,1);
    assert.equal((await f.ledgers[0].reserve(req(enterprise,'enterprise-isolated-001'))).status,'revoked');
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=revision+1 WHERE account_id=?').run('revoked',f.other.id);
    assert.equal((await f.ledgers[1].reserve(req(enterprise,'enterprise-isolated-002'))).status,'reserved');
  }finally{f.close()}
});
test('D1 outage, invalid credits and untrusted result never authorize work',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.ledgers[0].reserve(req(f.quota,'root-invalid-cost',stamp,0)),/INVALID_TOOL_CREDITS/);
    await assert.rejects(f.ledgers[0].reserve(req({status:'denied',reason:'paid-plans-disabled'} as never,'root-not-allowed')),/V2_ENTITLEMENT_REQUIRED/);
    const missing:D1DatabaseLike={
      prepare(){throw new Error('D1_UNAVAILABLE')},
      async batch(){throw new Error('D1_UNAVAILABLE')},
    };
    await assert.rejects(new ProposedV2QuotaD1Ledger(missing).reserve(
      req(f.quota,'root-backend-down')),/D1_UNAVAILABLE/);
  }finally{f.close()}
});

test('sandbox Plus upgrade then Free downgrade does not reset usage or restore a stale paid grant',async()=>{
  const f=await fixture();try{
    assert.equal((await f.ledgers[0].reserve(req(f.quota,'migration-free-001'))).status,'reserved');
    f.a.prepare("UPDATE accounts SET plan_id='plus' WHERE id=?").run(f.owner.id);
    f.a.prepare("UPDATE quota_subjects SET kind='subscription' WHERE id=?").run(f.quota.quotaSubjectId);
    const plus=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'plus',5000,100000,null,2);
    assert.equal((await f.ledgers[1].reserve(req(plus,'migration-plus-002'))).status,'reserved');
    assert.equal((await f.ledgers[0].reserve(req(f.quota,'migration-stale-free'))).status,'revoked');
    f.a.prepare("UPDATE accounts SET plan_id='free' WHERE id=?").run(f.owner.id);
    f.a.prepare("UPDATE quota_subjects SET kind='free-cluster' WHERE id=?").run(f.quota.quotaSubjectId);
    const downgraded=f.auth(f.owner.id,'tenant-alpha',f.quota.quotaSubjectId,'free',1,1000,null,3);
    assert.equal((await f.ledgers[0].reserve(req(downgraded,'migration-after-free'))).status,'daily-exhausted');
    assert.equal((await f.ledgers[1].reserve(req(plus,'migration-stale-plus'))).status,'revoked');
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:2,monthly:2,v2:2,minute:2});
  }finally{f.close()}
});
test('enterprise 850,000 boundary can be seeded synthetically; no 850k live calls are claimed',async()=>{
  const f=await fixture();try{
    const subject=f.quota.quotaSubjectId;
    f.a.prepare("UPDATE quota_subjects SET kind='subscription' WHERE id=?").run(subject);
    f.a.prepare("UPDATE accounts SET plan_id='custom' WHERE id=?").run(f.owner.id);
    f.a.prepare("UPDATE v2_quota_authority SET state='revoked',revision=revision+1 WHERE account_id=?").run(f.owner.id);
    const grant=f.auth(f.owner.id,'tenant-enterprise',subject,'enterprise',850000,2000000,600,2);
    f.a.prepare('INSERT INTO daily_request_periods(quota_subject_id,day_key,used_requests) VALUES (?,?,?)')
      .run(subject,'2026-10-18',849999);
    const one=await f.ledgers[0].reserve(req(grant,'enterprise-boundary-0001'));
    assert.equal(one.status,'reserved');
    assert.equal(one.usedDaily,850000);
    const before=f.count(subject);
    const over=await f.ledgers[1].reserve(req(grant,'enterprise-boundary-0002'));
    assert.equal(over.status,'daily-exhausted');
    assert.deepEqual(f.count(subject),before);
  }finally{f.close()}
});
test('owned device is accepted but a real device linked to a different account is denied',async()=>{
  const f=await fixture();try{
    for(const [id,owner] of ([['device-alpha-real',f.owner.id],['device-beta-real',f.other.id]] as Array<[string,string]>)){
      f.a.prepare('INSERT INTO devices(id,owner_account_id,name,platform,credential_hash,online,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)')
        .run(id,owner,id,'win32','hash-'+id,stamp.toISOString(),stamp.toISOString());
    }
    const own={...f.quota,deviceId:'device-alpha-real'};
    assert.equal((await f.ledgers[0].reserve(req(own,'device-bound-0001'))).status,'reserved');
    const alien={...f.quota,deviceId:'device-beta-real'};
    assert.equal((await f.ledgers[1].reserve(req(alien,'device-bound-0002'))).status,'revoked');
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:1,monthly:1,v2:1,minute:1});
  }finally{f.close()}
});

test('stable root ID with a different signed request fingerprint is a conflict, never a free replay',async()=>{
  const f=await fixture();try{
    const original=req(f.quota,'fingerprint-immutability-001');
    assert.equal((await f.ledgers[0].reserve(original)).status,'reserved');
    const altered={...original,requestFingerprint:createHash('sha256').update('different action body').digest('hex')};
    assert.equal((await f.ledgers[1].reserve(altered)).status,'conflict');
    assert.equal((await f.ledgers[1].reserve({...original,now:rollover})).status,'duplicate');
    await assert.rejects(
      f.ledgers[0].reserve({...req(f.quota,'bad-hash-length-0001'),requestFingerprint:'0'.repeat(63)}),
      /INVALID_REQUEST_FINGERPRINT/,
    );
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:1,monthly:1,v2:1,minute:1});
  }finally{f.close()}
});
test('database authority revision cannot regress, delete, or change tenant/subject in place',async()=>{
  const f=await fixture();try{
    const id=f.owner.id, subject=f.quota.quotaSubjectId;
    assert.throws(()=>f.a.prepare(
      'UPDATE v2_quota_authority SET state=? WHERE account_id=?',
    ).run('revoked',id),/v2_authority_epoch_regression/);
    assert.throws(()=>f.a.prepare(
      'UPDATE v2_quota_authority SET tenant_id=?,revision=? WHERE account_id=?',
    ).run('tenant-stolen',2,id),/v2_authority_scope_immutable/);
    assert.throws(()=>f.a.prepare(
      'DELETE FROM v2_quota_authority WHERE account_id=?',
    ).run(id),/v2_authority_delete_forbidden/);
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=revision+1 WHERE account_id=?')
      .run('revoked',id);
    assert.equal((await f.ledgers[0].reserve(req(f.quota,'stale-revision-001'))).status,'revoked');
    const regranted={...f.quota,revision:2};
    assert.equal((await f.ledgers[1].reserve(req(regranted,'revoked-at-epoch-002'))).status,'revoked');
    f.a.prepare('UPDATE v2_quota_authority SET state=?,revision=revision+1 WHERE account_id=?')
      .run('active',id);
    const fresh={...f.quota,revision:3};
    assert.equal((await f.ledgers[1].reserve(req(fresh,'new-epoch-003'))).status,'reserved');
    assert.deepEqual(f.count(subject),{daily:1,monthly:1,v2:1,minute:1});
  }finally{f.close()}
});
test('a Free quota subject mutated to subscription kind refuses admission before credit change',async()=>{
  const f=await fixture();try{
    const subject=f.quota.quotaSubjectId;
    f.a.prepare("UPDATE quota_subjects SET kind='subscription' WHERE id=?").run(subject);
    const before=f.count(subject);
    assert.equal((await f.ledgers[0].reserve(req(f.quota,'subject-kind-001'))).status,'revoked');
    assert.deepEqual(f.count(subject),before);
    f.a.prepare("UPDATE quota_subjects SET kind='free-cluster' WHERE id=?").run(subject);
    assert.equal((await f.ledgers[1].reserve(req(f.quota,'subject-kind-002'))).status,'reserved');
  }finally{f.close()}
});
class UnacknowledgedStmt implements D1PreparedStatementLike {
  constructor(private readonly actual:D1PreparedStatementLike){}
  bind(...values:unknown[]):D1PreparedStatementLike {
    return new UnacknowledgedStmt(this.actual.bind(...values));
  }
  async first<T>():Promise<T|null>{return this.actual.first<T>()}
  async all<T>():Promise<D1ResultLike<T>>{return this.actual.all<T>()}
  async run<T>():Promise<D1ResultLike<T>>{
    await this.actual.run<T>(); // backend COMMITTED, ack lost
    return {success:false,meta:{changes:0}};
  }
}
test('committed D1 write with lost acknowledgement never dispatches root for a second time',async()=>{
  const f=await fixture();try{
    const adapter=new Adapter(f.a);
    const uncertain:D1DatabaseLike={
      prepare(sql:string){
        const stmt=adapter.prepare(sql);
        return sql.startsWith('INSERT INTO v2_quota_reservations ')
          ?new UnacknowledgedStmt(stmt):stmt;
      },
      batch:items=>adapter.batch(items),
    };
    const candidate=req(f.quota,'ambiguous-write-0001');
    const ledger=new ProposedV2QuotaD1Ledger(uncertain);
    assert.equal((await ledger.reserve(candidate)).status,'duplicate');
    assert.equal((await f.ledgers[1].reserve(candidate)).status,'duplicate');
    assert.deepEqual(f.count(f.quota.quotaSubjectId),{daily:1,monthly:1,v2:1,minute:1});
  }finally{f.close()}
});
