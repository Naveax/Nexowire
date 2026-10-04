import { randomUUID } from 'node:crypto';
import type {
  BillingStore,
  BillingSubscriptionPlanId,
  BillingSubscriptionRecord,
} from './billing-store.js';
import type {
  ControlPlaneStore,
  ProductAccountRecord,
} from './control-plane-store.js';
import type {
  ControlPlaneIdentity,
} from './control-plane-service.js';
import {
  LemonSqueezyBillingProvider,
} from './lemon-squeezy-billing.js';

const PLAN_WEIGHT: Record<
  BillingSubscriptionPlanId,
  number
> = {
  plus: 1,
  pro: 2,
};

function boundedAccountId(input: string): string {
  const value = input.trim();
  if (
    !value ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error('BILLING_ACCOUNT_INVALID');
  }
  return value;
}

function entitlementActive(
  subscription: BillingSubscriptionRecord,
  now: Date,
): boolean {
  if (
    subscription.status === 'on_trial' ||
    subscription.status === 'active' ||
    subscription.status === 'paused' ||
    subscription.status === 'past_due'
  ) {
    return true;
  }
  if (subscription.status !== 'cancelled') {
    return false;
  }
  if (!subscription.endsAt) return false;
  return Date.parse(subscription.endsAt) > now.getTime();
}

function preferredSubscription(
  subscriptions: BillingSubscriptionRecord[],
  now: Date,
): BillingSubscriptionRecord | null {
  const entitled = subscriptions
    .filter((subscription) =>
      entitlementActive(subscription, now),
    )
    .sort(
      (a, b) =>
        PLAN_WEIGHT[b.planId] - PLAN_WEIGHT[a.planId] ||
        b.providerUpdatedAt.localeCompare(
          a.providerUpdatedAt,
        ),
    );
  return entitled[0] ?? subscriptions[0] ?? null;
}

export interface BillingServiceOptions {
  now?: () => Date;
}

export class BillingService {
  private readonly now: () => Date;

  constructor(
    private readonly controlStore: ControlPlaneStore,
    private readonly billingStore: BillingStore,
    private readonly provider: LemonSqueezyBillingProvider,
    options: BillingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async status(identity: ControlPlaneIdentity): Promise<{
    provider: 'lemonsqueezy';
    planId: string;
    subscription: {
      id: string;
      planId: BillingSubscriptionPlanId;
      status: string;
      renewsAt: string | null;
      endsAt: string | null;
    } | null;
  }> {
    const account = await this.requireAccount(
      identity.accountId,
    );
    const subscriptions =
      await this.billingStore.listSubscriptions(account.id);
    const selected = preferredSubscription(
      subscriptions,
      this.now(),
    );
    return {
      provider: 'lemonsqueezy',
      planId: account.planId,
      subscription: selected
        ? {
            id: selected.providerSubscriptionId,
            planId: selected.planId,
            status: selected.status,
            renewsAt: selected.renewsAt,
            endsAt: selected.endsAt,
          }
        : null,
    };
  }

  async createCheckout(
    identity: ControlPlaneIdentity,
    planIdInput: string,
    redirectUrl: string,
  ): Promise<{ url: string }> {
    const account = await this.requireAccount(
      identity.accountId,
    );
    if (account.planId === 'custom') {
      throw new Error('BILLING_CUSTOM_MANAGED');
    }

    const planId =
      planIdInput === 'plus' || planIdInput === 'pro'
        ? planIdInput
        : null;
    if (!planId) {
      throw new Error('BILLING_PLAN_INVALID');
    }

    const subscriptions =
      await this.billingStore.listSubscriptions(account.id);
    if (
      subscriptions.some((subscription) =>
        entitlementActive(subscription, this.now()),
      )
    ) {
      throw new Error('BILLING_PORTAL_REQUIRED');
    }

    return {
      url: await this.provider.createCheckout({
        accountId: account.id,
        planId,
        redirectUrl,
      }),
    };
  }

  async customerPortal(
    identity: ControlPlaneIdentity,
  ): Promise<{ url: string }> {
    const account = await this.requireAccount(
      identity.accountId,
    );
    const subscriptions =
      await this.billingStore.listSubscriptions(account.id);
    const subscription = preferredSubscription(
      subscriptions,
      this.now(),
    );
    if (!subscription) {
      throw new Error('BILLING_SUBSCRIPTION_NOT_FOUND');
    }
    return {
      url: await this.provider.customerPortal(
        subscription.providerSubscriptionId,
      ),
    };
  }

  async handleWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{
    status: 'processed' | 'duplicate' | 'ignored' | 'stale';
    eventName: string;
    accountId: string | null;
    planId: string | null;
  }> {
    const parsed = this.provider.parseWebhook(
      rawBody,
      signature,
    );

    if (parsed.kind === 'ignored') {
      return {
        status: 'ignored',
        eventName: parsed.eventName,
        accountId: null,
        planId: null,
      };
    }

    const duplicate =
      await this.billingStore.getWebhookEvent(
        'lemonsqueezy',
        parsed.eventHash,
      );
    if (duplicate) {
      return {
        status: 'duplicate',
        eventName: parsed.eventName,
        accountId: duplicate.accountId,
        planId: null,
      };
    }

    if (!parsed.planId) {
      throw new Error('BILLING_VARIANT_UNKNOWN');
    }

    const existing =
      await this.billingStore.getSubscription(
        'lemonsqueezy',
        parsed.providerSubscriptionId,
      );
    const accountId = boundedAccountId(
      existing?.accountId ??
        parsed.accountId ??
        '',
    );
    if (
      existing &&
      parsed.accountId &&
      parsed.accountId !== existing.accountId
    ) {
      throw new Error('BILLING_ACCOUNT_MISMATCH');
    }

    const account = await this.requireAccount(accountId);
    const receivedAt = this.now().toISOString();

    if (
      existing &&
      Date.parse(parsed.providerUpdatedAt) <=
        Date.parse(existing.providerUpdatedAt)
    ) {
      await this.billingStore.putWebhookEvent({
        provider: 'lemonsqueezy',
        eventHash: parsed.eventHash,
        eventName: parsed.eventName,
        providerObjectId:
          parsed.providerSubscriptionId,
        accountId,
        receivedAt,
        processedAt: receivedAt,
      });
      return {
        status: 'stale',
        eventName: parsed.eventName,
        accountId,
        planId: account.planId,
      };
    }

    const subscription: BillingSubscriptionRecord = {
      provider: 'lemonsqueezy',
      providerSubscriptionId:
        parsed.providerSubscriptionId,
      providerCustomerId: parsed.providerCustomerId,
      accountId,
      planId: parsed.planId,
      variantId: parsed.variantId,
      status: parsed.status,
      renewsAt: parsed.renewsAt,
      endsAt: parsed.endsAt,
      trialEndsAt: parsed.trialEndsAt,
      providerUpdatedAt: parsed.providerUpdatedAt,
      createdAt:
        existing?.createdAt ?? parsed.providerCreatedAt,
      updatedAt: receivedAt,
    };
    await this.billingStore.putSubscription(subscription);
    const effective = await this.applyEffectivePlan(account);

    await this.billingStore.putWebhookEvent({
      provider: 'lemonsqueezy',
      eventHash: parsed.eventHash,
      eventName: parsed.eventName,
      providerObjectId:
        parsed.providerSubscriptionId,
      accountId,
      receivedAt,
      processedAt: this.now().toISOString(),
    });

    return {
      status: 'processed',
      eventName: parsed.eventName,
      accountId,
      planId: effective.planId,
    };
  }

  private async applyEffectivePlan(
    accountInput: ProductAccountRecord,
  ): Promise<ProductAccountRecord> {
    const account = await this.requireAccount(accountInput.id);
    if (account.planId === 'custom') {
      return account;
    }

    const subscriptions =
      await this.billingStore.listSubscriptions(account.id);
    const selected = preferredSubscription(
      subscriptions.filter((subscription) =>
        entitlementActive(subscription, this.now()),
      ),
      this.now(),
    );
    const targetPlan = selected?.planId ?? null;

    if (!targetPlan) {
      if (
        account.planId === 'plus' ||
        account.planId === 'pro'
      ) {
        return await this.moveToFree(account);
      }
      return account;
    }

    const currentQuota =
      await this.controlStore.getQuotaSubject(
        account.quotaSubjectId,
      );
    let quotaSubjectId = account.quotaSubjectId;
    if (!currentQuota || currentQuota.kind !== 'subscription') {
      const now = this.now().toISOString();
      quotaSubjectId = 'quota_' + randomUUID();
      await this.controlStore.putQuotaSubject({
        id: quotaSubjectId,
        kind: 'subscription',
        createdAt: now,
        updatedAt: now,
      });
    }

    if (
      account.planId === targetPlan &&
      account.quotaSubjectId === quotaSubjectId &&
      account.customPlan === null
    ) {
      return account;
    }

    const updated: ProductAccountRecord = {
      ...account,
      quotaSubjectId,
      planId: targetPlan,
      customPlan: null,
      updatedAt: this.now().toISOString(),
    };
    await this.controlStore.putAccount(updated);
    return updated;
  }

  private async moveToFree(
    account: ProductAccountRecord,
  ): Promise<ProductAccountRecord> {
    const devices = await this.controlStore.listDevices(
      account.id,
    );
    const candidateIds = new Set<string>();

    for (const device of devices) {
      if (!device.deviceAnchorHash) continue;
      const anchor = await this.controlStore.getDeviceAnchor(
        device.deviceAnchorHash,
      );
      if (!anchor) continue;
      const quota =
        await this.controlStore.getQuotaSubject(
          anchor.quotaSubjectId,
        );
      if (quota?.kind === 'free-cluster') {
        candidateIds.add(quota.id);
      }
    }

    const ordered = [...candidateIds].sort();
    let targetId = ordered[0];
    if (!targetId) {
      const now = this.now().toISOString();
      targetId = 'quota_' + randomUUID();
      await this.controlStore.putQuotaSubject({
        id: targetId,
        kind: 'free-cluster',
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const sourceId of ordered.slice(1)) {
      await this.controlStore.mergeFreeQuotaSubjects(
        sourceId,
        targetId,
      );
    }

    const refreshed = await this.requireAccount(account.id);
    const updated: ProductAccountRecord = {
      ...refreshed,
      quotaSubjectId: targetId,
      planId: 'free',
      customPlan: null,
      updatedAt: this.now().toISOString(),
    };
    await this.controlStore.putAccount(updated);
    return updated;
  }

  private async requireAccount(
    accountId: string,
  ): Promise<ProductAccountRecord> {
    const id = boundedAccountId(accountId);
    const account = await this.controlStore.getAccount(id);
    if (!account) throw new Error('ACCOUNT_NOT_FOUND');
    return account;
  }
}
