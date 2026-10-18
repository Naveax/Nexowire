import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billableInvocationV2, evaluateQuotaEntitlementV2,
  type QuotaEntitlementSnapshotV2, type SubscriptionStateV2,
} from '../src/product/subscription-entitlements-v2-proposal.js';

const now=new Date('2026-10-18T16:00:00.000Z');
const sha='a'.repeat(64);
function paid():QuotaEntitlementSnapshotV2{
  return {
    identity:{
      accountId:'account-alpha',tenantId:'tenant-alpha',
      quotaSubjectId:'quota-alpha-123',quotaSubjectKind:'subscription',accountSubjectId:'quota-alpha-123',
      tenantSubjectId:'quota-alpha-123',deviceId:'device-alpha',
      deviceOwnerAccountId:'account-alpha',membership:'member',
      membershipActive:true,
    },
    contract:{
      id:'contract-alpha',revision:1,tier:'plus',
      accountId:'account-alpha',tenantId:'tenant-alpha',
      quotaSubjectId:'quota-alpha-123',
      effectiveAt:'2026-10-01T00:00:00.000Z',expiresAt:null,
      expectedProviderSubscriptionId:'sub-alpha',expectedProviderVariantId:'variant-plus-alpha',
      monthlyWeightedCredits:100000,
      disclosure:{
        termsHash:sha,termsVersion:'v2-20261018',
        acceptedAccountId:'account-alpha',acceptedAt:'2026-10-02T00:00:00.000Z',
        revokedAt:null,
      },
    },
    payment:{
      provider:'lemonsqueezy',accountId:'account-alpha',
      providerSubscriptionId:'sub-alpha',providerVariantId:'variant-plus-alpha',providerStatus:'active',
      paymentConfirmed:true,providerUpdatedAt:'2026-10-17T00:00:00.000Z',
      endsAt:null,trialEndsAt:null,
    },
    state:'ACTIVE',candidateEntitlementsEnabled:true,
    productionBillingEnabled:false,
  };
}
function reason(s:QuotaEntitlementSnapshotV2){
  const result=evaluateQuotaEntitlementV2(s,now);
  return result.status==='denied'?result.reason:null;
}
test('dormant Free candidate has no payment and retains a separate finite monthly cap',()=>{
  const f=paid();f.contract.tier='free';f.contract.monthlyWeightedCredits=1000;
  f.identity.quotaSubjectKind='free-cluster';
  f.contract.expectedProviderSubscriptionId=null;
  f.contract.expectedProviderVariantId=null;
  f.payment=null;f.state=null;f.candidateEntitlementsEnabled=false;
  f.contract.disclosure=null;
  const result=evaluateQuotaEntitlementV2(f,now);
  assert.equal(result.status,'allowed');
  if(result.status==='allowed'){
    assert.equal(result.dailyLimit,1000);
    assert.equal(result.monthlyWeightedCredits,1000);
    assert.equal(result.rollingMinuteLimit,null);
  }
  f.contract.monthlyWeightedCredits=5000;assert.equal(reason(f),'invalid-authority');
  f.contract.monthlyWeightedCredits=1000;
  f.payment=paid().payment;assert.equal(reason(f),'invalid-authority');
});
test('Plus and Pro proposals are locked until server evidence, consent and explicit staging gate',()=>{
  const f=paid();
  f.candidateEntitlementsEnabled=false;
  assert.equal(reason(f),'paid-plans-disabled');
  f.candidateEntitlementsEnabled=true;
  f.payment!.paymentConfirmed=false;
  assert.equal(reason(f),'payment-not-confirmed');
  f.payment!.paymentConfirmed=true;
  const plus=evaluateQuotaEntitlementV2(f,now);
  assert.equal(plus.status,'allowed');
  if(plus.status==='allowed')assert.equal(plus.dailyLimit,5000);
  f.contract.tier='pro';
  const pro=evaluateQuotaEntitlementV2(f,now);
  assert.equal(pro.status,'allowed');
  if(pro.status==='allowed')assert.equal(pro.dailyLimit,10000);
  f.contract.customDailyLimit=20000;
  assert.equal(reason(f),'enterprise-contract-invalid');
});
test('PAST_DUE, PAUSED, CANCELED, CHARGEBACK, REFUNDED and revoked subscription fail closed',()=>{
  for(const state of [
    'PAST_DUE','PAUSED','UNPAID','CANCELED','EXPIRED','CHARGEBACK','REFUNDED','TRIALING',
  ] as SubscriptionStateV2[]){
    const f=paid();f.state=state;
    assert.equal(reason(f),'subscription-not-active',state);
  }
  const f=paid();f.payment!.providerStatus='past_due';
  assert.equal(reason(f),'provider-state-invalid');
  f.payment!.providerStatus='active';
  f.payment!.providerUpdatedAt='2026-10-19T00:00:00.000Z';
  assert.equal(reason(f),'provider-state-invalid');
  f.payment!.providerUpdatedAt='2026-10-17T00:00:00.000Z';
  f.payment!.endsAt='2026-10-18T15:59:59.000Z';
  assert.equal(reason(f),'provider-state-invalid');
});
test('different account, tenant, quota subject or device cannot borrow paid capacity',()=>{
  const f=paid();
  f.identity.tenantId='tenant-other';
  assert.equal(reason(f),'scope-mismatch');
  f.identity.tenantId='tenant-alpha';
  f.identity.accountSubjectId='quota-other';
  assert.equal(reason(f),'scope-mismatch');
  f.identity.accountSubjectId='quota-alpha-123';
  f.identity.deviceOwnerAccountId='account-other';
  assert.equal(reason(f),'device-owner-mismatch');
  f.identity.deviceOwnerAccountId='account-alpha';
  f.payment!.accountId='account-other';
  assert.equal(reason(f),'payment-not-confirmed');
});
test('enterprise needs member grant and bounded owner-issued daily and rolling-minute budgets',()=>{
  const f=paid();
  f.contract.tier='enterprise';f.contract.customDailyLimit=850000;
  f.contract.customRollingMinuteLimit=600;
  f.identity.membershipActive=false;
  assert.equal(reason(f),'tenant-membership-required');
  f.identity.membershipActive=true;
  const ok=evaluateQuotaEntitlementV2(f,now);
  assert.equal(ok.status,'allowed');
  if(ok.status==='allowed'){
    assert.equal(ok.dailyLimit,850000);
    assert.equal(ok.rollingMinuteLimit,600);
  }
  f.contract.customDailyLimit=850001;
  assert.equal(reason(f),'enterprise-contract-invalid');
  f.contract.customDailyLimit=850000;
  f.contract.customRollingMinuteLimit=601;
  assert.equal(reason(f),'enterprise-contract-invalid');
  f.contract.customRollingMinuteLimit=0;
  assert.equal(reason(f),'enterprise-contract-invalid');
});
test('acceptance snapshots, end dates and revision are mandatory; revoked consent denies',()=>{
  const f=paid();f.contract.disclosure!.revokedAt='2026-10-17T00:00:00.000Z';
  assert.equal(reason(f),'disclosure-not-accepted');
  f.contract.disclosure!.revokedAt=null;
  f.contract.disclosure!.acceptedAccountId='account-other';
  assert.equal(reason(f),'disclosure-not-accepted');
  f.contract.disclosure!.acceptedAccountId='account-alpha';
  f.contract.disclosure!.termsHash='not-a-hash';
  assert.equal(reason(f),'disclosure-not-accepted');
  f.contract.disclosure!.termsHash=sha;
  f.contract.expiresAt='2026-10-18T15:00:00.000Z';
  assert.equal(reason(f),'contract-expired');
  f.contract.expiresAt=null;f.contract.revision=0;
  assert.equal(reason(f),'invalid-authority');
});
test('one hosted root is billable, nested tasks, network retries, local work and relay are not',()=>{
  assert.deepEqual(billableInvocationV2({kind:'hosted-root',invocationId:'root-action-123'}),
    {billable:true,invocationId:'root-action-123'});
  for(const item of [
    {kind:'hosted-child',rootInvocationId:'root-action-123',childId:'child-a'},
    {kind:'retry',rootInvocationId:'root-action-123'},
    {kind:'local-operation',operationId:'local-test-01'},
    {kind:'transport-request',requestId:'http-retry'},
    {kind:'relay-byte-stream',streamId:'stream-01'},
  ] as const)assert.equal(billableInvocationV2(item).billable,false);
  assert.throws(()=>billableInvocationV2({kind:'hosted-root',invocationId:'bad'}),/INVOCATION_ID_INVALID/);
});

test('subscription and plan catalog variant must match the specific trusted contract',()=>{
  const f=paid();
  f.payment!.providerVariantId='variant-pro-stolen';
  assert.equal(reason(f),'provider-plan-mismatch');
  f.payment!.providerVariantId='variant-plus-alpha';
  f.contract.expectedProviderSubscriptionId='subscription-for-other-owner';
  assert.equal(reason(f),'provider-plan-mismatch');
  f.contract.expectedProviderSubscriptionId='sub-alpha';
  f.contract.expectedProviderVariantId=null;
  assert.equal(reason(f),'provider-plan-mismatch');
});
test('account plan and persisted quota subject type must agree before any paid/free grant',()=>{
  const f=paid();
  f.identity.quotaSubjectKind='free-cluster';
  assert.equal(reason(f),'subject-kind-mismatch');
  f.identity.quotaSubjectKind='subscription';
  f.contract.tier='free';
  f.contract.monthlyWeightedCredits=1000;
  f.contract.expectedProviderSubscriptionId=null;
  f.contract.expectedProviderVariantId=null;
  f.payment=null;
  f.state=null;
  assert.equal(reason(f),'subject-kind-mismatch');
  f.identity.quotaSubjectKind='prepaid';
  assert.equal(reason(f),'subject-kind-mismatch');
});
