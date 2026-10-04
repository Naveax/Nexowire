import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { MemoryBillingStore } from '../src/product/memory-billing-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { BillingService } from '../src/product/billing-service.js';
import { LemonSqueezyBillingProvider } from '../src/product/lemon-squeezy-billing.js';
import { createBillingHttpHandler } from '../src/product/billing-http.js';

const secret = 'billing-http-webhook-secret-0123456789';

async function setup() {
  const controlStore = new MemoryControlPlaneStore();
  const billingStore = new MemoryBillingStore();
  const control = new ControlPlaneService(controlStore, {
    now: () =>
      new Date('2026-10-04T12:00:00.000Z'),
  });
  const account = await control.ensureAccount({
    id: 'acct_http',
  });

  const provider = new LemonSqueezyBillingProvider(
    {
      apiKey: 'api-key-0123456789',
      webhookSecret: secret,
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
    },
    async (input, init) => {
      const url = String(input);
      if (
        url ===
        'https://api.lemonsqueezy.com/v1/checkouts'
      ) {
        assert.equal(init?.method, 'POST');
        return Response.json({
          data: {
            attributes: {
              url: 'https://example.lemonsqueezy.com/checkout/http',
            },
          },
        });
      }
      if (
        url ===
        'https://api.lemonsqueezy.com/v1/subscriptions/7001'
      ) {
        assert.equal(init?.method, 'GET');
        return Response.json({
          data: {
            attributes: {
              urls: {
                customer_portal:
                  'https://app.lemonsqueezy.com/my-orders/http',
              },
            },
          },
        });
      }
      throw new Error('unexpected provider request: ' + url);
    },
  );

  const billing = new BillingService(
    controlStore,
    billingStore,
    provider,
    {
      now: () =>
        new Date('2026-10-04T12:00:00.000Z'),
    },
  );

  const handler = createBillingHttpHandler(billing, {
    authenticate: async (request) => {
      return request.headers.get('x-test-auth') === 'yes'
        ? {
            accountId: account.id,
            role: 'user' as const,
          }
        : null;
    },
  });

  return {
    account,
    controlStore,
    handler,
  };
}

function webhook(accountId: string): {
  raw: string;
  signature: string;
} {
  const raw = JSON.stringify({
    meta: {
      event_name: 'subscription_created',
      custom_data: {
        account_id: accountId,
      },
    },
    data: {
      type: 'subscriptions',
      id: '7001',
      attributes: {
        customer_id: 8001,
        variant_id: 2001,
        status: 'active',
        renews_at: '2026-11-01T12:00:00Z',
        ends_at: null,
        trial_ends_at: null,
        created_at: '2026-10-01T12:00:00Z',
        updated_at: '2026-10-04T12:00:00Z',
      },
    },
  });
  return {
    raw,
    signature: createHmac('sha256', secret)
      .update(raw, 'utf8')
      .digest('hex'),
  };
}

test('billing HTTP protects account endpoints while allowing signed webhook delivery', async () => {
  const { account, controlStore, handler } =
    await setup();

  const denied = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/status',
    ),
  );
  assert.equal(denied?.status, 401);

  const event = webhook(account.id);
  const accepted = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/webhook/lemonsqueezy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': event.signature,
        },
        body: event.raw,
      },
    ),
  );
  assert.equal(accepted?.status, 200);
  const acceptedBody = await accepted!.json() as {
    status: string;
  };
  assert.equal(
    acceptedBody.status,
    'processed',
  );
  assert.equal(
    (await controlStore.getAccount(account.id))?.planId,
    'plus',
  );

  const status = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/status',
      {
        headers: { 'x-test-auth': 'yes' },
      },
    ),
  );
  assert.equal(status?.status, 200);
  const statusBody = await status!.json() as any;
  assert.equal(statusBody.planId, 'plus');
  assert.equal(statusBody.subscription.status, 'active');

  const portal = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/portal',
      {
        headers: { 'x-test-auth': 'yes' },
      },
    ),
  );
  assert.equal(portal?.status, 200);
  const portalBody = await portal!.json() as {
    url: string;
  };
  assert.equal(
    portalBody.url,
    'https://app.lemonsqueezy.com/my-orders/http',
  );
});

test('billing HTTP checkout uses a fixed server-side redirect and rejects bad webhook signatures', async () => {
  const { handler } = await setup();

  const checkout = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/checkout',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'yes',
        },
        body: JSON.stringify({
          planId: 'pro',
          redirectUrl:
            'https://attacker.example/steal',
        }),
      },
    ),
  );
  assert.equal(checkout?.status, 200);
  const checkoutBody = await checkout!.json() as {
    url: string;
  };
  assert.equal(
    checkoutBody.url,
    'https://example.lemonsqueezy.com/checkout/http',
  );

  const badWebhook = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/webhook/lemonsqueezy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': '00'.repeat(32),
        },
        body: '{}',
      },
    ),
  );
  assert.equal(badWebhook?.status, 401);
  const badWebhookBody = await badWebhook!.json() as {
    error: string;
  };
  assert.equal(
    badWebhookBody.error,
    'BILLING_WEBHOOK_SIGNATURE_INVALID',
  );
});

test('billing HTTP returns null for non-billing routes', async () => {
  const { handler } = await setup();
  assert.equal(
    await handler(
      new Request(
        'https://nexowire.example/api/v1/me/dashboard',
      ),
    ),
    null,
  );
});


test('billing HTTP rejects oversized webhook bodies before processing', async () => {
  const { handler } = await setup();
  const response = await handler(
    new Request(
      'https://nexowire.example/api/v1/billing/webhook/lemonsqueezy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '300000',
          'x-signature': '00'.repeat(32),
        },
        body: '{}',
      },
    ),
  );
  assert.equal(response?.status, 413);
  const body = await response!.json() as {
    error: string;
  };
  assert.equal(
    body.error,
    'BILLING_WEBHOOK_TOO_LARGE',
  );
});
