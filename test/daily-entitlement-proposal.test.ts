import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {MemoryBillingStore} from '../src/product/memory-billing-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {ProposedDailyEntitlementResolver} from '../src/product/daily-entitlement-proposal.js';
import type {BillingSubscriptionRecord,BillingSubscriptionStatus} from '../src/product/billing-store.js';
import type {ProductPlanId} from '../src/product/plans.js';

const now=new Date('2026-10-15T12:00:00.000Z');
async function fixture(){
  const control=new MemoryControlPlaneStore();
  const billing=new MemoryBillingStore();
  const service=new ControlPlaneService(control,{now:()=>now});
  const account=await service.ensureAccount({id:'s2-account'});
  const resolver=(paidEntitlementsEnabled=false)=>
    new ProposedDailyEntitlementResolver({control,billing},
      {paidEntitlementsEnabled,now:()=>now});
  async function plan(id:ProductPlanId,kind:'free-cluster'|'subscription'|'prepaid'=
    id==='free'?'free-cluster':'subscription') {
    await control.putAccount({...account,planId:id});
    const subject=await control.getQuotaSubject(account.quotaSubjectId);
    assert.ok(subject);
    await control.putQuotaSubject({...subject,kind});
  }
  async function sub(options:Partial<BillingSubscriptionRecord>={}){
    const record:BillingSubscriptionRecord={
      provider:'lemonsqueezy',
      providerSubscriptionId:'s2-billing-subscription-id',
      providerCustomerId:'s2-customer',
      accountId:account.id,planId:'plus',
      variantId:'s2-variant',
      status:'active',
      renewsAt:'2026-11-01T00:00:00.000Z',
      endsAt:null,trialEndsAt:null,
      providerUpdatedAt:'2026-10-15T11:00:00.000Z',
      createdAt:'2026-10-01T00:00:00.000Z',
      updatedAt:'2026-10-15T11:00:00.000Z',
      ...options,
    };
    await billing.putSubscription(record);
  }
  return {control,billing,service,account,resolver,plan,sub};
}

test('S2 resolver reads actual account+quota subject, never a self-declared plan',async()=>{
  const f=await fixture();
  const verified=await f.resolver().resolve(f.account.id);
  assert.deepEqual(verified,{
    status:'allowed',tier:'free',
    quotaSubjectId:f.account.quotaSubjectId,
    dailyRequestLimit:1000,
  });
  assert.deepEqual(await f.resolver().resolve('not-existent-account'),{
    status:'denied',reason:'account-not-found',
  });
  assert.deepEqual(await f.resolver().resolve('malformed account id'),{
    status:'denied',reason:'account-not-found',
  });
});

test('S2 paid plan is unavailable by default despite active provider subscription',async()=>{
  const f=await fixture();
  await f.plan('plus');
  await f.sub();
  assert.deepEqual(await f.resolver().resolve(f.account.id),{
    status:'denied',reason:'paid-plans-disabled',
  });
});

test('S2 simulated server-side paid flag still requires matching active provider record',async()=>{
  const f=await fixture();
  await f.plan('plus');
  assert.equal((await f.resolver(true).resolve(f.account.id)).status,'denied');
  await f.sub();
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'allowed',tier:'plus',
    quotaSubjectId:f.account.quotaSubjectId,
    dailyRequestLimit:5000,
  });
  await f.plan('pro');
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'denied',reason:'provider-entitlement-missing',
  });
  await f.sub({planId:'pro'});
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'allowed',tier:'pro',
    quotaSubjectId:f.account.quotaSubjectId,
    dailyRequestLimit:10000,
  });
});

test('S2 paused, past_due, cancelled and unpaid never grant proposed daily paid rights',async()=>{
  const f=await fixture();
  await f.plan('plus');
  for(const status of ['paused','past_due','cancelled','unpaid','expired'] as BillingSubscriptionStatus[]) {
    await f.sub({status});
    const result=await f.resolver(true).resolve(f.account.id);
    assert.deepEqual(result,{status:'denied',reason:'provider-entitlement-missing'});
  }
});

test('S2 trials need valid future end, active subscriptions cannot be expired',async()=>{
  const f=await fixture();
  await f.plan('plus');
  await f.sub({status:'on_trial',trialEndsAt:'2026-10-15T12:01:00.000Z'});
  assert.equal((await f.resolver(true).resolve(f.account.id)).status,'allowed');
  await f.sub({status:'on_trial',trialEndsAt:'2026-10-15T11:00:00.000Z'});
  assert.equal((await f.resolver(true).resolve(f.account.id)).status,'denied');
  await f.sub({status:'active',endsAt:'2026-10-15T11:00:00.000Z'});
  assert.equal((await f.resolver(true).resolve(f.account.id)).status,'denied');
  await f.sub({status:'active',providerUpdatedAt:'2026-10-16T00:00:00.000Z'});
  assert.equal((await f.resolver(true).resolve(f.account.id)).status,'denied');
});

test('S2 subscription cannot belong to another account even if plan and identity are forged',async()=>{
  const f=await fixture();
  await f.plan('plus');
  await f.sub({accountId:'victim-account'});
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'denied',reason:'provider-entitlement-missing',
  });
});

test('S2 free-cluster, subscription, prepaid kinds cannot be silently swapped',async()=>{
  const f=await fixture();
  await f.plan('free','subscription');
  assert.deepEqual(await f.resolver().resolve(f.account.id),{
    status:'denied',reason:'account-subject-mismatch',
  });
  await f.plan('plus','free-cluster');
  await f.sub();
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'denied',reason:'account-subject-mismatch',
  });
  await f.plan('custom','prepaid');
  assert.deepEqual(await f.resolver(true).resolve(f.account.id),{
    status:'denied',reason:'enterprise-contract-required',
  });
});

test('S2 unavailable source of authority cannot silently mint Plus quota',async()=>{
  const f=await fixture();
  await f.plan('plus');
  const broken=new ProposedDailyEntitlementResolver({
    control:f.control,
    billing:{
      listSubscriptions:async()=>{throw new Error('PROVIDER_CONTROLPLANE_UNAVAILABLE')},
    },
  },{paidEntitlementsEnabled:true,now:()=>now});
  await assert.rejects(broken.resolve(f.account.id),/PROVIDER_CONTROLPLANE_UNAVAILABLE/);
});

test('S2 Free entitlement never consults provider, so the proposed fallback is not paid access',async()=>{
  const f=await fixture();
  const r=new ProposedDailyEntitlementResolver({
    control:f.control,
    billing:{listSubscriptions:async()=>{throw new Error('Unexpected provider call')}},
  },{now:()=>now});
  assert.equal((await r.resolve(f.account.id)).status,'allowed');
});
