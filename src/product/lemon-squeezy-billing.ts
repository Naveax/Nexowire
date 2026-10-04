import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import type {
  BillingSubscriptionPlanId,
  BillingSubscriptionStatus,
} from './billing-store.js';

const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

export interface LemonSqueezyPrepaidPackConfig {
  variantId: string;
  credits: number;
  label?: string;
}

export interface LemonSqueezyBillingConfig {
  apiKey: string;
  webhookSecret: string;
  storeId: string;
  plusVariantId: string;
  proVariantId: string;
  prepaidPacks?: readonly LemonSqueezyPrepaidPackConfig[];
  apiBaseUrl?: string;
}

export interface LemonSqueezySubscriptionWebhook {
  kind: 'subscription';
  eventHash: string;
  eventName: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  accountId: string | null;
  variantId: string;
  planId: BillingSubscriptionPlanId | null;
  status: BillingSubscriptionStatus;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  providerUpdatedAt: string;
  providerCreatedAt: string;
}

export interface LemonSqueezyPrepaidOrderWebhook {
  kind: 'prepaid-order';
  eventHash: string;
  eventName: 'order_created';
  providerOrderId: string;
  providerCustomerId: string;
  accountId: string | null;
  variantId: string;
  credits: number | null;
  totalAmount: number;
  providerUpdatedAt: string;
  providerCreatedAt: string;
}

export interface LemonSqueezyOrderRefundWebhook {
  kind: 'order-refund';
  eventHash: string;
  eventName: 'order_refunded';
  providerOrderId: string;
  variantId: string;
  totalAmount: number;
  refundedAmount: number;
  providerUpdatedAt: string;
}

export interface LemonSqueezyIgnoredWebhook {
  kind: 'ignored';
  eventHash: string;
  eventName: string;
}

export type LemonSqueezyWebhook =
  | LemonSqueezySubscriptionWebhook
  | LemonSqueezyPrepaidOrderWebhook
  | LemonSqueezyOrderRefundWebhook
  | LemonSqueezyIgnoredWebhook;

function required(
  name: string,
  value: string,
  max = 512,
): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(name + ' is invalid.');
  }
  return normalized;
}

function numericId(name: string, value: string): string {
  const normalized = required(name, value, 64);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(name + ' must be a numeric Lemon Squeezy ID.');
  }
  return normalized;
}

function isoOrNull(
  name: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('BILLING_WEBHOOK_INVALID_' + name);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error('BILLING_WEBHOOK_INVALID_' + name);
  }
  return new Date(time).toISOString();
}

function isoRequired(
  name: string,
  value: unknown,
): string {
  const parsed = isoOrNull(name, value);
  if (!parsed) {
    throw new Error('BILLING_WEBHOOK_INVALID_' + name);
  }
  return parsed;
}

function asRecord(
  value: unknown,
  error: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  error: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(error);
  }
  return value.trim();
}

function integerValue(
  value: unknown,
  error: string,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (options.positive ? 1 : 0)
  ) {
    throw new Error(error);
  }
  return value;
}

function idValue(
  value: unknown,
  error: string,
): string {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    throw new Error(error);
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(error);
  }
  return normalized;
}

function subscriptionStatus(
  value: unknown,
): BillingSubscriptionStatus {
  const status = stringValue(
    value,
    'BILLING_WEBHOOK_INVALID_STATUS',
  );
  if (
    status !== 'on_trial' &&
    status !== 'active' &&
    status !== 'paused' &&
    status !== 'past_due' &&
    status !== 'unpaid' &&
    status !== 'cancelled' &&
    status !== 'expired'
  ) {
    throw new Error('BILLING_WEBHOOK_INVALID_STATUS');
  }
  return status;
}

function safeHttpsUrl(
  name: string,
  raw: string,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(name + ' is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(name + ' must be an HTTPS URL.');
  }
  return url.toString();
}

export class LemonSqueezyBillingProvider {
  readonly provider = 'lemonsqueezy' as const;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly storeId: string;
  private readonly plusVariantId: string;
  private readonly proVariantId: string;
  private readonly prepaidPacksByVariant =
    new Map<string, { credits: number; label: string }>();
  private readonly apiBaseUrl: string;

  constructor(
    config: LemonSqueezyBillingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiKey = required(
      'Lemon Squeezy API key',
      config.apiKey,
      1024,
    );
    this.webhookSecret = required(
      'Lemon Squeezy webhook secret',
      config.webhookSecret,
      256,
    );
    this.storeId = numericId(
      'Lemon Squeezy store ID',
      config.storeId,
    );
    this.plusVariantId = numericId(
      'Lemon Squeezy Plus variant ID',
      config.plusVariantId,
    );
    this.proVariantId = numericId(
      'Lemon Squeezy Pro variant ID',
      config.proVariantId,
    );
    if (this.plusVariantId === this.proVariantId) {
      throw new Error(
        'Lemon Squeezy Plus and Pro variant IDs must differ.',
      );
    }

    for (const pack of config.prepaidPacks ?? []) {
      const variantId = numericId(
        'Lemon Squeezy prepaid variant ID',
        pack.variantId,
      );
      if (
        variantId === this.plusVariantId ||
        variantId === this.proVariantId ||
        this.prepaidPacksByVariant.has(variantId)
      ) {
        throw new Error(
          'Lemon Squeezy prepaid variant IDs must be unique and separate from subscription variants.',
        );
      }
      if (
        !Number.isInteger(pack.credits) ||
        pack.credits < 1 ||
        pack.credits > 2_147_483_647
      ) {
        throw new Error(
          'Lemon Squeezy prepaid pack credits are invalid.',
        );
      }
      const label =
        pack.label?.trim() || String(pack.credits) + ' credits';
      if (label.length > 80 || /[\r\n\0]/.test(label)) {
        throw new Error(
          'Lemon Squeezy prepaid pack label is invalid.',
        );
      }
      this.prepaidPacksByVariant.set(variantId, {
        credits: pack.credits,
        label,
      });
    }

    const base =
      config.apiBaseUrl?.trim() ||
      'https://api.lemonsqueezy.com/v1/';
    this.apiBaseUrl = safeHttpsUrl(
      'Lemon Squeezy API base URL',
      base,
    );
  }

  planForVariant(
    variantId: string,
  ): BillingSubscriptionPlanId | null {
    const normalized = String(variantId).trim();
    if (normalized === this.plusVariantId) return 'plus';
    if (normalized === this.proVariantId) return 'pro';
    return null;
  }

  variantForPlan(
    planId: BillingSubscriptionPlanId,
  ): string {
    return planId === 'plus'
      ? this.plusVariantId
      : this.proVariantId;
  }

  async createCheckout(input: {
    accountId: string;
    planId: BillingSubscriptionPlanId;
    redirectUrl: string;
  }): Promise<string> {
    const redirectUrl = safeHttpsUrl(
      'Billing redirect URL',
      input.redirectUrl,
    );
    const variantId = this.variantForPlan(input.planId);
    const response = await this.api('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            product_options: {
              redirect_url: redirectUrl,
              enabled_variants: [
                Number.parseInt(variantId, 10),
              ],
            },
            checkout_data: {
              custom: {
                account_id: input.accountId,
              },
            },
          },
          relationships: {
            store: {
              data: {
                type: 'stores',
                id: this.storeId,
              },
            },
            variant: {
              data: {
                type: 'variants',
                id: variantId,
              },
            },
          },
        },
      }),
    });

    const body = asRecord(
      await response.json(),
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const data = asRecord(
      body.data,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const attributes = asRecord(
      data.attributes,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    return safeHttpsUrl(
      'Lemon Squeezy checkout URL',
      stringValue(
        attributes.url,
        'BILLING_PROVIDER_RESPONSE_INVALID',
      ),
    );
  }

  listPrepaidPacks(): Array<{
    variantId: string;
    credits: number;
    label: string;
  }> {
    return [...this.prepaidPacksByVariant.entries()]
      .map(([variantId, pack]) => ({
        variantId,
        credits: pack.credits,
        label: pack.label,
      }))
      .sort(
        (a, b) =>
          a.credits - b.credits ||
          a.variantId.localeCompare(b.variantId),
      );
  }

  creditsForPrepaidVariant(
    variantId: string,
  ): number | null {
    return (
      this.prepaidPacksByVariant.get(
        String(variantId).trim(),
      )?.credits ?? null
    );
  }

  async createPrepaidCheckout(input: {
    accountId: string;
    variantId: string;
    redirectUrl: string;
  }): Promise<string> {
    const redirectUrl = safeHttpsUrl(
      'Billing redirect URL',
      input.redirectUrl,
    );
    const variantId = numericId(
      'Lemon Squeezy prepaid variant ID',
      input.variantId,
    );
    if (!this.prepaidPacksByVariant.has(variantId)) {
      throw new Error('BILLING_VARIANT_UNKNOWN');
    }

    const response = await this.api('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            product_options: {
              redirect_url: redirectUrl,
              enabled_variants: [
                Number.parseInt(variantId, 10),
              ],
            },
            checkout_data: {
              custom: {
                account_id: input.accountId,
                purchase_kind: 'prepaid_credits',
              },
            },
          },
          relationships: {
            store: {
              data: {
                type: 'stores',
                id: this.storeId,
              },
            },
            variant: {
              data: {
                type: 'variants',
                id: variantId,
              },
            },
          },
        },
      }),
    });

    const body = asRecord(
      await response.json(),
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const data = asRecord(
      body.data,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const attributes = asRecord(
      data.attributes,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    return safeHttpsUrl(
      'Lemon Squeezy checkout URL',
      stringValue(
        attributes.url,
        'BILLING_PROVIDER_RESPONSE_INVALID',
      ),
    );
  }

  async customerPortal(
    providerSubscriptionId: string,
  ): Promise<string> {
    const subscriptionId = numericId(
      'Lemon Squeezy subscription ID',
      providerSubscriptionId,
    );
    const response = await this.api(
      '/subscriptions/' + subscriptionId,
      { method: 'GET' },
    );
    const body = asRecord(
      await response.json(),
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const data = asRecord(
      body.data,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const attributes = asRecord(
      data.attributes,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    const urls = asRecord(
      attributes.urls,
      'BILLING_PROVIDER_RESPONSE_INVALID',
    );
    return safeHttpsUrl(
      'Lemon Squeezy customer portal URL',
      stringValue(
        urls.customer_portal,
        'BILLING_PROVIDER_RESPONSE_INVALID',
      ),
    );
  }

  parseWebhook(
    rawBody: string,
    signatureInput: string,
  ): LemonSqueezyWebhook {
    const signature = signatureInput.trim().toLowerCase();
    const expected = createHmac(
      'sha256',
      this.webhookSecret,
    )
      .update(rawBody, 'utf8')
      .digest('hex');
    const expectedBytes = Buffer.from(expected, 'utf8');
    const actualBytes = Buffer.from(signature, 'utf8');
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new Error('BILLING_WEBHOOK_SIGNATURE_INVALID');
    }

    const eventHash = createHash('sha256')
      .update(rawBody, 'utf8')
      .digest('hex');

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody);
    } catch {
      throw new Error('BILLING_WEBHOOK_INVALID_JSON');
    }
    const body = asRecord(
      decoded,
      'BILLING_WEBHOOK_INVALID',
    );
    const meta = asRecord(
      body.meta,
      'BILLING_WEBHOOK_INVALID',
    );
    const eventName = stringValue(
      meta.event_name,
      'BILLING_WEBHOOK_INVALID_EVENT',
    );

    if (eventName === 'order_refunded') {
      const custom =
        typeof meta.custom_data === 'object' &&
        meta.custom_data !== null &&
        !Array.isArray(meta.custom_data)
          ? (meta.custom_data as Record<string, unknown>)
          : {};
      if (custom.purchase_kind !== 'prepaid_credits') {
        return {
          kind: 'ignored',
          eventHash,
          eventName,
        };
      }
      const data = asRecord(
        body.data,
        'BILLING_WEBHOOK_INVALID',
      );
      if (data.type !== 'orders') {
        throw new Error('BILLING_WEBHOOK_INVALID_TYPE');
      }
      const attributes = asRecord(
        data.attributes,
        'BILLING_WEBHOOK_INVALID',
      );
      const firstOrderItem = asRecord(
        attributes.first_order_item,
        'BILLING_WEBHOOK_INVALID_ORDER_ITEM',
      );
      const totalAmount = integerValue(
        attributes.total,
        'BILLING_WEBHOOK_INVALID_ORDER_TOTAL',
        { positive: true },
      );
      const refundedAmount = integerValue(
        attributes.refunded_amount,
        'BILLING_WEBHOOK_INVALID_REFUND_AMOUNT',
        { positive: true },
      );
      if (refundedAmount > totalAmount) {
        throw new Error(
          'BILLING_WEBHOOK_INVALID_REFUND_AMOUNT',
        );
      }
      return {
        kind: 'order-refund',
        eventHash,
        eventName,
        providerOrderId: idValue(
          data.id,
          'BILLING_WEBHOOK_INVALID_ORDER',
        ),
        variantId: idValue(
          firstOrderItem.variant_id,
          'BILLING_WEBHOOK_INVALID_VARIANT',
        ),
        totalAmount,
        refundedAmount,
        providerUpdatedAt: isoRequired(
          'UPDATED_AT',
          attributes.updated_at,
        ),
      };
    }

    if (eventName === 'order_created') {
      const data = asRecord(
        body.data,
        'BILLING_WEBHOOK_INVALID',
      );
      if (data.type !== 'orders') {
        throw new Error('BILLING_WEBHOOK_INVALID_TYPE');
      }
      const attributes = asRecord(
        data.attributes,
        'BILLING_WEBHOOK_INVALID',
      );
      const custom =
        typeof meta.custom_data === 'object' &&
        meta.custom_data !== null &&
        !Array.isArray(meta.custom_data)
          ? (meta.custom_data as Record<string, unknown>)
          : {};
      if (custom.purchase_kind !== 'prepaid_credits') {
        return {
          kind: 'ignored',
          eventHash,
          eventName,
        };
      }
      if (attributes.status !== 'paid') {
        throw new Error(
          'BILLING_WEBHOOK_INVALID_ORDER_STATUS',
        );
      }
      const firstOrderItem = asRecord(
        attributes.first_order_item,
        'BILLING_WEBHOOK_INVALID_ORDER_ITEM',
      );
      const variantId = idValue(
        firstOrderItem.variant_id,
        'BILLING_WEBHOOK_INVALID_VARIANT',
      );
      return {
        kind: 'prepaid-order',
        eventHash,
        eventName,
        providerOrderId: idValue(
          data.id,
          'BILLING_WEBHOOK_INVALID_ORDER',
        ),
        providerCustomerId: idValue(
          attributes.customer_id,
          'BILLING_WEBHOOK_INVALID_CUSTOMER',
        ),
        accountId:
          typeof custom.account_id === 'string' &&
          custom.account_id.trim()
            ? custom.account_id.trim()
            : null,
        variantId,
        credits: this.creditsForPrepaidVariant(variantId),
        totalAmount: integerValue(
          attributes.total,
          'BILLING_WEBHOOK_INVALID_ORDER_TOTAL',
          { positive: true },
        ),
        providerUpdatedAt: isoRequired(
          'UPDATED_AT',
          attributes.updated_at,
        ),
        providerCreatedAt: isoRequired(
          'CREATED_AT',
          attributes.created_at,
        ),
      };
    }

    if (!SUBSCRIPTION_EVENTS.has(eventName)) {
      return {
        kind: 'ignored',
        eventHash,
        eventName,
      };
    }

    const data = asRecord(
      body.data,
      'BILLING_WEBHOOK_INVALID',
    );
    if (data.type !== 'subscriptions') {
      throw new Error('BILLING_WEBHOOK_INVALID_TYPE');
    }
    const attributes = asRecord(
      data.attributes,
      'BILLING_WEBHOOK_INVALID',
    );
    const custom =
      typeof meta.custom_data === 'object' &&
      meta.custom_data !== null &&
      !Array.isArray(meta.custom_data)
        ? (meta.custom_data as Record<string, unknown>)
        : {};

    const variantId = idValue(
      attributes.variant_id,
      'BILLING_WEBHOOK_INVALID_VARIANT',
    );

    return {
      kind: 'subscription',
      eventHash,
      eventName,
      providerSubscriptionId: idValue(
        data.id,
        'BILLING_WEBHOOK_INVALID_SUBSCRIPTION',
      ),
      providerCustomerId: idValue(
        attributes.customer_id,
        'BILLING_WEBHOOK_INVALID_CUSTOMER',
      ),
      accountId:
        typeof custom.account_id === 'string' &&
        custom.account_id.trim()
          ? custom.account_id.trim()
          : null,
      variantId,
      planId: this.planForVariant(variantId),
      status: subscriptionStatus(attributes.status),
      renewsAt: isoOrNull(
        'RENEWS_AT',
        attributes.renews_at,
      ),
      endsAt: isoOrNull(
        'ENDS_AT',
        attributes.ends_at,
      ),
      trialEndsAt: isoOrNull(
        'TRIAL_ENDS_AT',
        attributes.trial_ends_at,
      ),
      providerUpdatedAt: isoRequired(
        'UPDATED_AT',
        attributes.updated_at,
      ),
      providerCreatedAt: isoRequired(
        'CREATED_AT',
        attributes.created_at,
      ),
    };
  }

  private async api(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const target = new URL(
      path.replace(/^\//, ''),
      this.apiBaseUrl.endsWith('/')
        ? this.apiBaseUrl
        : this.apiBaseUrl + '/',
    );
    const response = await this.fetchImpl(target, {
      ...init,
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        authorization: 'Bearer ' + this.apiKey,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        'BILLING_PROVIDER_HTTP_' + String(response.status),
      );
    }
    return response;
  }
}
