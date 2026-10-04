import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { MemoryBillingStore } from '../src/product/memory-billing-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { BillingService } from '../src/product/billing-service.js';
import { LemonSqueezyBillingProvider } from '../src/product/lemon-squeezy-billing.js';

const secret = 'billing-webhook-secret-0123456789';
let clock = new Date('2026-10-04T12:00:00.000Z');

function sign(body: unknown): {
  raw: string;
  signature: string;
} {
  const raw = JSON.stringify(body);
  return {
    raw,
    signature: createHmac('sha256', secret)
      .update(raw, 'utf8')
      .digest('hex'),
  };
}

function subscriptionEvent(input: {
  event?: string;
  accountId?: string;
  subscriptionId?: string;
  customerId?: string;
  variantId?: number;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  renewsAt?: string | null;
  endsAt?: string | null;
}) {
  return sign({
    meta: {
      event_name: input.event ?? 'subscription_updated',
      custom_data: input.accountId
        ? { account_id: input.accountId }
        : {},
    },
    data: {
      type: 'subscriptions',
      id: input.subscriptionId ?? '7001',
      attributes: {
        customer_id: Number(input.customerId ?? '8001'),
        variant_id: input.variantId ?? 2001,
        status: input.status ?? 'active',
        renews_at:
          input.renewsAt === undefined
            ? '2026-11-01T12:00:00Z'
            : input.renewsAt,
        ends_at: input.endsAt ?? null,
        trial_ends_at: null,
        created_at:
          input.createdAt ?? '2026-10-01T12:00:00Z',
        updated_at:
          input.updatedAt ?? '2026-10-04T12:00:00Z',
      },
    },
  });
}

async function setup() {
  clock = new Date('2026-10-04T12:00:00.000Z');
  const controlStore = new MemoryControlPlaneStore();
  const billingStore = new MemoryBillingStore();
  const control = new ControlPlaneService(controlStore, {
    now: () => clock,
  });
  const account = await control.ensureAccount({
    id: 'acct_test',
  });

  const pairing = await control.beginPairing(
    { accountId: account.id, role: 'user' },
    'work-pc',
    '11111111-1111-4111-8111-111111111111',
  );
  await control.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: 'a'.repeat(64),
  });

  const provider = new LemonSqueezyBillingProvider(
    {
      apiKey: 'api-key-0123456789',
      webhookSecret: secret,
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
    },
    async () => {
      throw new Error('unexpected provider network request');
    },
  );
  const billing = new BillingService(
    controlStore,
    billingStore,
    provider,
    { now: () => clock },
  );

  return {
    controlStore,
    billingStore,
    control,
    account,
    billing,
  };
}

test('billing webhook upgrades Free to Plus, is idempotent, then upgrades to Pro', async () => {
  const { controlStore, account, billing } = await setup();
  const freeQuota = account.quotaSubjectId;

  const plus = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    variantId: 2001,
    updatedAt: '2026-10-04T12:00:00Z',
  });
  const first = await billing.handleWebhook(
    plus.raw,
    plus.signature,
  );
  assert.equal(first.status, 'processed');
  assert.equal(first.planId, 'plus');

  const plusAccount = await controlStore.getAccount(account.id);
  assert.equal(plusAccount?.planId, 'plus');
  assert.notEqual(plusAccount?.quotaSubjectId, freeQuota);
  assert.equal(
    (
      await controlStore.getQuotaSubject(
        plusAccount!.quotaSubjectId,
      )
    )?.kind,
    'subscription',
  );

  const duplicate = await billing.handleWebhook(
    plus.raw,
    plus.signature,
  );
  assert.equal(duplicate.status, 'duplicate');

  const pro = subscriptionEvent({
    accountId: account.id,
    variantId: 2002,
    updatedAt: '2026-10-04T12:05:00Z',
  });
  const upgraded = await billing.handleWebhook(
    pro.raw,
    pro.signature,
  );
  assert.equal(upgraded.planId, 'pro');
  assert.equal(
    (await controlStore.getAccount(account.id))?.planId,
    'pro',
  );
});

test('stale subscription webhook cannot downgrade newer entitlement', async () => {
  const { controlStore, account, billing } = await setup();

  const pro = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    variantId: 2002,
    updatedAt: '2026-10-04T12:10:00Z',
  });
  await billing.handleWebhook(pro.raw, pro.signature);

  const stale = subscriptionEvent({
    accountId: account.id,
    variantId: 2001,
    updatedAt: '2026-10-04T12:09:00Z',
  });
  const result = await billing.handleWebhook(
    stale.raw,
    stale.signature,
  );
  assert.equal(result.status, 'stale');
  assert.equal(
    (await controlStore.getAccount(account.id))?.planId,
    'pro',
  );
});

test('cancelled subscription keeps grace access, expired returns to original Free quota cluster', async () => {
  const { controlStore, account, billing } = await setup();
  const freeQuota = account.quotaSubjectId;

  const active = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    updatedAt: '2026-10-04T12:00:00Z',
  });
  await billing.handleWebhook(active.raw, active.signature);

  const cancelled = subscriptionEvent({
    event: 'subscription_cancelled',
    accountId: account.id,
    status: 'cancelled',
    updatedAt: '2026-10-04T12:10:00Z',
    renewsAt: null,
    endsAt: '2026-10-10T12:00:00Z',
  });
  await billing.handleWebhook(
    cancelled.raw,
    cancelled.signature,
  );
  assert.equal(
    (await controlStore.getAccount(account.id))?.planId,
    'plus',
  );

  clock = new Date('2026-10-10T12:01:00.000Z');
  const expired = subscriptionEvent({
    event: 'subscription_expired',
    accountId: account.id,
    status: 'expired',
    updatedAt: '2026-10-10T12:01:00Z',
    renewsAt: null,
    endsAt: '2026-10-10T12:00:00Z',
  });
  await billing.handleWebhook(expired.raw, expired.signature);

  const downgraded = await controlStore.getAccount(account.id);
  assert.equal(downgraded?.planId, 'free');
  assert.equal(downgraded?.quotaSubjectId, freeQuota);
});

test('custom plan cannot be overwritten by subscription webhook', async () => {
  const { controlStore, account, billing } = await setup();
  await controlStore.putAccount({
    ...account,
    planId: 'custom',
    customPlan: {
      billingMode: 'prepaid-metered',
      monthlyCredits: null,
      maxDevices: 25,
      maxConcurrentTasks: 10,
      features: ['automation'],
    },
    updatedAt: clock.toISOString(),
  });

  const plus = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    updatedAt: '2026-10-04T12:05:00Z',
  });
  const result = await billing.handleWebhook(
    plus.raw,
    plus.signature,
  );
  assert.equal(result.planId, 'custom');
  assert.equal(
    (await controlStore.getAccount(account.id))?.planId,
    'custom',
  );
});

test('checkout is blocked when account already has an entitled subscription', async () => {
  const { account, billing } = await setup();

  const active = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
  });
  await billing.handleWebhook(active.raw, active.signature);

  await assert.rejects(
    billing.createCheckout(
      { accountId: account.id, role: 'user' },
      'pro',
      'https://nexowire.example/?billing=success',
    ),
    /BILLING_PORTAL_REQUIRED/,
  );
});


test('highest active entitlement wins across multiple subscriptions', async () => {
  const { account, billing } = await setup();

  const pro = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    subscriptionId: '7001',
    variantId: 2002,
    updatedAt: '2026-10-04T12:00:00Z',
  });
  await billing.handleWebhook(pro.raw, pro.signature);

  const newerPlus = subscriptionEvent({
    event: 'subscription_created',
    accountId: account.id,
    subscriptionId: '7002',
    customerId: '8002',
    variantId: 2001,
    updatedAt: '2026-10-04T12:05:00Z',
  });
  await billing.handleWebhook(
    newerPlus.raw,
    newerPlus.signature,
  );

  const status = await billing.status({
    accountId: account.id,
    role: 'user',
  });
  assert.equal(status.planId, 'pro');
  assert.equal(status.subscription?.id, '7001');
  assert.equal(status.subscription?.planId, 'pro');
});
