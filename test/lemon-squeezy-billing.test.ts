import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  LemonSqueezyBillingProvider,
} from '../src/product/lemon-squeezy-billing.js';

const secret = 'webhook-secret-0123456789';

function provider(
  fetchImpl: typeof fetch = fetch,
): LemonSqueezyBillingProvider {
  return new LemonSqueezyBillingProvider(
    {
      apiKey: 'api-key-0123456789',
      webhookSecret: secret,
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
    },
    fetchImpl,
  );
}

function signed(payload: unknown): {
  raw: string;
  signature: string;
} {
  const raw = JSON.stringify(payload);
  return {
    raw,
    signature: createHmac('sha256', secret)
      .update(raw, 'utf8')
      .digest('hex'),
  };
}

test('Lemon Squeezy checkout uses configured store/variant and server account metadata', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const billing = provider(async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return Response.json({
      data: {
        attributes: {
          url: 'https://example.lemonsqueezy.com/checkout/custom/abc',
        },
      },
    });
  });

  const url = await billing.createCheckout({
    accountId: 'acct_test',
    planId: 'plus',
    redirectUrl: 'https://nexowire.example/?billing=success',
  });

  assert.equal(
    url,
    'https://example.lemonsqueezy.com/checkout/custom/abc',
  );
  assert.equal(
    seenUrl,
    'https://api.lemonsqueezy.com/v1/checkouts',
  );
  assert.equal(seenInit?.method, 'POST');
  const body = JSON.parse(String(seenInit?.body));
  assert.equal(
    body.data.relationships.store.data.id,
    '1001',
  );
  assert.equal(
    body.data.relationships.variant.data.id,
    '2001',
  );
  assert.deepEqual(
    body.data.attributes.checkout_data.custom,
    { account_id: 'acct_test' },
  );
  assert.deepEqual(
    body.data.attributes.product_options.enabled_variants,
    [2001],
  );
});

test('Lemon Squeezy portal resolves a fresh signed customer portal URL', async () => {
  const billing = provider(async (input, init) => {
    assert.equal(
      String(input),
      'https://api.lemonsqueezy.com/v1/subscriptions/777',
    );
    assert.equal(init?.method, 'GET');
    return Response.json({
      data: {
        attributes: {
          urls: {
            customer_portal:
              'https://app.lemonsqueezy.com/my-orders/portal',
          },
        },
      },
    });
  });

  assert.equal(
    await billing.customerPortal('777'),
    'https://app.lemonsqueezy.com/my-orders/portal',
  );
});

test('Lemon Squeezy webhook verification maps subscription variant and state', () => {
  const billing = provider();
  const { raw, signature } = signed({
    meta: {
      event_name: 'subscription_updated',
      custom_data: {
        account_id: 'acct_123',
      },
    },
    data: {
      type: 'subscriptions',
      id: '7001',
      attributes: {
        customer_id: 8001,
        variant_id: 2002,
        status: 'active',
        renews_at: '2026-11-01T12:00:00Z',
        ends_at: null,
        trial_ends_at: null,
        created_at: '2026-10-01T12:00:00Z',
        updated_at: '2026-10-04T12:00:00Z',
      },
    },
  });

  const event = billing.parseWebhook(raw, signature);
  assert.equal(event.kind, 'subscription');
  if (event.kind !== 'subscription') {
    throw new Error('expected subscription event');
  }
  assert.equal(event.providerSubscriptionId, '7001');
  assert.equal(event.providerCustomerId, '8001');
  assert.equal(event.accountId, 'acct_123');
  assert.equal(event.variantId, '2002');
  assert.equal(event.planId, 'pro');
  assert.equal(event.status, 'active');
  assert.equal(
    event.renewsAt,
    '2026-11-01T12:00:00.000Z',
  );
});

test('Lemon Squeezy webhook rejects a bad signature and ignores unrelated signed events', () => {
  const billing = provider();
  const { raw } = signed({
    meta: { event_name: 'order_created' },
    data: { type: 'orders', id: '1', attributes: {} },
  });

  assert.throws(
    () => billing.parseWebhook(raw, '00'.repeat(32)),
    /BILLING_WEBHOOK_SIGNATURE_INVALID/,
  );

  const signature = createHmac('sha256', secret)
    .update(raw, 'utf8')
    .digest('hex');
  const event = billing.parseWebhook(raw, signature);
  assert.equal(event.kind, 'ignored');
  assert.equal(event.eventName, 'order_created');
});
