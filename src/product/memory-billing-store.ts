import type {
  BillingProviderId,
  BillingStore,
  BillingSubscriptionRecord,
  BillingWebhookEventRecord,
} from './billing-store.js';

function subscriptionKey(
  provider: BillingProviderId,
  id: string,
): string {
  return provider + ':' + id;
}

function eventKey(
  provider: BillingProviderId,
  hash: string,
): string {
  return provider + ':' + hash;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryBillingStore implements BillingStore {
  private readonly subscriptions =
    new Map<string, BillingSubscriptionRecord>();
  private readonly events =
    new Map<string, BillingWebhookEventRecord>();

  async getSubscription(
    provider: BillingProviderId,
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    const value = this.subscriptions.get(
      subscriptionKey(provider, providerSubscriptionId),
    );
    return value ? clone(value) : null;
  }

  async putSubscription(
    record: BillingSubscriptionRecord,
  ): Promise<void> {
    this.subscriptions.set(
      subscriptionKey(
        record.provider,
        record.providerSubscriptionId,
      ),
      clone(record),
    );
  }

  async listSubscriptions(
    accountId: string,
  ): Promise<BillingSubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter((record) => record.accountId === accountId)
      .sort((a, b) =>
        b.providerUpdatedAt.localeCompare(a.providerUpdatedAt) ||
        a.providerSubscriptionId.localeCompare(
          b.providerSubscriptionId,
        ),
      )
      .map(clone);
  }

  async getWebhookEvent(
    provider: BillingProviderId,
    eventHash: string,
  ): Promise<BillingWebhookEventRecord | null> {
    const value = this.events.get(eventKey(provider, eventHash));
    return value ? clone(value) : null;
  }

  async putWebhookEvent(
    record: BillingWebhookEventRecord,
  ): Promise<void> {
    const key = eventKey(record.provider, record.eventHash);
    if (!this.events.has(key)) {
      this.events.set(key, clone(record));
    }
  }
}
