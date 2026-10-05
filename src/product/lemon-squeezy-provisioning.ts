import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  inspectProtectedSecretFile,
} from '../security/protected-secret-files.js';
import {
  LEMON_SQUEEZY_ORDER_EVENT_NAMES,
  LEMON_SQUEEZY_SUBSCRIPTION_EVENT_NAMES,
} from './lemon-squeezy-billing.js';

export function generateLemonSqueezyWebhookSecret(): string {
  return randomBytes(20).toString('hex');
}

export const LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS = [
  ...LEMON_SQUEEZY_ORDER_EVENT_NAMES,
  ...LEMON_SQUEEZY_SUBSCRIPTION_EVENT_NAMES,
] as const;

const NumericIdSchema = z
  .string()
  .regex(/^\d+$/)
  .max(32);

const PrepaidPackSchema = z.object({
  variantId: NumericIdSchema,
  credits: z.number().int().positive().max(1_000_000_000),
  label: z.string().trim().min(1).max(80),
});

const ProvisioningStateSchema = z.object({
  version: z.literal(1),
  provider: z.literal('lemonsqueezy'),
  storeId: NumericIdSchema,
  plusVariantId: NumericIdSchema,
  proVariantId: NumericIdSchema,
  prepaidPacks: z.array(PrepaidPackSchema).max(20),
  webhookId: NumericIdSchema,
  webhookUrl: z.string().url().max(4096),
  updatedAt: z.string().datetime(),
});

export type LemonSqueezyPrepaidPack = z.infer<
  typeof PrepaidPackSchema
>;
export type LemonSqueezyProvisioningState = z.infer<
  typeof ProvisioningStateSchema
>;

export interface LemonSqueezyProvisioningPaths {
  directory: string;
  apiKeyFile: string;
  webhookSecretFile: string;
  configFile: string;
}

export function defaultLemonSqueezyProvisioningPaths(
  homeDir = os.homedir(),
): LemonSqueezyProvisioningPaths {
  const directory = path.join(
    homeDir,
    '.nexowire',
    'control-plane',
  );
  return {
    directory,
    apiKeyFile: path.join(
      directory,
      'billing-lemonsqueezy-api-key.dpapi.json',
    ),
    webhookSecretFile: path.join(
      directory,
      'billing-lemonsqueezy-webhook-secret.dpapi.json',
    ),
    configFile: path.join(
      directory,
      'billing-lemonsqueezy.json',
    ),
  };
}

export function parsePrepaidPackSpec(
  raw: string,
): LemonSqueezyPrepaidPack {
  const [variantId, creditsRaw, ...labelParts] =
    raw.split(':');
  const credits = Number(creditsRaw);
  const label = labelParts.join(':').trim() ||
    (Number.isFinite(credits)
      ? credits.toLocaleString('en-US') + ' credits'
      : 'credits');
  return PrepaidPackSchema.parse({
    variantId: variantId?.trim(),
    credits,
    label,
  });
}

export async function readLemonSqueezyProvisioningState(
  file: string,
): Promise<LemonSqueezyProvisioningState> {
  const raw = await fs.readFile(file, 'utf8');
  return ProvisioningStateSchema.parse(JSON.parse(raw));
}

export async function writeLemonSqueezyProvisioningState(
  file: string,
  state: LemonSqueezyProvisioningState,
): Promise<void> {
  const parsed = ProvisioningStateSchema.parse(state);
  await fs.mkdir(path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    file,
    JSON.stringify(parsed, null, 2) + '\n',
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      'Lemon Squeezy API returned an invalid object.',
    );
  }
  return value as Record<string, unknown>;
}

function dataRecord(
  value: unknown,
): Record<string, unknown> {
  const root = asRecord(value);
  return asRecord(root.data);
}

async function apiJson(
  input: {
    apiKey: string;
    path: string;
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
  },
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(
    'https://api.lemonsqueezy.com/v1' + input.path,
    {
      method: input.method ?? 'GET',
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        authorization: 'Bearer ' + input.apiKey,
      },
      ...(input.body === undefined
        ? {}
        : { body: JSON.stringify(input.body) }),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    throw new Error(
      'LEMONSQUEEZY_API_HTTP_' +
        response.status +
        (body ? ': ' + body : ''),
    );
  }
  return await response.json();
}

async function validateVariant(
  input: {
    apiKey: string;
    storeId: string;
    variantId: string;
    role: 'plus' | 'pro' | 'prepaid';
    expectSubscription: boolean;
  },
  fetchImpl: typeof fetch,
) {
  const variant = dataRecord(
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/variants/' + input.variantId,
      },
      fetchImpl,
    ),
  );
  if (String(variant.id ?? '') !== input.variantId) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_ID_MISMATCH:' +
        input.variantId,
    );
  }
  const attributes = asRecord(variant.attributes);
  const productId = String(
    attributes.product_id ?? '',
  ).trim();
  if (!/^\d+$/.test(productId)) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_PRODUCT_INVALID:' +
        input.variantId,
    );
  }
  if (
    Boolean(attributes.is_subscription) !==
    input.expectSubscription
  ) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_KIND_MISMATCH:' +
        input.variantId,
    );
  }
  const status = String(attributes.status ?? '').trim();
  if (status === 'draft') {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_DRAFT:' +
        input.variantId,
    );
  }
  if (attributes.test_mode === true) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_TEST_MODE:' +
        input.variantId,
    );
  }

  const product = dataRecord(
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/products/' + productId,
      },
      fetchImpl,
    ),
  );
  const productAttributes = asRecord(
    product.attributes,
  );
  if (
    String(productAttributes.store_id ?? '') !==
    input.storeId
  ) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_STORE_MISMATCH:' +
        input.variantId,
    );
  }
  if (productAttributes.test_mode === true) {
    throw new Error(
      'LEMONSQUEEZY_PRODUCT_TEST_MODE:' +
        productId,
    );
  }
  if (
    String(productAttributes.status ?? '').trim() ===
    'draft'
  ) {
    throw new Error(
      'LEMONSQUEEZY_PRODUCT_DRAFT:' + productId,
    );
  }

  return {
    role: input.role,
    variantId: input.variantId,
    productId,
    status,
    isSubscription: input.expectSubscription,
  };
}

export async function validateLemonSqueezyCatalog(
  input: {
    apiKey: string;
    storeId: string;
    plusVariantId: string;
    proVariantId: string;
    prepaidPacks: LemonSqueezyPrepaidPack[];
  },
  fetchImpl: typeof fetch = fetch,
) {
  NumericIdSchema.parse(input.storeId);
  NumericIdSchema.parse(input.plusVariantId);
  NumericIdSchema.parse(input.proVariantId);
  const prepaidPacks = input.prepaidPacks.map((pack) =>
    PrepaidPackSchema.parse(pack),
  );
  const ids = [
    input.plusVariantId,
    input.proVariantId,
    ...prepaidPacks.map((pack) => pack.variantId),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      'LEMONSQUEEZY_VARIANT_IDS_MUST_BE_UNIQUE',
    );
  }

  const store = dataRecord(
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/stores/' + input.storeId,
      },
      fetchImpl,
    ),
  );
  if (String(store.id ?? '') !== input.storeId) {
    throw new Error(
      'LEMONSQUEEZY_STORE_ID_MISMATCH',
    );
  }

  const variants = [];
  variants.push(
    await validateVariant(
      {
        apiKey: input.apiKey,
        storeId: input.storeId,
        variantId: input.plusVariantId,
        role: 'plus',
        expectSubscription: true,
      },
      fetchImpl,
    ),
  );
  variants.push(
    await validateVariant(
      {
        apiKey: input.apiKey,
        storeId: input.storeId,
        variantId: input.proVariantId,
        role: 'pro',
        expectSubscription: true,
      },
      fetchImpl,
    ),
  );
  for (const pack of prepaidPacks) {
    variants.push(
      await validateVariant(
        {
          apiKey: input.apiKey,
          storeId: input.storeId,
          variantId: pack.variantId,
          role: 'prepaid',
          expectSubscription: false,
        },
        fetchImpl,
      ),
    );
  }

  return {
    storeId: input.storeId,
    variants,
  };
}

export async function validateLemonSqueezyWebhookReadiness(
  input: {
    apiKey: string;
    storeId: string;
    webhookId: string;
    webhookUrl: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  webhookId: string;
  webhookUrl: string;
  requiredEvents: string[];
  testMode: false;
}> {
  NumericIdSchema.parse(input.storeId);
  const webhookId = NumericIdSchema.parse(
    input.webhookId.trim(),
  );
  const webhookUrl = new URL(input.webhookUrl);
  if (webhookUrl.protocol !== 'https:') {
    throw new Error(
      'Lemon Squeezy webhook URL must use HTTPS.',
    );
  }

  const webhook = dataRecord(
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/webhooks/' + webhookId,
      },
      fetchImpl,
    ),
  );
  if (String(webhook.id ?? '') !== webhookId) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_ID_MISMATCH',
    );
  }

  const attributes = asRecord(webhook.attributes);
  if (
    String(attributes.store_id ?? '') !==
      input.storeId ||
    attributes.test_mode === true
  ) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_STATE_MISMATCH:' +
        webhookId,
    );
  }
  if (
    String(attributes.url ?? '') !==
    webhookUrl.toString()
  ) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_URL_MISMATCH:' +
        webhookId,
    );
  }

  const rawEvents = attributes.events;
  if (!Array.isArray(rawEvents)) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_EVENTS_INVALID:' +
        webhookId,
    );
  }
  const events = new Set(
    rawEvents.map((event) => String(event)),
  );
  const missingEvents =
    LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS.filter(
      (event) => !events.has(event),
    );
  if (missingEvents.length > 0) {
    throw new Error(
      'LEMONSQUEEZY_WEBHOOK_EVENTS_MISSING:' +
        missingEvents.join(','),
    );
  }

  return {
    webhookId,
    webhookUrl: webhookUrl.toString(),
    requiredEvents: [
      ...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
    ],
    testMode: false,
  };
}

export async function ensureLemonSqueezyWebhook(
  input: {
    apiKey: string;
    storeId: string;
    webhookUrl: string;
    webhookId?: string;
    webhookSecret?: string;
    apply: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  action:
    | 'would-create'
    | 'would-update'
    | 'created'
    | 'updated';
  webhookId: string | null;
}> {
  NumericIdSchema.parse(input.storeId);
  const url = new URL(input.webhookUrl);
  if (url.protocol !== 'https:') {
    throw new Error(
      'Lemon Squeezy webhook URL must use HTTPS.',
    );
  }

  let existing: Record<string, unknown> | undefined;
  if (input.webhookId?.trim()) {
    const preferredId = NumericIdSchema.parse(
      input.webhookId.trim(),
    );
    existing = dataRecord(
      await apiJson(
        {
          apiKey: input.apiKey,
          path: '/webhooks/' + preferredId,
        },
        fetchImpl,
      ),
    );
    const attributes = asRecord(existing.attributes);
    if (
      String(attributes.store_id ?? '') !== input.storeId ||
      attributes.test_mode === true
    ) {
      throw new Error(
        'LEMONSQUEEZY_WEBHOOK_STATE_MISMATCH:' +
          preferredId,
      );
    }
  } else {
    const listed = asRecord(
      await apiJson(
        {
          apiKey: input.apiKey,
          path:
            '/webhooks?filter[store_id]=' +
            encodeURIComponent(input.storeId),
        },
        fetchImpl,
      ),
    );
    const rawData = listed.data;
    const rows = Array.isArray(rawData)
      ? rawData
      : rawData
        ? [rawData]
        : [];
    existing = rows
      .map((entry) => asRecord(entry))
      .find((entry) => {
        const attributes = asRecord(entry.attributes);
        return (
          String(attributes.url ?? '') ===
            input.webhookUrl &&
          attributes.test_mode !== true
        );
      });
  }
  const existingId = existing
    ? String(existing.id ?? '').trim()
    : '';

  if (!input.apply) {
    return {
      action: existingId
        ? 'would-update'
        : 'would-create',
      webhookId: existingId || null,
    };
  }
  if (!input.webhookSecret?.trim()) {
    throw new Error(
      'Lemon Squeezy webhook secret is required when --apply is used.',
    );
  }

  const attributes = {
    url: input.webhookUrl,
    events: [
      ...LEMON_SQUEEZY_REQUIRED_WEBHOOK_EVENTS,
    ],
    secret: input.webhookSecret.trim(),
    test_mode: false,
  };

  if (existingId) {
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/webhooks/' + existingId,
        method: 'PATCH',
        body: {
          data: {
            type: 'webhooks',
            id: existingId,
            attributes,
          },
        },
      },
      fetchImpl,
    );
    return {
      action: 'updated',
      webhookId: existingId,
    };
  }

  const created = dataRecord(
    await apiJson(
      {
        apiKey: input.apiKey,
        path: '/webhooks',
        method: 'POST',
        body: {
          data: {
            type: 'webhooks',
            attributes,
            relationships: {
              store: {
                data: {
                  type: 'stores',
                  id: input.storeId,
                },
              },
            },
          },
        },
      },
      fetchImpl,
    ),
  );
  const webhookId = String(created.id ?? '').trim();
  NumericIdSchema.parse(webhookId);
  return {
    action: 'created',
    webhookId,
  };
}


export async function optionalReadLemonSqueezyProvisioningState(
  file: string,
): Promise<LemonSqueezyProvisioningState | null> {
  try {
    return await readLemonSqueezyProvisioningState(file);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export type LemonSqueezyProvisioningBlocker =
  | 'WINDOWS_OWNER_DPAPI_REQUIRED'
  | 'PROVISIONING_CONFIG_MISSING'
  | 'INVALID_PROVISIONING_CONFIG'
  | 'API_KEY_PROTECTED_FILE_MISSING'
  | 'API_KEY_PROTECTED_FILE_INVALID'
  | 'WEBHOOK_SECRET_PROTECTED_FILE_MISSING'
  | 'WEBHOOK_SECRET_PROTECTED_FILE_INVALID';

export interface LemonSqueezyProvisioningReadiness {
  provider: 'lemonsqueezy';
  platform: NodeJS.Platform;
  platformSupported: boolean;
  readyForProvisionedBootstrap: boolean;
  blockers: LemonSqueezyProvisioningBlocker[];
  config: {
    path: string;
    exists: boolean;
    valid: boolean;
    catalog: {
      storeId: string;
      plusVariantId: string;
      proVariantId: string;
      prepaidPackCount: number;
      webhookId: string;
      webhookUrl: string;
      updatedAt: string;
    } | null;
  };
  protectedSecrets: {
    apiKey: {
      path: string;
      present: boolean;
      validEnvelope: boolean;
    };
    webhookSecret: {
      path: string;
      present: boolean;
      validEnvelope: boolean;
    };
  };
  liveProviderValidated: false;
}

async function regularFilePresent(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function inspectProtectedEnvelope(
  file: string,
  expectedPurpose: string,
): Promise<{
  present: boolean;
  validEnvelope: boolean;
}> {
  const present = await regularFilePresent(file);
  if (!present) {
    return {
      present: false,
      validEnvelope: false,
    };
  }

  try {
    const metadata = inspectProtectedSecretFile(file);
    return {
      present: true,
      validEnvelope:
        metadata.protection ===
          'windows-dpapi-current-user' &&
        metadata.purpose === expectedPurpose,
    };
  } catch {
    return {
      present: true,
      validEnvelope: false,
    };
  }
}

export async function evaluateLemonSqueezyProvisioningReadiness(
  input: {
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<LemonSqueezyProvisioningReadiness> {
  const platform = input.platform ?? process.platform;
  const paths = defaultLemonSqueezyProvisioningPaths(
    input.homeDir,
  );
  const platformSupported = platform === 'win32';
  const blockers: LemonSqueezyProvisioningBlocker[] = [];

  if (!platformSupported) {
    blockers.push('WINDOWS_OWNER_DPAPI_REQUIRED');
  }

  const [
    configExists,
    apiKeyEnvelope,
    webhookSecretEnvelope,
  ] = await Promise.all([
    regularFilePresent(paths.configFile),
    inspectProtectedEnvelope(
      paths.apiKeyFile,
      'billing-lemonsqueezy-api-key',
    ),
    inspectProtectedEnvelope(
      paths.webhookSecretFile,
      'billing-lemonsqueezy-webhook-secret',
    ),
  ]);

  let configState: LemonSqueezyProvisioningState | null = null;
  let configValid = false;

  if (!configExists) {
    blockers.push('PROVISIONING_CONFIG_MISSING');
  } else {
    try {
      configState =
        await readLemonSqueezyProvisioningState(
          paths.configFile,
        );
      configValid = true;
    } catch {
      blockers.push('INVALID_PROVISIONING_CONFIG');
    }
  }

  if (!apiKeyEnvelope.present) {
    blockers.push('API_KEY_PROTECTED_FILE_MISSING');
  } else if (!apiKeyEnvelope.validEnvelope) {
    blockers.push('API_KEY_PROTECTED_FILE_INVALID');
  }
  if (!webhookSecretEnvelope.present) {
    blockers.push(
      'WEBHOOK_SECRET_PROTECTED_FILE_MISSING',
    );
  } else if (!webhookSecretEnvelope.validEnvelope) {
    blockers.push(
      'WEBHOOK_SECRET_PROTECTED_FILE_INVALID',
    );
  }

  return {
    provider: 'lemonsqueezy',
    platform,
    platformSupported,
    readyForProvisionedBootstrap:
      platformSupported &&
      configValid &&
      apiKeyEnvelope.validEnvelope &&
      webhookSecretEnvelope.validEnvelope,
    blockers,
    config: {
      path: paths.configFile,
      exists: configExists,
      valid: configValid,
      catalog: configState
        ? {
            storeId: configState.storeId,
            plusVariantId: configState.plusVariantId,
            proVariantId: configState.proVariantId,
            prepaidPackCount:
              configState.prepaidPacks.length,
            webhookId: configState.webhookId,
            webhookUrl: configState.webhookUrl,
            updatedAt: configState.updatedAt,
          }
        : null,
    },
    protectedSecrets: {
      apiKey: {
        path: paths.apiKeyFile,
        ...apiKeyEnvelope,
      },
      webhookSecret: {
        path: paths.webhookSecretFile,
        ...webhookSecretEnvelope,
      },
    },
    liveProviderValidated: false,
  };
}

const PROVISIONING_ENV_KEYS = [
  'NEXOWIRE_LEMONSQUEEZY_API_KEY_DPAPI_FILE',
  'NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET_DPAPI_FILE',
  'NEXOWIRE_LEMONSQUEEZY_STORE_ID',
  'NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID',
  'NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID',
  'NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON',
] as const;

function normalizeProvisioningEnvValue(
  key: (typeof PROVISIONING_ENV_KEYS)[number],
  value: string,
): string {
  const trimmed = value.trim();
  if (
    key === 'NEXOWIRE_LEMONSQUEEZY_API_KEY_DPAPI_FILE' ||
    key ===
      'NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET_DPAPI_FILE'
  ) {
    return path.resolve(trimmed);
  }
  if (
    key === 'NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON'
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        'NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON must be valid JSON.',
      );
    }
    const packs = z.array(PrepaidPackSchema).max(20).parse(parsed);
    return JSON.stringify(packs);
  }
  return trimmed;
}

export function lemonSqueezyProvisioningEnvironment(
  state: LemonSqueezyProvisioningState,
  paths: LemonSqueezyProvisioningPaths,
): Record<
  (typeof PROVISIONING_ENV_KEYS)[number],
  string
> {
  const parsed = ProvisioningStateSchema.parse(state);
  return {
    NEXOWIRE_LEMONSQUEEZY_API_KEY_DPAPI_FILE:
      path.resolve(paths.apiKeyFile),
    NEXOWIRE_LEMONSQUEEZY_WEBHOOK_SECRET_DPAPI_FILE:
      path.resolve(paths.webhookSecretFile),
    NEXOWIRE_LEMONSQUEEZY_STORE_ID: parsed.storeId,
    NEXOWIRE_LEMONSQUEEZY_PLUS_VARIANT_ID:
      parsed.plusVariantId,
    NEXOWIRE_LEMONSQUEEZY_PRO_VARIANT_ID:
      parsed.proVariantId,
    NEXOWIRE_LEMONSQUEEZY_PREPAID_PACKS_JSON:
      JSON.stringify(parsed.prepaidPacks),
  };
}

export function mergeLemonSqueezyProvisioningEnvironment(
  env: NodeJS.ProcessEnv,
  state: LemonSqueezyProvisioningState,
  paths: LemonSqueezyProvisioningPaths,
): NodeJS.ProcessEnv {
  const provisioned =
    lemonSqueezyProvisioningEnvironment(state, paths);
  const merged: NodeJS.ProcessEnv = { ...env };

  for (const key of PROVISIONING_ENV_KEYS) {
    const existing = env[key]?.trim();
    const expected = provisioned[key];
    if (
      existing &&
      normalizeProvisioningEnvValue(key, existing) !==
        normalizeProvisioningEnvValue(key, expected)
    ) {
      throw new Error(
        'LEMONSQUEEZY_PROVISIONING_CONFLICT:' + key,
      );
    }
    merged[key] = expected;
  }

  return merged;
}
