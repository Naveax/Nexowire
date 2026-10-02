import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_PLANS,
  createCustomPlan,
} from '../src/product/plans.js';
import { applyUsageCharge } from '../src/product/usage-ledger.js';

const emptyState = () => ({
  usedCredits: 0,
  prepaidCredits: 0,
  chargedEventIds: new Set<string>(),
});

test('usage ledger charges a normal tool once', () => {
  const first = applyUsageCharge(
    PRODUCT_PLANS.free,
    emptyState(),
    {
      eventId: 'call-1',
      toolName: 'machine_health',
    },
  );
  assert.equal(first.allowed, true);
  assert.equal(first.chargedCredits, 1);
  assert.equal(first.nextState.usedCredits, 1);

  const duplicate = applyUsageCharge(
    PRODUCT_PLANS.free,
    first.nextState,
    {
      eventId: 'call-1',
      toolName: 'machine_health',
    },
  );
  assert.equal(duplicate.allowed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.chargedCredits, 0);
  assert.equal(duplicate.nextState.usedCredits, 1);
});

test('free users cannot spend credits on gated private control', () => {
  const result = applyUsageCharge(
    PRODUCT_PLANS.free,
    emptyState(),
    {
      eventId: 'call-2',
      toolName: 'windows_private_desktop_start',
    },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.denialReason, 'feature-not-in-plan');
  assert.equal(result.nextState.usedCredits, 0);
});

test('paid users consume weighted credits for private control', () => {
  const result = applyUsageCharge(
    PRODUCT_PLANS.plus,
    emptyState(),
    {
      eventId: 'call-3',
      toolName: 'windows_private_desktop_start',
    },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.chargedCredits, 5);
  assert.equal(result.nextState.usedCredits, 5);
});

test('prepaid metered usage cannot go negative', () => {
  const custom = createCustomPlan({
    billingMode: 'prepaid-metered',
    features: ['private-screen'],
  });

  const state = {
    usedCredits: 0,
    prepaidCredits: 4,
    chargedEventIds: new Set<string>(),
  };

  const result = applyUsageCharge(custom, state, {
    eventId: 'call-4',
    toolName: 'windows_private_desktop_start',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.denialReason, 'prepaid-balance-exhausted');
  assert.equal(result.nextState.prepaidCredits, 4);
});
