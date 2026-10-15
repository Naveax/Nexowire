import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  CUSTOM_USAGE_PROPOSAL,resolveCustomDailyLimit,
  ProposedOwnerHostedCustomUsageMeter,
  type TrustedCustomUsageRequest,
} from '../src/product/custom-usage-owner-meter-proposal.js';

const now=new Date('2026-10-15T14:00:00.000Z');
const dayEnd=new Date('2026-10-15T23:59:59.900Z');
const tomorrow=new Date('2026-10-16T00:00:00.100Z');
const base:TrustedCustomUsageRequest={
  quotaSubjectId:'verified-subject-001',
  transportScope:'tunnel-app-001',
  invocationId:'invocation-001',
  tier:'custom',
  authorizedCustomDailyLimit:850_000,
  entitlementVerified:true,
  now,
};
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(
    path.join(process.cwd(),'test/fixtures/scale-v2-custom-usage-selfhosted-dev.sql'),
    'utf8',
  ));
  const meter=new ProposedOwnerHostedCustomUsageMeter(db);
  const send=(overrides:Partial<TrustedCustomUsageRequest>={})=>
    meter.reserve({...base,...overrides});
  return {db,meter,send,close:()=>db.close()};
}

test('custom plan supports exactly 100 to 850000 logical tools/day',()=>{
  for(const value of [100,101,1000,850000]){
    assert.equal(resolveCustomDailyLimit({tier:'custom',authorizedCustomDailyLimit:value}),value);
  }
  for(const invalid of [undefined,99,850001,0,-1,1.3,NaN,Infinity]){
    assert.throws(()=>resolveCustomDailyLimit({
      tier:'custom',authorizedCustomDailyLimit:invalid,
    }));
  }
  assert.deepEqual(CUSTOM_USAGE_PROPOSAL.standardDaily,{free:1000,plus:5000,pro:10000});
  assert.equal(CUSTOM_USAGE_PROPOSAL.maxTransportRequestsPerRollingMinute,600);
  assert.equal(CUSTOM_USAGE_PROPOSAL.theoreticalTransportDailyMax,864000);
});

test('custom 100 limit is hard, while upgrading limit changes only admission',()=>{
  const f=setup();try{
    for(let i=0;i<100;i++){
      const r=f.send({authorizedCustomDailyLimit:100,invocationId:'custom-100-'+i});
      assert.equal(r.status,'reserved');
      assert.equal(r.remaining,99-i);
    }
    const denied=f.send({authorizedCustomDailyLimit:100,invocationId:'custom-extra-100'});
    assert.equal(denied.status,'daily-exhausted');
    assert.equal(denied.used,100);
    const promoted=f.send({authorizedCustomDailyLimit:850000,invocationId:'upgrade-100-plus'});
    assert.equal(promoted.status,'reserved');
    assert.equal(promoted.used,101);
    const downgraded=f.send({authorizedCustomDailyLimit:100,invocationId:'downgrade-100'});
    assert.equal(downgraded.status,'daily-exhausted');
  }finally{f.close()}
});

test('600 allowed inside a rolling minute, 601st fails, 60s later succeeds',()=>{
  const f=setup();try{
    for(let i=0;i<600;i++){
      const r=f.send({invocationId:'burst-call-'+i});
      assert.equal(r.status,'reserved');
    }
    const denied=f.send({invocationId:'burst-denied-601'});
    assert.equal(denied.status,'transport-rate-exhausted');
    assert.equal(denied.used,600);
    assert.equal(denied.transportRollingMinuteUsed,600);
    const after=f.send({
      invocationId:'burst-at-next-minute',now:new Date(now.getTime()+60000),
    });
    assert.equal(after.status,'reserved');
    assert.equal(after.used,601);
  }finally{f.close()}
});

test('tunnel+application rate is shared across different account subjects',()=>{
  const f=setup();try{
    for(let i=0;i<350;i++){
      assert.equal(f.send({invocationId:'alice-call-'+i}).status,'reserved');
    }
    for(let i=0;i<250;i++){
      assert.equal(f.send({
        quotaSubjectId:'verified-subject-002',invocationId:'bob-call-'+i,
      }).status,'reserved');
    }
    const denied=f.send({
      quotaSubjectId:'verified-subject-003',invocationId:'C-overflow',
    });
    assert.equal(denied.status,'transport-rate-exhausted');
    assert.equal(denied.used,0);
    assert.equal(denied.transportRollingMinuteUsed,600);
  }finally{f.close()}
});

test('separate authenticated calling application scopes have independent buckets',()=>{
  const f=setup();try{
    for(let i=0;i<600;i++){
      assert.equal(f.send({invocationId:'same-scope-'+i}).status,'reserved');
    }
    const independent=f.send({
      transportScope:'second-trusted-tunnel-app',invocationId:'second-scope-event',
    });
    assert.equal(independent.status,'reserved');
    assert.equal(independent.transportRollingMinuteUsed,1);
    assert.equal(f.send({invocationId:'still-full'}).status,'transport-rate-exhausted');
  }finally{f.close()}
});

test('60-second rolling limit cannot be bypassed at UTC minute/day boundary',()=>{
  const f=setup();try{
    for(let i=0;i<600;i++)assert.equal(f.send({
      now:dayEnd,invocationId:'before-midnight-'+i,
    }).status,'reserved');
    const rollover=f.send({
      now:tomorrow,invocationId:'just-after-midnight',
    });
    assert.equal(rollover.status,'transport-rate-exhausted');
    assert.equal(rollover.used,0); // New UTC daily counter still reset.
    const afterWindow=f.send({
      now:new Date(dayEnd.getTime()+60000),
      invocationId:'after-midnight-window',
    });
    assert.equal(afterWindow.status,'reserved');
    assert.equal(afterWindow.used,1);
  }finally{f.close()}
});

test('replay remains forbidden after midnight and after tier changes',()=>{
  const f=setup();try{
    const original=f.send({now:dayEnd,invocationId:'same-invocation-replay'});
    assert.equal(original.status,'reserved');
    const replay=f.send({
      now:tomorrow,tier:'free',authorizedCustomDailyLimit:undefined,
      invocationId:'same-invocation-replay',
    });
    assert.equal(replay.status,'duplicate');
    assert.equal(replay.used,0);
    const newCall=f.send({
      now:tomorrow,tier:'free',authorizedCustomDailyLimit:undefined,
      invocationId:'next-day-new-call',
    });
    assert.equal(newCall.status,'reserved');
    assert.equal(newCall.dailyLimit,1000);
  }finally{f.close()}
});

test('no verified entitlement: no quota consumption and no transport consumption',()=>{
  const f=setup();try{
    const rejected=f.send({entitlementVerified:false});
    assert.equal(rejected.status,'entitlement-not-verified');
    assert.equal(rejected.used,0);
    assert.equal(rejected.transportRollingMinuteUsed,0);
    assert.equal(f.send().status,'reserved');
    assert.equal(f.send().status,'duplicate');
  }finally{f.close()}
});

test('clock rewinds fail closed rather than clearing a transport throttle',()=>{
  const f=setup();try{
    assert.equal(f.send().status,'reserved');
    assert.throws(()=>f.send({
      invocationId:'clock-rollback-new-id',
      now:new Date(now.getTime()-1),
    }),/clock moved backward/);
    assert.equal(f.send({invocationId:'after-rejected-rollback'}).status,'reserved');
  }finally{f.close()}
});

test('850000/day storage counter upper boundary without making 850000 live requests',()=>{
  const f=setup();try{
    assert.equal(f.send({invocationId:'preseed-one'}).status,'reserved');
    f.db.prepare(
      'UPDATE custom_usage_daily SET used=849999 WHERE quota_subject_id=?',
    ).run(base.quotaSubjectId);
    const penultimate=f.send({invocationId:'last-allowed-call'});
    assert.equal(penultimate.status,'reserved');
    assert.equal(penultimate.used,850000);
    assert.equal(penultimate.remaining,0);
    const denied=f.send({invocationId:'now-full'});
    assert.equal(denied.status,'daily-exhausted');
  }finally{f.close()}
});

test('two meter objects over one trusted SQLite DB share the same counters',()=>{
  const f=setup();try{
    const other=new ProposedOwnerHostedCustomUsageMeter(f.db);
    const first=f.send({invocationId:'shared-meter-a',authorizedCustomDailyLimit:100});
    const second=other.reserve({
      ...base,invocationId:'shared-meter-b',authorizedCustomDailyLimit:100,
    });
    assert.equal(first.used,1);
    assert.equal(second.used,2);
    assert.equal(f.send({
      invocationId:'shared-meter-b',authorizedCustomDailyLimit:100,
    }).status,'duplicate');
  }finally{f.close()}
});

test('invalid trusted identifiers, tiers and extra allocations fail closed',()=>{
  const f=setup();try{
    for(const patch of [
      {quotaSubjectId:'bad subject!'},
      {transportScope:''},
      {invocationId:'bad/id'},
      {tier:'unlimited' as 'custom'},
      {tier:'free' as const,authorizedCustomDailyLimit:850000},
      {now:new Date(NaN)},
    ]) assert.throws(()=>f.send(patch));
    assert.equal(f.send({invocationId:'safe-after-rejections'}).status,'reserved');
  }finally{f.close()}
});

test('missing schema and invalid provider state never grant an execution',()=>{
  const bad=new DatabaseSync(':memory:');
  try{
    const g=new ProposedOwnerHostedCustomUsageMeter(bad);
    assert.throws(()=>g.reserve(base),/no such table/);
  }finally{bad.close()}
});
