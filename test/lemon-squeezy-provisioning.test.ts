import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
  defaultLemonSqueezyProvisioningPaths,
  ensureLemonSqueezyWebhook,
  evaluateLemonSqueezyProvisioningReadiness,
  generateLemonSqueezyWebhookSecret,
  inferLemonSqueezyPrepaidCredits,
  lemonSqueezyProvisioningEnvironment,
  listLemonSqueezyStores,
  listLemonSqueezyStoreVariants,
  mergeLemonSqueezyProvisioningEnvironment,
  optionalReadLemonSqueezyProvisioningState,
  parsePrepaidPackSpec,
  readLemonSqueezyProvisioningState,
  recommendLemonSqueezyPlanVariants,
  validateLemonSqueezyCatalog,
  validateLemonSqueezyWebhookReadiness,
  writeLemonSqueezyProvisioningState,
  type LemonSqueezyProvisioningState,
} from '../src/product/lemon-squeezy-provisioning.js';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function resource(
  type: string,
  id: string,
  attributes: Record<string, unknown>,
) {
  return {
    data: {
      type,
      id,
      attributes,
    },
  };
}

function collection(
  data: Array<{
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  }>,
  currentPage = 1,
  lastPage = 1,
) {
  return {
    meta: {
      page: {
        currentPage,
        lastPage,
      },
    },
    data,
  };
}

function state(): LemonSqueezyProvisioningState {
  return {
    version: 1,
    provider: 'lemonsqueezy',
    storeId: '1001',
    plusVariantId: '2001',
    proVariantId: '2002',
    prepaidPacks: [
      {
        variantId: '3001',
        credits: 100_000,
        label: '100k kredi',
      },
    ],
    webhookId: '4001',
    webhookUrl:
      'https://example.test/api/v1/billing/webhook/lemonsqueezy',
    updatedAt: '2026-10-04T18:00:00.000Z',
  };
}

function protectedEnvelope(purpose: string): string {
  return JSON.stringify({
    version: 1,
    protection: 'windows-dpapi-current-user',
    purpose,
    ciphertext: 'opaque-ciphertext-marker',
  });
}

test('generated webhook secret fits Lemon Squeezy signing-secret bounds', () => {
  const secret = generateLemonSqueezyWebhookSecret();
  assert.equal(secret.length, 40);
  assert.match(secret, /^[0-9a-f]{40}$/);
});

test('prepaid pack spec parses explicit and generated labels', () => {
  assert.deepEqual(
    parsePrepaidPackSpec('3001:100000:100k kredi'),
    {
      variantId: '3001',
      credits: 100_000,
      label: '100k kredi',
    },
  );
  assert.deepEqual(
    parsePrepaidPackSpec('3002:500000'),
    {
      variantId: '3002',
      credits: 500_000,
      label: '500,000 credits',
    },
  );
  assert.throws(
    () => parsePrepaidPackSpec('bad:100'),
  );
  assert.throws(
    () =>
      parsePrepaidPackSpec(
        '3003:100:' + 'x'.repeat(81),
      ),
  );
});

test('store discovery is GET-only and follows Lemon Squeezy pagination', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (
    input,
    init,
  ) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer api',
    );
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    assert.equal(url.pathname, '/v1/stores');
    const page = Number(
      url.searchParams.get('page[number]'),
    );
    assert.equal(
      url.searchParams.get('page[size]'),
      '100',
    );
    if (page === 1) {
      return json(
        collection(
          [
            {
              type: 'stores',
              id: '1001',
              attributes: {
                name: 'Nexowire',
                slug: 'nexowire',
                url: 'https://nexowire.lemonsqueezy.com',
                currency: 'USD',
              },
            },
          ],
          1,
          2,
        ),
      );
    }
    if (page === 2) {
      return json(
        collection(
          [
            {
              type: 'stores',
              id: '1002',
              attributes: {
                name: 'Archive',
                slug: 'archive',
                url: 'https://archive.lemonsqueezy.com',
                currency: 'EUR',
              },
            },
          ],
          2,
          2,
        ),
      );
    }
    throw new Error('unexpected page');
  };

  assert.deepEqual(
    await listLemonSqueezyStores(
      { apiKey: 'api' },
      fetchImpl,
    ),
    [
      {
        id: '1001',
        name: 'Nexowire',
        slug: 'nexowire',
        url: 'https://nexowire.lemonsqueezy.com',
        currency: 'USD',
      },
      {
        id: '1002',
        name: 'Archive',
        slug: 'archive',
        url: 'https://archive.lemonsqueezy.com',
        currency: 'EUR',
      },
    ],
  );
  assert.equal(requests.length, 2);
});

test('variant discovery keeps production eligibility and recommends unambiguous Plus/Pro subscriptions', async () => {
  const fetchImpl: typeof fetch = async (
    input,
    init,
  ) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    const url = new URL(String(input));

    if (url.pathname === '/v1/products') {
      assert.equal(
        url.searchParams.get('filter[store_id]'),
        '1001',
      );
      return json(
        collection([
          {
            type: 'products',
            id: '10',
            attributes: {
              store_id: 1001,
              name: 'Nexowire Plus',
              status: 'published',
              test_mode: false,
            },
          },
          {
            type: 'products',
            id: '20',
            attributes: {
              store_id: 1001,
              name: 'Nexowire Pro',
              status: 'published',
              test_mode: false,
            },
          },
          {
            type: 'products',
            id: '30',
            attributes: {
              store_id: 1001,
              name: 'Nexowire Credits',
              status: 'published',
              test_mode: false,
            },
          },
          {
            type: 'products',
            id: '40',
            attributes: {
              store_id: 1001,
              name: 'Nexowire Plus Legacy',
              status: 'draft',
              test_mode: false,
            },
          },
        ]),
      );
    }

    if (url.pathname === '/v1/variants') {
      const productId = url.searchParams.get(
        'filter[product_id]',
      );
      const byProduct: Record<
        string,
        Array<{
          type: string;
          id: string;
          attributes: Record<string, unknown>;
        }>
      > = {
        '10': [
          {
            type: 'variants',
            id: '2001',
            attributes: {
              product_id: 10,
              name: 'Monthly',
              price: 1200,
              is_subscription: true,
              interval: 'month',
              interval_count: 1,
              status: 'published',
              test_mode: false,
            },
          },
        ],
        '20': [
          {
            type: 'variants',
            id: '2002',
            attributes: {
              product_id: 20,
              name: 'Monthly',
              price: 2900,
              is_subscription: true,
              interval: 'month',
              interval_count: 1,
              status: 'published',
              test_mode: false,
            },
          },
        ],
        '30': [
          {
            type: 'variants',
            id: '3001',
            attributes: {
              product_id: 30,
              name: '100k credits',
              price: 900,
              is_subscription: false,
              interval: null,
              interval_count: null,
              status: 'published',
              test_mode: false,
            },
          },
        ],
        '40': [
          {
            type: 'variants',
            id: '4001',
            attributes: {
              product_id: 40,
              name: 'Plus old',
              price: 500,
              is_subscription: true,
              interval: 'month',
              interval_count: 1,
              status: 'published',
              test_mode: false,
            },
          },
        ],
      };
      if (!productId || !byProduct[productId]) {
        throw new Error('unexpected product');
      }
      return json(collection(byProduct[productId]!));
    }

    throw new Error('unexpected URL ' + url);
  };

  const variants =
    await listLemonSqueezyStoreVariants(
      {
        apiKey: 'api',
        storeId: '1001',
      },
      fetchImpl,
    );

  assert.equal(variants.length, 4);
  assert.equal(
    variants.find((item) => item.id === '3001')
      ?.isSubscription,
    false,
  );
  assert.equal(
    variants.find((item) => item.id === '4001')
      ?.eligibleForProduction,
    false,
  );
  assert.deepEqual(
    recommendLemonSqueezyPlanVariants(variants),
    {
      plusVariantId: '2001',
      proVariantId: '2002',
      plusMatches: ['2001'],
      proMatches: ['2002'],
    },
  );

  const plus = variants.find(
    (item) => item.id === '2001',
  );
  assert.ok(plus);
  const ambiguous =
    recommendLemonSqueezyPlanVariants([
      ...variants,
      {
        ...plus,
        id: '2003',
        name: 'Plus annual',
      },
    ]);
  assert.equal(ambiguous.plusVariantId, null);
  assert.deepEqual(
    ambiguous.plusMatches.sort(),
    ['2001', '2003'],
  );
  assert.equal(ambiguous.proVariantId, '2002');

  const prepaid = variants.find(
    (item) => item.id === '3001',
  );
  assert.ok(prepaid);
  assert.equal(
    inferLemonSqueezyPrepaidCredits(prepaid),
    100_000,
  );
  assert.equal(
    inferLemonSqueezyPrepaidCredits({
      ...prepaid,
      id: '3002',
      name: '1.5M credits',
    }),
    1_500_000,
  );
  assert.equal(
    inferLemonSqueezyPrepaidCredits({
      ...prepaid,
      id: '3003',
      name: '250,000 kredi',
    }),
    250_000,
  );
  assert.equal(
    inferLemonSqueezyPrepaidCredits({
      ...prepaid,
      id: '3004',
      name: 'Starter pack',
    }),
    null,
  );
});

test('provisioning state round-trips and missing state is optional', async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-state-'),
  );
  const file = path.join(dir, 'billing.json');

  try {
    assert.equal(
      await optionalReadLemonSqueezyProvisioningState(file),
      null,
    );
    await writeLemonSqueezyProvisioningState(file, state());
    assert.deepEqual(
      await readLemonSqueezyProvisioningState(file),
      state(),
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning readiness reports exact missing local artifacts without reading secrets', async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-readiness-missing-'),
  );
  const paths =
    defaultLemonSqueezyProvisioningPaths(homeDir);

  try {
    const readiness =
      await evaluateLemonSqueezyProvisioningReadiness({
        homeDir,
        platform: 'win32',
      });

    assert.equal(readiness.platformSupported, true);
    assert.equal(
      readiness.readyForProvisionedBootstrap,
      false,
    );
    assert.deepEqual(readiness.blockers, [
      'PROVISIONING_CONFIG_MISSING',
      'API_KEY_PROTECTED_FILE_MISSING',
      'WEBHOOK_SECRET_PROTECTED_FILE_MISSING',
    ]);
    assert.equal(readiness.config.exists, false);
    assert.equal(readiness.config.valid, false);
    assert.equal(readiness.config.catalog, null);
    assert.deepEqual(
      readiness.protectedSecrets.apiKey,
      {
        path: paths.apiKeyFile,
        present: false,
        validEnvelope: false,
      },
    );
    assert.deepEqual(
      readiness.protectedSecrets.webhookSecret,
      {
        path: paths.webhookSecretFile,
        present: false,
        validEnvelope: false,
      },
    );
    assert.equal(readiness.liveProviderValidated, false);
  } finally {
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning readiness exposes only non-secret catalog metadata when local artifacts are complete', async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-readiness-complete-'),
  );
  const paths =
    defaultLemonSqueezyProvisioningPaths(homeDir);

  try {
    await writeLemonSqueezyProvisioningState(
      paths.configFile,
      state(),
    );
    await Promise.all([
      fs.writeFile(
        paths.apiKeyFile,
        protectedEnvelope('billing-lemonsqueezy-api-key'),
      ),
      fs.writeFile(
        paths.webhookSecretFile,
        protectedEnvelope(
          'billing-lemonsqueezy-webhook-secret',
        ),
      ),
    ]);

    const readiness =
      await evaluateLemonSqueezyProvisioningReadiness({
        homeDir,
        platform: 'win32',
      });

    assert.equal(
      readiness.readyForProvisionedBootstrap,
      true,
    );
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.config.valid, true);
    assert.deepEqual(readiness.config.catalog, {
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
      prepaidPackCount: 1,
      webhookId: '4001',
      webhookUrl:
        'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      updatedAt: '2026-10-04T18:00:00.000Z',
    });
    assert.deepEqual(
      readiness.protectedSecrets.apiKey,
      {
        path: paths.apiKeyFile,
        present: true,
        validEnvelope: true,
      },
    );
    assert.deepEqual(
      readiness.protectedSecrets.webhookSecret,
      {
        path: paths.webhookSecretFile,
        present: true,
        validEnvelope: true,
      },
    );

    const serialized = JSON.stringify(readiness);
    assert.doesNotMatch(
      serialized,
      /opaque-ciphertext-marker/,
    );
  } finally {
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning readiness rejects malformed or wrong-purpose protected envelopes without decrypting them', async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-readiness-envelope-'),
  );
  const paths =
    defaultLemonSqueezyProvisioningPaths(homeDir);

  try {
    await writeLemonSqueezyProvisioningState(
      paths.configFile,
      state(),
    );
    await Promise.all([
      fs.writeFile(
        paths.apiKeyFile,
        protectedEnvelope('wrong-purpose'),
      ),
      fs.writeFile(
        paths.webhookSecretFile,
        protectedEnvelope(
          'billing-lemonsqueezy-webhook-secret',
        ),
      ),
    ]);

    const readiness =
      await evaluateLemonSqueezyProvisioningReadiness({
        homeDir,
        platform: 'win32',
      });

    assert.equal(
      readiness.readyForProvisionedBootstrap,
      false,
    );
    assert.deepEqual(readiness.blockers, [
      'API_KEY_PROTECTED_FILE_INVALID',
    ]);
    assert.deepEqual(
      readiness.protectedSecrets.apiKey,
      {
        path: paths.apiKeyFile,
        present: true,
        validEnvelope: false,
      },
    );
    assert.equal(
      readiness.protectedSecrets.webhookSecret.validEnvelope,
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(readiness),
      /opaque-ciphertext-marker|wrong-purpose/,
    );
  } finally {
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning readiness fails closed on malformed config without echoing its contents', async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-readiness-invalid-'),
  );
  const paths =
    defaultLemonSqueezyProvisioningPaths(homeDir);
  const marker = 'do-not-echo-this-invalid-value';

  try {
    await fs.mkdir(paths.directory, {
      recursive: true,
    });
    await fs.writeFile(
      paths.configFile,
      JSON.stringify({
        provider: 'lemonsqueezy',
        unexpected: marker,
      }),
    );
    await Promise.all([
      fs.writeFile(
        paths.apiKeyFile,
        protectedEnvelope('billing-lemonsqueezy-api-key'),
      ),
      fs.writeFile(
        paths.webhookSecretFile,
        protectedEnvelope(
          'billing-lemonsqueezy-webhook-secret',
        ),
      ),
    ]);

    const readiness =
      await evaluateLemonSqueezyProvisioningReadiness({
        homeDir,
        platform: 'win32',
      });

    assert.equal(readiness.config.exists, true);
    assert.equal(readiness.config.valid, false);
    assert.equal(readiness.config.catalog, null);
    assert.equal(
      readiness.readyForProvisionedBootstrap,
      false,
    );
    assert.deepEqual(readiness.blockers, [
      'INVALID_PROVISIONING_CONFIG',
    ]);
    assert.doesNotMatch(
      JSON.stringify(readiness),
      new RegExp(marker),
    );
  } finally {
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning readiness reports the Windows DPAPI platform gate separately', async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-lemon-readiness-platform-'),
  );
  const paths =
    defaultLemonSqueezyProvisioningPaths(homeDir);

  try {
    await writeLemonSqueezyProvisioningState(
      paths.configFile,
      state(),
    );
    await Promise.all([
      fs.writeFile(
        paths.apiKeyFile,
        protectedEnvelope('billing-lemonsqueezy-api-key'),
      ),
      fs.writeFile(
        paths.webhookSecretFile,
        protectedEnvelope(
          'billing-lemonsqueezy-webhook-secret',
        ),
      ),
    ]);

    const readiness =
      await evaluateLemonSqueezyProvisioningReadiness({
        homeDir,
        platform: 'linux',
      });

    assert.equal(readiness.platformSupported, false);
    assert.equal(
      readiness.readyForProvisionedBootstrap,
      false,
    );
    assert.deepEqual(readiness.blockers, [
      'WINDOWS_OWNER_DPAPI_REQUIRED',
    ]);
  } finally {
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
    });
  }
});

test('provisioning environment exposes only protected-file paths and non-secret catalog config', () => {
  const paths =
    defaultLemonSqueezyProvisioningPaths(
      path.join('C:', 'owner'),
    );
  const env = lemonSqueezyProvisioningEnvironment(
    state(),
    paths,
  );

  assert.equal(
    env.NEXOWIRE_LEMONSQUEEZY_STORE_ID,
    '1001',
  );
  assert.equal(
    env.NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID,
    '2001',
  );
  assert.equal(
    env.NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID,
    '2002',
  );
  assert.equal(
    env.NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON,
    JSON.stringify(state().prepaidPacks),
  );
  assert.match(
    env.NEXOWIRE_LEMONSQUEEZY_API_KEY_DPAPI_FILE,
    /billing-lemonsqueezy-api-key\.dpapi\.json$/,
  );
  assert.match(
    env.NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET_DPAPI_FILE,
    /billing-lemonsqueezy-webhook-secret\.dpapi\.json$/,
  );
  assert.equal(
    'NEXOWIRE_LEMONSQUEEZY_API_KEY' in env,
    false,
  );
  assert.equal(
    'NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET' in env,
    false,
  );
});

test('provisioning environment merges semantically equal overrides and rejects conflicts', () => {
  const paths =
    defaultLemonSqueezyProvisioningPaths(
      path.join('C:', 'owner'),
    );
  const merged =
    mergeLemonSqueezyProvisioningEnvironment(
      {
        NEXOWIRE_LEMONSQUEEZY_STORE_ID: '1001',
        NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON:
          JSON.stringify(state().prepaidPacks, null, 2),
        UNRELATED: 'keep-me',
      },
      state(),
      paths,
    );

  assert.equal(merged.UNRELATED, 'keep-me');
  assert.equal(
    merged.NEXOWIRE_LEMONSQUEEZY_STORE_ID,
    '1001',
  );

  assert.throws(
    () =>
      mergeLemonSqueezyProvisioningEnvironment(
        {
          NEXOWIRE_LEMONSQUEEZY_STORE_ID: '9999',
        },
        state(),
        paths,
      ),
    /LEMONSQUEEZY_PROVISIONING_CONFLICT/,
  );
});

test('catalog validation accepts production subscription and one-time variants from the configured store', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url.pathname);

    if (url.pathname === '/v1/stores/1001') {
      return json(
        resource('stores', '1001', {
          name: 'Nexowire',
        }),
      );
    }

    const variant = /^\/v1\/variants\/(\d+)$/.exec(
      url.pathname,
    );
    if (variant) {
      const id = variant[1]!;
      const subscription =
        id === '2001' || id === '2002';
      return json(
        resource('variants', id, {
          product_id: Number('5' + id),
          is_subscription: subscription,
          status: 'published',
          test_mode: false,
        }),
      );
    }

    const product = /^\/v1\/products\/(\d+)$/.exec(
      url.pathname,
    );
    if (product) {
      return json(
        resource('products', product[1]!, {
          store_id: 1001,
          status: 'published',
          test_mode: false,
        }),
      );
    }

    throw new Error('unexpected URL ' + url);
  };

  const result = await validateLemonSqueezyCatalog(
    {
      apiKey: 'secret',
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2002',
      prepaidPacks: [
        {
          variantId: '3001',
          credits: 100_000,
          label: '100k kredi',
        },
      ],
    },
    fetchImpl,
  );

  assert.equal(result.storeId, '1001');
  assert.deepEqual(
    result.variants.map((variant) => variant.role),
    ['plus', 'pro', 'prepaid'],
  );
  assert.equal(
    seen.filter((item) =>
      item.startsWith('/v1/variants/'),
    ).length,
    3,
  );
});

test('catalog validation rejects duplicate, wrong-kind, draft, or test-mode variants', async () => {
  await assert.rejects(
    validateLemonSqueezyCatalog({
      apiKey: 'secret',
      storeId: '1001',
      plusVariantId: '2001',
      proVariantId: '2001',
      prepaidPacks: [],
    }),
    /VARIANT_IDS_MUST_BE_UNIQUE/,
  );

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/stores/1001') {
      return json(resource('stores', '1001', {}));
    }
    if (url.pathname === '/v1/variants/2001') {
      return json(
        resource('variants', '2001', {
          product_id: 52001,
          is_subscription: false,
          status: 'published',
          test_mode: false,
        }),
      );
    }
    throw new Error('unexpected URL ' + url);
  };

  await assert.rejects(
    validateLemonSqueezyCatalog(
      {
        apiKey: 'secret',
        storeId: '1001',
        plusVariantId: '2001',
        proVariantId: '2002',
        prepaidPacks: [],
      },
      fetchImpl,
    ),
    /VARIANT_KIND_MISMATCH/,
  );

  const testModeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/stores/1001') {
      return json(resource('stores', '1001', {}));
    }
    if (url.pathname === '/v1/variants/2001') {
      return json(
        resource('variants', '2001', {
          product_id: 52001,
          is_subscription: true,
          status: 'published',
          test_mode: true,
        }),
      );
    }
    throw new Error('unexpected URL ' + url);
  };

  await assert.rejects(
    validateLemonSqueezyCatalog(
      {
        apiKey: 'secret',
        storeId: '1001',
        plusVariantId: '2001',
        proVariantId: '2002',
        prepaidPacks: [],
      },
      testModeFetch,
    ),
    /VARIANT_TEST_MODE/,
  );
});

test('webhook readiness validates production URL and complete event coverage without mutation', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(url.pathname, '/v1/webhooks/4001');
    return json(
      resource('webhooks', '4001', {
        store_id: 1001,
        url:
          'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        events: [
          ...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
          'license_key_created',
        ],
        test_mode: false,
      }),
    );
  };

  assert.deepEqual(
    await validateLemonSqueezyWebhookReadiness(
      {
        apiKey: 'api',
        storeId: '1001',
        webhookId: '4001',
        webhookUrl:
          'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      },
      fetchImpl,
    ),
    {
      webhookId: '4001',
      webhookUrl:
        'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      requiredEvents: [
        ...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
      ],
      testMode: false,
    },
  );
});

test('webhook readiness fails closed on URL drift or missing required events', async () => {
  for (const attributes of [
    {
      store_id: 1001,
      url:
        'https://wrong.example.test/api/v1/billing/webhook/lemonsqueezy',
      events: [
        ...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
      ],
      test_mode: false,
    },
    {
      store_id: 1001,
      url:
        'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      events: [],
      test_mode: false,
    },
  ]) {
    const fetchImpl: typeof fetch = async () =>
      json(
        resource(
          'webhooks',
          '4001',
          attributes,
        ),
      );

    await assert.rejects(
      validateLemonSqueezyWebhookReadiness(
        {
          apiKey: 'api',
          storeId: '1001',
          webhookId: '4001',
          webhookUrl:
            'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        },
        fetchImpl,
      ),
      /LEMONSQUEEZY_WEBHOOK_(?:URL_MISMATCH|EVENTS_MISSING)/,
    );
  }
});

test('webhook dry-run reports create/update without exposing or requiring a secret', async () => {
  const createFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/webhooks');
    return json({ data: [] });
  };

  assert.deepEqual(
    await ensureLemonSqueezyWebhook(
      {
        apiKey: 'api',
        storeId: '1001',
        webhookUrl:
          'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        apply: false,
      },
      createFetch,
    ),
    {
      action: 'would-create',
      webhookId: null,
    },
  );

  const updateFetch: typeof fetch = async () =>
    json({
      data: [
        {
          type: 'webhooks',
          id: '4001',
          attributes: {
            url:
              'https://example.test/api/v1/billing/webhook/lemonsqueezy',
            test_mode: false,
          },
        },
      ],
    });

  assert.deepEqual(
    await ensureLemonSqueezyWebhook(
      {
        apiKey: 'api',
        storeId: '1001',
        webhookUrl:
          'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        apply: false,
      },
      updateFetch,
    ),
    {
      action: 'would-update',
      webhookId: '4001',
    },
  );
});

test('webhook apply creates production webhook with the complete required event set', async () => {
  let createBody: any;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.pathname === '/v1/webhooks' &&
      (!init?.method || init.method === 'GET')
    ) {
      return json({ data: [] });
    }
    if (
      url.pathname === '/v1/webhooks' &&
      init?.method === 'POST'
    ) {
      createBody = JSON.parse(String(init.body));
      return json(
        resource('webhooks', '4001', {
          url:
            'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        }),
      );
    }
    throw new Error('unexpected request ' + url);
  };

  const result = await ensureLemonSqueezyWebhook(
    {
      apiKey: 'api',
      storeId: '1001',
      webhookUrl:
        'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      webhookSecret: 'webhook-secret',
      apply: true,
    },
    fetchImpl,
  );

  assert.deepEqual(result, {
    action: 'created',
    webhookId: '4001',
  });
  assert.equal(
    createBody.data.attributes.test_mode,
    false,
  );
  assert.equal(
    createBody.data.attributes.secret,
    'webhook-secret',
  );
  assert.deepEqual(
    createBody.data.attributes.events,
    [...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS],
  );
});


test('webhook apply updates an existing production webhook idempotently', async () => {
  let patchBody: any;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.pathname === '/v1/webhooks' &&
      (!init?.method || init.method === 'GET')
    ) {
      return json({
        data: [
          {
            type: 'webhooks',
            id: '4001',
            attributes: {
              url:
                'https://example.test/api/v1/billing/webhook/lemonsqueezy',
              events: ['order_created'],
              test_mode: false,
            },
          },
        ],
      });
    }
    if (
      url.pathname === '/v1/webhooks/4001' &&
      init?.method === 'PATCH'
    ) {
      patchBody = JSON.parse(String(init.body));
      return json(
        resource('webhooks', '4001', {
          url:
            'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        }),
      );
    }
    throw new Error('unexpected request ' + url);
  };

  const result = await ensureLemonSqueezyWebhook(
    {
      apiKey: 'api',
      storeId: '1001',
      webhookUrl:
        'https://example.test/api/v1/billing/webhook/lemonsqueezy',
      webhookSecret: 'rotated-secret',
      apply: true,
    },
    fetchImpl,
  );

  assert.deepEqual(result, {
    action: 'updated',
    webhookId: '4001',
  });
  assert.equal(patchBody.data.id, '4001');
  assert.equal(
    patchBody.data.attributes.secret,
    'rotated-secret',
  );
  assert.deepEqual(
    patchBody.data.attributes.events,
    [...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS],
  );
  assert.equal(
    patchBody.data.attributes.test_mode,
    false,
  );
});


test('provisioned webhook id is updated even when the endpoint URL changes', async () => {
  const requests: Array<{
    path: string;
    method: string;
    body?: any;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET');
    requests.push({
      path: url.pathname,
      method,
      ...(init?.body
        ? { body: JSON.parse(String(init.body)) }
        : {}),
    });

    if (
      url.pathname === '/v1/webhooks/4001' &&
      method === 'GET'
    ) {
      return json(
        resource('webhooks', '4001', {
          store_id: 1001,
          url:
            'https://old.example.test/api/v1/billing/webhook/lemonsqueezy',
          test_mode: false,
        }),
      );
    }
    if (
      url.pathname === '/v1/webhooks/4001' &&
      method === 'PATCH'
    ) {
      return json(
        resource('webhooks', '4001', {
          store_id: 1001,
          url:
            'https://new.example.test/api/v1/billing/webhook/lemonsqueezy',
          test_mode: false,
        }),
      );
    }
    throw new Error('unexpected request ' + url);
  };

  const result = await ensureLemonSqueezyWebhook(
    {
      apiKey: 'api',
      storeId: '1001',
      webhookId: '4001',
      webhookUrl:
        'https://new.example.test/api/v1/billing/webhook/lemonsqueezy',
      webhookSecret: 'same-secret',
      apply: true,
    },
    fetchImpl,
  );

  assert.deepEqual(result, {
    action: 'updated',
    webhookId: '4001',
  });
  assert.deepEqual(
    requests.map((entry) => [
      entry.method,
      entry.path,
    ]),
    [
      ['GET', '/v1/webhooks/4001'],
      ['PATCH', '/v1/webhooks/4001'],
    ],
  );
  assert.equal(
    requests[1]?.body.data.attributes.url,
    'https://new.example.test/api/v1/billing/webhook/lemonsqueezy',
  );
});

test('provisioned webhook id fails closed when it belongs to another store or test mode', async () => {
  for (const attributes of [
    {
      store_id: 9999,
      test_mode: false,
    },
    {
      store_id: 1001,
      test_mode: true,
    },
  ]) {
    const fetchImpl: typeof fetch = async () =>
      json(
        resource('webhooks', '4001', {
          ...attributes,
          url:
            'https://example.test/api/v1/billing/webhook/lemonsqueezy',
        }),
      );

    await assert.rejects(
      ensureLemonSqueezyWebhook(
        {
          apiKey: 'api',
          storeId: '1001',
          webhookId: '4001',
          webhookUrl:
            'https://example.test/api/v1/billing/webhook/lemonsqueezy',
          webhookSecret: 'secret',
          apply: true,
        },
        fetchImpl,
      ),
      /LEMONSQUEEZY_WEBHOOK_STATE_MISMATCH/,
    );
  }
});
