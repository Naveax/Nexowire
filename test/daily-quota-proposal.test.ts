import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSED_DAILY_REQUEST_LIMITS,
  ProposedDailyQuotaSimulator,
  utcQuotaDay,
  proposedDailyLimit,
  type ProposedDailyTier,
} from '../src/product/daily-quota-proposal.js';

const instant=new Date('2026-10-15T23:59:59.900Z');
const next=new Date('2026-10-16T00:00:00.001Z');

test('S2 proposed logical daily limits match requested Free, Plus and Pro targets',()=>{
  assert.deepEqual(PROPOSED_DAILY_REQUEST_LIMITS,{free:1000,plus:5000,pro:10000});
  assert.equal(proposedDailyLimit('enterprise',123456),123456);
  for(const invalid of [undefined,0,-1,Infinity,2.5,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>proposedDailyLimit('enterprise',invalid));
  }
});

test('S2 Free plan permits 1000 distinct logical invocations then rejects 1001st',()=>{
  const ledger=new ProposedDailyQuotaSimulator();
  for(let i=0;i<1000;i++) {
    const r=ledger.reserve({accountKey:'free-owner',invocationId:'free-event-'+i,tier:'free',at:instant});
    assert.equal(r.status,'reserved');
    assert.equal(r.remaining,999-i);
  }
  const rejected=ledger.reserve({accountKey:'free-owner',invocationId:'extra-event-1001',tier:'free',at:instant});
  assert.equal(rejected.status,'denied');
  assert.equal(rejected.denial,'daily-request-limit-exhausted');
  assert.equal(rejected.dayUsed,1000);
});

test('S2 paid plan simulation fails closed without trusted server entitlement',()=>{
  const ledger=new ProposedDailyQuotaSimulator();
  const tiers:[ProposedDailyTier,number][]=[['plus',5000],['pro',10000],['enterprise',20000]];
  for(const [tier,limit] of tiers) {
    const denied=ledger.reserve({
      accountKey:'paid-owner-'+tier,invocationId:'request-unverified',
      tier,enterpriseRequestLimit:limit,at:instant,
    });
    assert.equal(denied.status,'denied');
    assert.equal(denied.denial,'unverified-paid-entitlement');
    const allowed=ledger.reserve({
      accountKey:'paid-owner-'+tier,invocationId:'request-verified',
      tier,enterpriseRequestLimit:limit,at:instant,trustedPaidEntitlement:true,
    });
    assert.equal(allowed.status,'reserved');
    assert.equal(allowed.dailyLimit,limit);
  }
});

test('S2 UTC midnight resets counter but never makes the same ID executable again',()=>{
  const ledger=new ProposedDailyQuotaSimulator();
  const first=ledger.reserve({accountKey:'owner-A',invocationId:'stable-id-001',tier:'free',at:instant});
  assert.equal(first.dayUtc,'2026-10-15');
  const repeat=ledger.reserve({accountKey:'owner-A',invocationId:'stable-id-001',tier:'free',at:next});
  assert.equal(repeat.status,'duplicate');
  assert.equal(repeat.dayUtc,'2026-10-16');
  const newOne=ledger.reserve({accountKey:'owner-A',invocationId:'stable-id-002',tier:'free',at:next});
  assert.equal(newOne.status,'reserved');
  assert.equal(newOne.dayUsed,1);
  const istanbul=new Date('2026-10-16T02:30:00+03:00');
  assert.equal(utcQuotaDay(istanbul),'2026-10-15');
});

test('S2 same invocation ID can exist independently for two account subjects',()=>{
  const ledger=new ProposedDailyQuotaSimulator();
  for(const accountKey of ['owner-1','owner-2']) {
    const r=ledger.reserve({accountKey,invocationId:'shared-id-0001',tier:'free',at:instant});
    assert.equal(r.status,'reserved');
    assert.equal(r.dayUsed,1);
  }
});

test('S2 local concurrent replay and bounded-memory failure do not grant unmetered calls',async()=>{
  const ledger=new ProposedDailyQuotaSimulator(1);
  const inputs=Array.from({length:12},()=>Promise.resolve().then(()=>ledger.reserve({
    accountKey:'owner',invocationId:'same-id-0001',tier:'free',at:instant,
  })));
  const results=await Promise.all(inputs);
  assert.equal(results.filter(x=>x.status==='reserved').length,1);
  assert.equal(results.filter(x=>x.status==='duplicate').length,11);
  const denied=ledger.reserve({accountKey:'owner',invocationId:'different-id-0002',tier:'free',at:instant});
  assert.equal(denied.denial,'simulation-capacity-exhausted');
});

test('S2 input validation rejects malformed account, invocation, clock and arbitrary tier',()=>{
  const ledger=new ProposedDailyQuotaSimulator();
  const base={accountKey:'owner',invocationId:'safe-id-0001',tier:'free' as const,at:instant};
  assert.throws(()=>ledger.reserve({...base,accountKey:''}));
  assert.throws(()=>ledger.reserve({...base,invocationId:'bad key!'}));
  assert.throws(()=>ledger.reserve({...base,at:new Date(NaN)}));
  assert.throws(()=>ledger.reserve({...base,tier:'unlimited' as ProposedDailyTier}));
  assert.throws(()=>new ProposedDailyQuotaSimulator(0));
});
