import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { MemoryBillingStore } from '../src/product/memory-billing-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { BillingService } from '../src/product/billing-service.js';
import {
  LemonSqueezyBillingProvider,
} from '../src/product/lemon-squeezy-billing.js';
import { createBillingHttpHandler } from '../src/product/billing-http.js';

const secret = 'prepaid-webhook-secret-0123456789';
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

function prepaidOrder(input: {
  accountId: string;
  orderId?: string;
  variantId?: number;
  updatedAt?: string;
  purchaseKind?: string;
}) {
  return sign({
    meta: {
      event_name: 'order_created',
      custom_data: {
        account_id: input.accountId,
        ...(input.purchaseKind === undefined
          ? { purchase_kind: 'prepaid_credits' }
          : input.purchaseKind
            ? { purchase_kind: input.purchaseKind }
            : {}),
      },
    },
    data: {
      type: 'orders',
      id: input.orderId ?? '9001',
      attributes: {
        customer_id: 8001,
        status: 'paid',
        total: 1000,
        refunded_amount: 0,
        first_order_item: {
          variant_id: input.variantId ?? 3001,
        },
        created_at: '2026-10-04T11:59:00Z',
        updated_at:
          input.updatedAt ?? '2026-10-04T12:00:00Z',
      },
    },
  });
}

function refundOrder(input: {
  orderId?: string;
  variantId?: number;
  refundedAmount: number;
  updatedAt?: string;
  purchaseKind?: string;
}) {
  return sign({
    meta: {
      event_name: 'order_refunded',
      custom_data: {
        ...(input.purchaseKind === undefined
          ? { purchase_kind: 'prepaid_credits' }
          : input.purchaseKind
            ? { purchase_kind: input.purchaseKind }
            : {}),
      },
    },
    data: {
      type: 'orders',
      id: input.orderId ?? '9001',
      attributes: {
        customer_id: 8001,
        status: 'paid',
        total: 1000,
        refunded_amount: input.refundedAmount,
        first_order_item: {
          variant_id: input.variantId ?? 3001,
        },
        created_at: '2026-10-04T11:59:00Z',
        updated_at:
          input.updatedAt ?? '2026-10-04T12:30:00Z',
      },
    },
  });
}

function provider(
  fetchImpl: typeof fetch = async () => {
    throw new Error('unexpected provider network request');
  },
): LemonSqueezyBillingProvider {
  return new LemonSqueezyBillingProvider(
    {
      apiKey: 'api-key-0123456789',
      webhookSecret: secret,
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
      prepaidPacks: [
        {
          variantId: '3001',
          credits: 100_000,
          label: '100k kredi',
        },
        {
          variantId: '3002',
          credits: 500_000,
          label: '500k kredi',
        },
      ],
    },
    fetchImpl,
  );
}

async function customSetup() {
  clock = new Date('2026-10-04T12:00:00.000Z');
  const controlStore = new MemoryControlPlaneStore();
  const billingStore = new MemoryBillingStore();
  const control = new ControlPlaneService(controlStore, {
    now: () => clock,
  });
  await control.ensureAccount({
    id: 'owner',
    admin: true,
  });
  const account = await control.ensureAccount({
    id: 'acct_prepaid',
  });
  const configured =
    await control.configureCustomPrepaidPlan(
      { accountId: 'owner', role: 'admin' },
      account.id,
      {
        maxDevices: 25,
        maxConcurrentTasks: 10,
        features: [
          'private-pointer',
          'private-keyboard',
          'private-screen',
          'automation',
        ],
      },
    );
  const billing = new BillingService(
    controlStore,
    billingStore,
    provider(),
    { now: () => clock },
  );
  return {
    controlStore,
    billingStore,
    control,
    account: configured,
    billing,
  };
}

test('memory prepaid balance carries across periods and duplicate credit events do not mint twice', async () => {
  const store = new MemoryControlPlaneStore();
  await store.putQuotaSubject({
    id: 'quota_prepaid',
    kind: 'prepaid',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  const credited = await store.addPrepaidCreditsAtomic({
    quotaSubjectId: 'quota_prepaid',
    eventId: 'order-1',
    credits: 10,
    creditedAt: '2026-10-04T12:00:00.000Z',
  });
  assert.equal(credited.status, 'credited');
  assert.equal(credited.prepaidCredits, 10);

  const duplicate = await store.addPrepaidCreditsAtomic({
    quotaSubjectId: 'quota_prepaid',
    eventId: 'order-1',
    credits: 10,
    creditedAt: '2026-10-04T12:00:01.000Z',
  });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.prepaidCredits, 10);

  const october = await store.chargeUsageAtomic({
    quotaSubjectId: 'quota_prepaid',
    periodKey: '2026-10',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    eventId: 'oct',
    credits: 3,
    billingMode: 'prepaid-metered',
    monthlyCredits: null,
    chargedAt: '2026-10-31T23:59:00.000Z',
  });
  assert.equal(october.status, 'charged');
  assert.equal(october.record.prepaidCredits, 7);

  const november = await store.chargeUsageAtomic({
    quotaSubjectId: 'quota_prepaid',
    periodKey: '2026-11',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
    eventId: 'nov',
    credits: 2,
    billingMode: 'prepaid-metered',
    monthlyCredits: null,
    chargedAt: '2026-11-01T00:01:00.000Z',
  });
  assert.equal(november.status, 'charged');
  assert.equal(november.record.prepaidCredits, 5);
  assert.equal(
    await store.getPrepaidCreditsBalance('quota_prepaid'),
    5,
  );
});

test('only a real admin can provision a bounded Custom prepaid plan', async () => {
  const store = new MemoryControlPlaneStore();
  const control = new ControlPlaneService(store, {
    now: () =>
      new Date('2026-10-04T12:00:00.000Z'),
  });
  await control.ensureAccount({ id: 'owner', admin: true });
  await control.ensureAccount({ id: 'user' });
  await control.ensureAccount({ id: 'target' });

  await assert.rejects(
    control.configureCustomPrepaidPlan(
      { accountId: 'user', role: 'admin' },
      'target',
      {},
    ),
    /ADMIN_REQUIRED/,
  );

  const configured =
    await control.configureCustomPrepaidPlan(
      { accountId: 'owner', role: 'admin' },
      'target',
      {
        maxDevices: 12,
        maxConcurrentTasks: 4,
        features: ['automation', 'private-screen'],
      },
    );

  assert.equal(configured.planId, 'custom');
  assert.equal(
    configured.customPlan?.billingMode,
    'prepaid-metered',
  );
  assert.equal(configured.customPlan?.monthlyCredits, null);
  assert.equal(configured.customPlan?.maxDevices, 12);
  assert.deepEqual(
    configured.customPlan?.features,
    ['automation', 'private-screen'],
  );
  assert.equal(
    (
      await store.getQuotaSubject(
        configured.quotaSubjectId,
      )
    )?.kind,
    'prepaid',
  );

  const dashboard = await control.dashboard({
    accountId: 'target',
    role: 'user',
  });
  assert.equal(dashboard.usage.prepaidCredits, 0);
});

test('Lemon Squeezy prepaid checkout and signed order webhook use server-side pack mapping', async () => {
  let requestBody: any;
  const billingProvider = provider(async (input, init) => {
    assert.equal(
      String(input),
      'https://api.lemonsqueezy.com/v1/checkouts',
    );
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      data: {
        attributes: {
          url: 'https://example.lemonsqueezy.com/checkout/prepaid',
        },
      },
    });
  });

  const url = await billingProvider.createPrepaidCheckout({
    accountId: 'acct_prepaid',
    variantId: '3001',
    redirectUrl:
      'https://nexowire.example/?billing=prepaid-success',
  });
  assert.equal(
    url,
    'https://example.lemonsqueezy.com/checkout/prepaid',
  );
  assert.equal(
    requestBody.data.relationships.variant.data.id,
    '3001',
  );
  assert.deepEqual(
    requestBody.data.attributes.checkout_data.custom,
    {
      account_id: 'acct_prepaid',
      purchase_kind: 'prepaid_credits',
    },
  );

  const event = prepaidOrder({
    accountId: 'acct_prepaid',
  });
  const parsed = billingProvider.parseWebhook(
    event.raw,
    event.signature,
  );
  assert.equal(parsed.kind, 'prepaid-order');
  if (parsed.kind !== 'prepaid-order') {
    throw new Error('expected prepaid order');
  }
  assert.equal(parsed.providerOrderId, '9001');
  assert.equal(parsed.variantId, '3001');
  assert.equal(parsed.credits, 100_000);
  assert.equal(parsed.totalAmount, 1000);

  const subscriptionOrder = prepaidOrder({
    accountId: 'acct_prepaid',
    purchaseKind: '',
  });
  const ignored = billingProvider.parseWebhook(
    subscriptionOrder.raw,
    subscriptionOrder.signature,
  );
  assert.equal(ignored.kind, 'ignored');
});

test('prepaid order credits once even when the same provider order is delivered with a different webhook hash', async () => {
  const {
    controlStore,
    account,
    billing,
  } = await customSetup();

  const first = prepaidOrder({
    accountId: account.id,
    orderId: '9001',
    updatedAt: '2026-10-04T12:00:00Z',
  });
  const processed = await billing.handleWebhook(
    first.raw,
    first.signature,
  );
  assert.equal(processed.status, 'processed');
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    100_000,
  );

  const redelivery = prepaidOrder({
    accountId: account.id,
    orderId: '9001',
    updatedAt: '2026-10-04T12:00:01Z',
  });
  const duplicate = await billing.handleWebhook(
    redelivery.raw,
    redelivery.signature,
  );
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    100_000,
  );

  const status = await billing.status({
    accountId: account.id,
    role: 'user',
  });
  assert.equal(status.planId, 'custom');
  assert.equal(status.prepaid?.balance, 100_000);
  assert.deepEqual(
    status.prepaid?.packs.map((pack) => pack.variantId),
    ['3001', '3002'],
  );

  const unknown = prepaidOrder({
    accountId: account.id,
    orderId: '9002',
    variantId: 3999,
  });
  await assert.rejects(
    billing.handleWebhook(
      unknown.raw,
      unknown.signature,
    ),
    /BILLING_VARIANT_UNKNOWN/,
  );
});

test('partial refund creates debt for already-spent credits and future top-up repays debt first', async () => {
  const {
    controlStore,
    account,
    billing,
  } = await customSetup();

  const purchase = prepaidOrder({
    accountId: account.id,
    orderId: '9001',
  });
  await billing.handleWebhook(
    purchase.raw,
    purchase.signature,
  );

  const spent = await controlStore.chargeUsageAtomic({
    quotaSubjectId: account.quotaSubjectId,
    periodKey: '2026-10',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    eventId: 'spend-before-refund',
    credits: 80_000,
    billingMode: 'prepaid-metered',
    monthlyCredits: null,
    chargedAt: '2026-10-04T12:10:00.000Z',
  });
  assert.equal(spent.status, 'charged');
  assert.equal(spent.record.prepaidCredits, 20_000);

  const halfRefund = refundOrder({
    orderId: '9001',
    refundedAmount: 500,
  });
  const refunded = await billing.handleWebhook(
    halfRefund.raw,
    halfRefund.signature,
  );
  assert.equal(refunded.status, 'processed');
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    0,
  );
  assert.equal(
    await controlStore.getPrepaidRefundDebt(
      account.quotaSubjectId,
    ),
    30_000,
  );

  const blocked = await controlStore.chargeUsageAtomic({
    quotaSubjectId: account.quotaSubjectId,
    periodKey: '2026-10',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    eventId: 'blocked-by-refund-debt',
    credits: 1,
    billingMode: 'prepaid-metered',
    monthlyCredits: null,
    chargedAt: '2026-10-04T12:31:00.000Z',
  });
  assert.equal(blocked.status, 'quota-exhausted');

  const secondPurchase = prepaidOrder({
    accountId: account.id,
    orderId: '9002',
    updatedAt: '2026-10-04T12:40:00Z',
  });
  await billing.handleWebhook(
    secondPurchase.raw,
    secondPurchase.signature,
  );
  assert.equal(
    await controlStore.getPrepaidRefundDebt(
      account.quotaSubjectId,
    ),
    0,
  );
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    70_000,
  );

  const fullRefund = refundOrder({
    orderId: '9001',
    refundedAmount: 1000,
    updatedAt: '2026-10-04T12:50:00Z',
  });
  await billing.handleWebhook(
    fullRefund.raw,
    fullRefund.signature,
  );
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    20_000,
  );
  assert.equal(
    await controlStore.getPrepaidRefundDebt(
      account.quotaSubjectId,
    ),
    0,
  );

  const status = await billing.status({
    accountId: account.id,
    role: 'user',
  });
  assert.equal(status.prepaid?.balance, 20_000);
  assert.equal(status.prepaid?.refundDebt, 0);
});

test('same provider order cannot mint credits into a different account', async () => {
  const {
    controlStore,
    control,
    account,
    billing,
  } = await customSetup();

  const first = prepaidOrder({
    accountId: account.id,
    orderId: '9001',
  });
  await billing.handleWebhook(first.raw, first.signature);

  const other = await control.ensureAccount({
    id: 'acct_prepaid_other',
  });
  const configuredOther =
    await control.configureCustomPrepaidPlan(
      { accountId: 'owner', role: 'admin' },
      other.id,
      {
        maxDevices: 5,
        maxConcurrentTasks: 2,
        features: ['automation'],
      },
    );

  const replayToOther = prepaidOrder({
    accountId: configuredOther.id,
    orderId: '9001',
    updatedAt: '2026-10-04T12:01:00Z',
  });
  await assert.rejects(
    billing.handleWebhook(
      replayToOther.raw,
      replayToOther.signature,
    ),
    /BILLING_PURCHASE_MISMATCH/,
  );
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      configuredOther.quotaSubjectId,
    ),
    0,
  );
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    100_000,
  );
});

test('signed refund payload cannot exceed the original order total', () => {
  const billingProvider = provider();
  const event = refundOrder({
    orderId: '9001',
    refundedAmount: 1001,
  });
  assert.throws(
    () =>
      billingProvider.parseWebhook(
        event.raw,
        event.signature,
      ),
    /BILLING_WEBHOOK_INVALID_REFUND_AMOUNT/,
  );
});

test('prepaid refund before its purchase record remains retryable instead of being acknowledged', async () => {
  const { billing } = await customSetup();
  const event = refundOrder({
    orderId: '9999',
    refundedAmount: 1000,
  });
  await assert.rejects(
    billing.handleWebhook(
      event.raw,
      event.signature,
    ),
    /BILLING_PREPAID_PURCHASE_PENDING/,
  );
});

test('non-prepaid order refund is ignored before touching the prepaid ledger', async () => {
  const { billing } = await customSetup();
  const event = refundOrder({
    orderId: '9999',
    refundedAmount: 1000,
    purchaseKind: '',
  });
  const result = await billing.handleWebhook(
    event.raw,
    event.signature,
  );
  assert.equal(result.status, 'ignored');
  assert.equal(result.accountId, null);
});

test('prepaid refund HTTP stays retryable until the purchase arrives, then the same event processes', async () => {
  const {
    account,
    controlStore,
    billingStore,
  } = await customSetup();
  const billing = new BillingService(
    controlStore,
    billingStore,
    provider(),
    { now: () => clock },
  );
  const handler = createBillingHttpHandler(billing, {
    authenticate: async () => null,
  });

  const refund = refundOrder({
    orderId: '9010',
    refundedAmount: 1000,
  });
  const early = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/webhook/lemonsqueezy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': refund.signature,
        },
        body: refund.raw,
      },
    ),
  );
  assert.equal(early?.status, 503);
  assert.equal(
    (await early!.json() as { error: string }).error,
    'BILLING_PREPAID_PURCHASE_PENDING',
  );

  const purchase = prepaidOrder({
    accountId: account.id,
    orderId: '9010',
    updatedAt: '2026-10-04T12:31:00Z',
  });
  const purchaseResult = await billing.handleWebhook(
    purchase.raw,
    purchase.signature,
  );
  assert.equal(purchaseResult.status, 'processed');

  const retried = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/webhook/lemonsqueezy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': refund.signature,
        },
        body: refund.raw,
      },
    ),
  );
  assert.equal(retried?.status, 200);
  const retriedBody = await retried!.json() as {
    status: string;
  };
  assert.equal(retriedBody.status, 'processed');
  assert.equal(
    await controlStore.getPrepaidCreditsBalance(
      account.quotaSubjectId,
    ),
    0,
  );
});

test('prepaid checkout HTTP is authenticated and only available to Custom prepaid accounts', async () => {
  const {
    account,
    controlStore,
    billingStore,
    control,
  } = await customSetup();

  const billing = new BillingService(
    controlStore,
    billingStore,
    provider(async () =>
      Response.json({
        data: {
          attributes: {
            url: 'https://example.lemonsqueezy.com/checkout/http-prepaid',
          },
        },
      }),
    ),
    { now: () => clock },
  );
  const handler = createBillingHttpHandler(billing, {
    authenticate: async (request) =>
      request.headers.get('x-auth') === 'yes'
        ? {
            accountId: account.id,
            role: 'user' as const,
          }
        : null,
  });

  const denied = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/prepaid/checkout',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ variantId: '3001' }),
      },
    ),
  );
  assert.equal(denied?.status, 401);

  const allowed = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/prepaid/checkout',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth': 'yes',
        },
        body: JSON.stringify({ variantId: '3001' }),
      },
    ),
  );
  assert.equal(allowed?.status, 200);
  const body = await allowed!.json() as { url: string };
  assert.equal(
    body.url,
    'https://example.lemonsqueezy.com/checkout/http-prepaid',
  );

  const freeAccount = await control.ensureAccount({
    id: 'free-account',
  });
  const freeBilling = new BillingService(
    controlStore,
    billingStore,
    provider(),
  );
  await assert.rejects(
    freeBilling.createPrepaidCheckout(
      { accountId: freeAccount.id, role: 'user' },
      '3001',
      'https://nexowire.example/?billing=prepaid-success',
    ),
    /BILLING_PREPAID_REQUIRED/,
  );
});
