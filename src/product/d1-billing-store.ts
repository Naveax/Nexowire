import type {
  BillingProviderId,
  BillingStore,
  BillingSubscriptionRecord,
  BillingSubscriptionStatus,
  BillingWebhookEventRecord,
} from './billing-store.js';
import type {
  D1DatabaseLike,
} from './d1-control-plane-store.js';
import type {
  BillingSubscriptionPlanId,
} from './billing-store.js';

type DbSubscriptionRow = {
  provider: BillingProviderId;
  provider_subscription_id: string;
  provider_customer_id: string;
  account_id: string;
  plan_id: BillingSubscriptionPlanId;
  variant_id: string;
  status: BillingSubscriptionStatus;
  renews_at: string | null;
  ends_at: string | null;
  trial_ends_at: string | null;
  provider_updated_at: string;
  created_at: string;
  updated_at: string;
};

type DbWebhookEventRow = {
  provider: BillingProviderId;
  event_hash: string;
  event_name: string;
  provider_object_id: string | null;
  account_id: string | null;
  received_at: string;
  processed_at: string;
};

function subscriptionFromRow(
  row: DbSubscriptionRow,
): BillingSubscriptionRecord {
  return {
    provider: row.provider,
    providerSubscriptionId: row.provider_subscription_id,
    providerCustomerId: row.provider_customer_id,
    accountId: row.account_id,
    planId: row.plan_id,
    variantId: row.variant_id,
    status: row.status,
    renewsAt: row.renews_at,
    endsAt: row.ends_at,
    trialEndsAt: row.trial_ends_at,
    providerUpdatedAt: row.provider_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function webhookFromRow(
  row: DbWebhookEventRow,
): BillingWebhookEventRecord {
  return {
    provider: row.provider,
    eventHash: row.event_hash,
    eventName: row.event_name,
    providerObjectId: row.provider_object_id,
    accountId: row.account_id,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

export class D1BillingStore implements BillingStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getSubscription(
    provider: BillingProviderId,
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, provider_subscription_id, provider_customer_id,
                account_id, plan_id, variant_id, status, renews_at,
                ends_at, trial_ends_at, provider_updated_at,
                created_at, updated_at
         FROM billing_subscriptions
         WHERE provider = ? AND provider_subscription_id = ?`,
      )
      .bind(provider, providerSubscriptionId)
      .first<DbSubscriptionRow>();
    return row ? subscriptionFromRow(row) : null;
  }

  async putSubscription(
    record: BillingSubscriptionRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO billing_subscriptions (
           provider, provider_subscription_id, provider_customer_id,
           account_id, plan_id, variant_id, status, renews_at,
           ends_at, trial_ends_at, provider_updated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_subscription_id) DO UPDATE SET
           provider_customer_id = excluded.provider_customer_id,
           account_id = excluded.account_id,
           plan_id = excluded.plan_id,
           variant_id = excluded.variant_id,
           status = excluded.status,
           renews_at = excluded.renews_at,
           ends_at = excluded.ends_at,
           trial_ends_at = excluded.trial_ends_at,
           provider_updated_at = excluded.provider_updated_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.provider,
        record.providerSubscriptionId,
        record.providerCustomerId,
        record.accountId,
        record.planId,
        record.variantId,
        record.status,
        record.renewsAt,
        record.endsAt,
        record.trialEndsAt,
        record.providerUpdatedAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async listSubscriptions(
    accountId: string,
  ): Promise<BillingSubscriptionRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT provider, provider_subscription_id, provider_customer_id,
                account_id, plan_id, variant_id, status, renews_at,
                ends_at, trial_ends_at, provider_updated_at,
                created_at, updated_at
         FROM billing_subscriptions
         WHERE account_id = ?
         ORDER BY provider_updated_at DESC, provider_subscription_id ASC`,
      )
      .bind(accountId)
      .all<DbSubscriptionRow>();
    return (result.results ?? []).map(subscriptionFromRow);
  }

  async getWebhookEvent(
    provider: BillingProviderId,
    eventHash: string,
  ): Promise<BillingWebhookEventRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, event_hash, event_name, provider_object_id,
                account_id, received_at, processed_at
         FROM billing_webhook_events
         WHERE provider = ? AND event_hash = ?`,
      )
      .bind(provider, eventHash)
      .first<DbWebhookEventRow>();
    return row ? webhookFromRow(row) : null;
  }

  async putWebhookEvent(
    record: BillingWebhookEventRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO billing_webhook_events (
           provider, event_hash, event_name, provider_object_id,
           account_id, received_at, processed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.provider,
        record.eventHash,
        record.eventName,
        record.providerObjectId,
        record.accountId,
        record.receivedAt,
        record.processedAt,
      )
      .run();
  }
}
