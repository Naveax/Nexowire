/**
 * Staging evidence: eight independent operating-system processes writing to
 * one disposable WAL DB. This is NOT live Cloudflare D1 Worker-isolate proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, type ChildProcess} from 'node:child_process';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  D1ControlPlaneStore,
  type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import type {QuotaEntitlementDecisionV2} from '../src/product/subscription-entitlements-v2-proposal.js';
type Allowed=Extract<QuotaEntitlementDecisionV2,{status:'allowed'}>;
type Job={invocationId:string;fingerprintSeed?:string;at:string;credits:number};
type Batch={entitlement:Allowed;tasks:Job[]};
class S implements D1PreparedStatementLike{
  constructor(private readonly s:StatementSync,private readonly a:unknown[]=[]){}
  bind(...v:unknown[]):D1PreparedStatementLike{return new S(this.s,v)}
  async first<T>():Promise<T|null>{return (this.s.get(...this.a as Parameters<StatementSync['get']>)??null) as T|null}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.s.all(...this.a as Parameters<StatementSync['all']>) as T[]}}
  async run<T>():Promise<D1ResultLike<T>>{return {success:true,meta:{changes:Number(this.s.run(...this.a as Parameters<StatementSync['run']>).changes)}}}
}
class DB implements D1DatabaseLike{
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new S(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN IMMEDIATE');
    try{const r=[];for(const x of items)r.push(await x.run());this.db.exec('COMMIT');return r}
    catch(e){this.db.exec('ROLLBACK');throw e}
  }
}
const migrations=['0001_control_plane.sql','0002_external_identities.sql',
  '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
  '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
  '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
  '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
  '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql'];
async function sandbox(){
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-v2-process-'));
  const file=path.join(dir,'quota.db');
  const db=new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000');
  for(const f of migrations)db.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',f),'utf8'));
  for(const f of ['scale-v2-daily-requests-staging.sql','scale-v2-dual-quota-staging.sql','scale-v2-tenant-minute-dual-staging.sql'])
    db.exec(readFileSync(path.join(process.cwd(),'test/fixtures',f),'utf8'));
  const service=new ControlPlaneService(new D1ControlPlaneStore(new DB(db)),{
    now:()=>new Date('2026-10-18T10:00:00.000Z'),
  });
  async function account(tier:'free'|'plus'|'pro'|'enterprise',minute:number|null=null){
    const id='v2-process-'+tier;
    const tenant='tenant-'+tier;
    const user=await service.ensureAccount({id});
    const subject=user.quotaSubjectId;
    const plan=tier==='enterprise'?'custom':tier;
    if(tier!=='free'){
      db.prepare('UPDATE accounts SET plan_id=? WHERE id=?').run(plan,id);
      db.prepare('UPDATE quota_subjects SET kind=? WHERE id=?').run('subscription',subject);
    }
    const daily={free:1000,plus:5000,pro:10000,enterprise:850000}[tier];
    const monthly={free:1000,plus:100000,pro:500000,enterprise:850000}[tier];
    db.prepare('INSERT INTO v2_quota_authority(account_id,tenant_id,quota_subject_id,revision,tier,daily_limit,minute_limit,monthly_credits,state) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,tenant,subject,1,tier,daily,minute,monthly,'active');
    return {
      status:'allowed',tier,accountId:id,tenantId:tenant,quotaSubjectId:subject,
      deviceId:null,revision:1,dailyLimit:daily,rollingMinuteLimit:minute,
      monthlyWeightedCredits:monthly,termsHash:tier==='free'?null:'a'.repeat(64),
    } as Allowed;
  }
  const usage=(g:Allowed)=>{
    const get=(sql:string,values:unknown[])=>Number((db.prepare(sql).get(...values as Parameters<StatementSync['get']>) as {n:number}|undefined)?.n??0);
    return {
      day:get('SELECT used_requests AS n FROM daily_request_periods WHERE quota_subject_id=? AND day_key=?',[g.quotaSubjectId,'2026-10-18']),
      month:get('SELECT used_credits AS n FROM quota_usage_periods WHERE quota_subject_id=? AND period_key=?',[g.quotaSubjectId,'2026-10']),
      events:get('SELECT COUNT(*) AS n FROM v2_quota_reservations WHERE quota_subject_id=?',[g.quotaSubjectId]),
      minute:get('SELECT COUNT(*) AS n FROM v2_quota_minute_events WHERE quota_subject_id=?',[g.quotaSubjectId]),
    };
  };
  return {dir,file,db,account,usage,close(){db.close();rmSync(dir,{recursive:true,force:true})}};
}
async function runIndependentProcesses(file:string,batches:Batch[]):Promise<string[][]>{
  const worker=path.join(process.cwd(),'test/fixtures/v2-quota-process-worker.ts');
  const instances:{child:ChildProcess;ready:Promise<void>;result:Promise<string[]>;exited:Promise<void>}[]=[];
  const errors:string[]=[];
  try{
    for(const batch of batches){
      const child=fork(worker,[file],{
        cwd:process.cwd(),
        execArgv:['--import','tsx'],
        stdio:['ignore','ignore','pipe','ipc'],
        windowsHide:true,
      });
      let readyResolve!:()=>void,readyReject!:(e:Error)=>void;
      let resultResolve!:(a:string[])=>void,resultReject!:(e:Error)=>void;
      let exitResolve!:()=>void;
      const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
      const result=new Promise<string[]>((resolve,reject)=>{resultResolve=resolve;resultReject=reject});
      const exited=new Promise<void>(resolve=>{exitResolve=resolve});
      let started=false,done=false;
      child.stderr?.on('data',(data:Buffer)=>errors.push(String(data).slice(0,500)));
      child.on('message',(message:unknown)=>{
        if(typeof message!=='object'||message===null)return;
        const m=message as {kind:string;statuses?:string[];error?:string};
        if(m.kind==='ready'){readyResolve();started=true;}
        if(m.kind==='result'&&m.statuses){done=true;resultResolve(m.statuses)}
        if(m.kind==='error'){done=true;resultReject(new Error(m.error??'worker error'))}
      });
      child.on('error',(e:Error)=>{readyReject(e);resultReject(e)});
      child.on('exit',(code)=>{
        if(!started)readyReject(new Error('worker exited before ready: '+code));
        if(!done)resultReject(new Error('worker exited before result: '+code+' '+errors.join('').slice(0,200)));
        exitResolve();
      });
      instances.push({child,ready,result,exited});
    }
    const timeout=setTimeout(()=>{
      for(const x of instances)if(x.child.exitCode===null)x.child.kill();
    },45000);
    try{
      await Promise.all(instances.map(x=>x.ready));
      // Release all processes simultaneously, independently of their startup time.
      for(let i=0;i<instances.length;i++)instances[i]!.child.send({kind:'go',...batches[i]});
      const results=await Promise.all(instances.map(x=>x.result));
      await Promise.all(instances.map(x=>x.exited));
      return results;
    }finally{clearTimeout(timeout)}
  }finally{
    for(const x of instances)if(x.child.exitCode===null)x.child.kill();
    await Promise.allSettled(instances.map(x=>x.exited));
  }
}
const at='2026-10-18T23:59:59.900Z';
const job=(id:string,credits=1):Job=>({invocationId:id,at,credits});

test('four separate Free/Plus/Pro/Enterprise sandbox accounts have disjoint quota ledgers across OS processes',async()=>{
  const f=await sandbox();try{
    const grants=await Promise.all((['free','plus','pro','enterprise'] as const).map(t=>f.account(t,600)));
    const batches=grants.map(g=>({entitlement:g,tasks:Array.from({length:12},(_,i)=>job('tier-'+g.tier+'-'+String(i).padStart(5,'0'),i%3===0?5:1))}));
    const results=await runIndependentProcesses(f.file,batches);
    for(let i=0;i<grants.length;i++){
      const g=grants[i]!;
      assert.equal(results[i]!.filter(x=>x==='reserved').length,12,g.tier);
      assert.deepEqual(f.usage(g),{day:12,month:28,events:12,minute:12},g.tier);
    }
    assert.equal(new Set(grants.map(g=>g.quotaSubjectId)).size,4);
  }finally{f.close()}
});
test('600 per rolling minute: eight independent competing writer processes admit exactly 600 of 720',async()=>{
  const f=await sandbox();try{
    const grant=await f.account('enterprise',600);
    const batches=Array.from({length:8},(_,workerId)=>({
      entitlement:grant,
      tasks:Array.from({length:90},(_,i)=>job('race-'+workerId+'-'+String(i).padStart(5,'0'))),
    }));
    const results=(await runIndependentProcesses(f.file,batches)).flat();
    assert.equal(results.filter(x=>x==='reserved').length,600);
    assert.equal(results.filter(x=>x==='minute-exhausted').length,120);
    assert.deepEqual(f.usage(grant),{day:600,month:600,events:600,minute:600});
    const last=await runIndependentProcesses(f.file,[{
      entitlement:grant,
      tasks:[{...job('minute-new-after-window'),at:'2026-10-19T00:01:00.001Z'}],
    }]);
    assert.deepEqual(last,[['reserved']]);
    assert.deepEqual(f.usage(grant),{day:600,month:601,events:601,minute:601});
  }finally{f.close()}
});
test('same invocation across independent processes with altered payload admits only one root',async()=>{
  const f=await sandbox();try{
    const free=await f.account('free',600);
    const id='same-process-replay-0001';
    const results=(await runIndependentProcesses(f.file,[
      {entitlement:free,tasks:[job(id)]},
      {entitlement:free,tasks:[{...job(id),fingerprintSeed:'other-payload'}]},
    ])).flat();
    assert.deepEqual(results.slice().sort(),['conflict','reserved']);
    assert.deepEqual(f.usage(free),{day:1,month:1,events:1,minute:1});
    const replay=await runIndependentProcesses(f.file,[{
      entitlement:free,tasks:[{...job(id),fingerprintSeed:'other-payload'}],
    }]);
    assert.ok(['duplicate','conflict'].includes(replay[0]![0]!));
    assert.equal(f.usage(free).events,1);
  }finally{f.close()}
});

test('independent writer cannot debit another owner with a stolen device binding',async()=>{
  const f=await sandbox();try{
    const free=await f.account('free',600);
    const plus=await f.account('plus',600);
    f.db.prepare(
      'INSERT INTO devices(id,owner_account_id,name,platform,credential_hash,online,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)',
    ).run('sandbox-plus-device',plus.accountId,'synthetic plus device','win32',
      'synthetic-hash',at,at);
    const outputs=await runIndependentProcesses(f.file,[
      {entitlement:{...free,deviceId:'sandbox-plus-device'},tasks:[job('stolen-device-bind-0001')]},
      {entitlement:{...plus,deviceId:'sandbox-plus-device'},tasks:[job('valid-plus-device-0002',5)]},
    ]);
    assert.deepEqual(outputs,[['revoked'],['reserved']]);
    assert.deepEqual(f.usage(free),{day:0,month:0,events:0,minute:0});
    assert.deepEqual(f.usage(plus),{day:1,month:5,events:1,minute:1});
  }finally{f.close()}
});
test('revoked paid epoch rejects all stale cross-process reservations and cannot be rolled back',async()=>{
  const f=await sandbox();try{
    const plus=await f.account('plus',600);
    const first=await runIndependentProcesses(f.file,[{
      entitlement:plus,tasks:[job('paid-before-revoke-001')],
    }]);
    assert.deepEqual(first,[['reserved']]);
    f.db.prepare('UPDATE v2_quota_authority SET state=?,revision=? WHERE account_id=?')
      .run('revoked',2,plus.accountId);
    const denied=await runIndependentProcesses(f.file,Array.from({length:4},(_,i)=>({
      entitlement:plus,tasks:[job('paid-after-revoke-'+String(i).padStart(5,'0'))],
    })));
    assert.deepEqual(denied,[['revoked'],['revoked'],['revoked'],['revoked']]);
    assert.throws(()=>f.db.prepare(
      'UPDATE v2_quota_authority SET state=?,revision=? WHERE account_id=?',
    ).run('active',1,plus.accountId),/v2_authority_epoch_regression/);
    const still=await runIndependentProcesses(f.file,[{
      entitlement:plus,tasks:[job('rollback-forgery-001')],
    }]);
    assert.deepEqual(still,[['revoked']]);
    assert.deepEqual(f.usage(plus),{day:1,month:1,events:1,minute:1});
  }finally{f.close()}
});
