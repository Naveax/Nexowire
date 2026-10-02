import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_PLANS,
  createCustomPlan,
  planHasFeature,
} from '../src/product/plans.js';
import {
  ZERO_OWNER_SPEND_POLICY,
  authorizeUsageBalance,
  quoteToolUsage,
} from '../src/product/usage-policy.js';

test('free plan has a hard monthly quota and no private-control entitlements', () => {
  assert.equal(PRODUCT_PLANS.free.monthlyCredits, 20_000);
  assert.equal(PRODUCT_PLANS.free.maxDevices, 2);
  assert.equal(
    planHasFeature(PRODUCT_PLANS.free, 'private-pointer'),
    false,
  );
  assert.equal(
    planHasFeature(PRODUCT_PLANS.free, 'private-screen'),
    false,
  );
});

test('paid plans include private control without a separate feature charge', () => {
  for (const plan of [PRODUCT_PLANS.plus, PRODUCT_PLANS.pro]) {
    assert.equal(planHasFeature(plan, 'private-pointer'), true);
    assert.equal(planHasFeature(plan, 'private-keyboard'), true);
    assert.equal(planHasFeature(plan, 'private-screen'), true);
  }
});

test('premium private-control tools consume heavier usage credits', () => {
  assert.deepEqual(
    quoteToolUsage(PRODUCT_PLANS.plus, 'windows_virtual_pointer_move'),
    {
      allowed: true,
      credits: 2,
      multiplier: 2,
      requiredFeature: 'private-pointer',
      denialReason: null,
    },
  );
  assert.equal(
    quoteToolUsage(
      PRODUCT_PLANS.plus,
      'windows_private_keyboard_type',
    ).credits,
    3,
  );
  assert.equal(
    quoteToolUsage(
      PRODUCT_PLANS.plus,
      'windows_private_desktop_start',
    ).credits,
    5,
  );
});

test('free plan fails closed for premium private-control tools', () => {
  const decision = quoteToolUsage(
    PRODUCT_PLANS.free,
    'windows_private_desktop_start',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.credits, 0);
  assert.equal(decision.denialReason, 'feature-not-in-plan');
});

test('normal tools remain one credit unless a later policy overrides them', () => {
  assert.deepEqual(
    quoteToolUsage(PRODUCT_PLANS.free, 'machine_health'),
    {
      allowed: true,
      credits: 1,
      multiplier: 1,
      requiredFeature: null,
      denialReason: null,
    },
  );
});

test('monthly subscriptions hard-stop instead of creating owner-paid overage', () => {
  assert.deepEqual(
    authorizeUsageBalance(
      {
        usedCredits: 99_999,
        requestedCredits: 2,
        monthlyCredits: 100_000,
      },
      'subscription',
    ),
    {
      allowed: false,
      remainingCredits: 1,
      denialReason: 'monthly-quota-exhausted',
    },
  );
});

test('metered custom plans are prepaid and never postpaid', () => {
  const custom = createCustomPlan({
    billingMode: 'prepaid-metered',
    maxDevices: 20,
    features: ['private-pointer', 'private-keyboard', 'private-screen'],
  });

  assert.equal(custom.monthlyCredits, null);
  assert.deepEqual(
    authorizeUsageBalance(
      {
        usedCredits: 0,
        requestedCredits: 5,
        monthlyCredits: null,
        prepaidCredits: 4,
      },
      custom.billingMode,
    ),
    {
      allowed: false,
      remainingCredits: 4,
      denialReason: 'prepaid-balance-exhausted',
    },
  );
});

test('zero-owner-spend policy forbids automatic paid infrastructure', () => {
  assert.equal(ZERO_OWNER_SPEND_POLICY.ownerPaidSpendAllowed, false);
  assert.equal(ZERO_OWNER_SPEND_POLICY.providerAutoUpgradeAllowed, false);
  assert.equal(ZERO_OWNER_SPEND_POLICY.postpaidUsageAllowed, false);
  assert.equal(
    ZERO_OWNER_SPEND_POLICY.hardStopWhenFreeCapacityExhausted,
    true,
  );
});
