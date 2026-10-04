import type { ProductPlanId } from './plans.js';

export type BillingProviderId = 'lemonsqueezy';

export type BillingSubscriptionPlanId = Extract<
  ProductPlanId,
  'plus' | 'pro'
>;

export type BillingSubscriptionStatus =
  | 'on_trial'
  | 'active'
  | 'paused'
  | 'past_due'
  | 'unpaid'
  | 'cancelled'
  | 'expired';

export interface BillingSubscriptionRecord {
  provider: BillingProviderId;
  providerSubscriptionId: string;
  providerCustomerId: string;
  accountId: string;
  planId: BillingSubscriptionPlanId;
  variantId: string;
  status: BillingSubscriptionStatus;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  providerUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingWebhookEventRecord {
  provider: BillingProviderId;
  eventHash: string;
  eventName: string;
  providerObjectId: string | null;
  accountId: string | null;
  receivedAt: string;
  processedAt: string;
}

export interface BillingStore {
  getSubscription(
    provider: BillingProviderId,
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null>;

  putSubscription(
    record: BillingSubscriptionRecord,
  ): Promise<void>;

  listSubscriptions(
    accountId: string,
  ): Promise<BillingSubscriptionRecord[]>;

  getWebhookEvent(
    provider: BillingProviderId,
    eventHash: string,
  ): Promise<BillingWebhookEventRecord | null>;

  putWebhookEvent(
    record: BillingWebhookEventRecord,
  ): Promise<void>;
}
