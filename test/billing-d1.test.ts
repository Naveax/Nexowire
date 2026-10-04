import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  type StatementSync,
} from 'node:sqlite';
import {
  D1ControlPlaneStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import { D1BillingStore } from '../src/product/d1-billing-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';

class SqliteD1Statement implements D1PreparedStatementLike {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteD1Statement(this.statement, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement.get(
      ...(this.values as Parameters<StatementSync['get']>),
    );
    return (row ?? null) as T | null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    return {
      success: true,
      results: this.statement.all(
        ...(this.values as Parameters<StatementSync['all']>),
      ) as T[],
    };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    const result = this.statement.run(
      ...(this.values as Parameters<StatementSync['run']>),
    );
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this.db.prepare(sql));
  }

  async batch(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike[]> {
    this.db.exec('BEGIN');
    try {
      const output: D1ResultLike[] = [];
      for (const statement of statements) {
        output.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return output;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(db: DatabaseSync): void {
  for (const name of [
    '0001_control_plane.sql',
    '0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql',
    '0004_device_credential_lookup.sql',
    '0005_mcp_oauth.sql',
    '0006_runtime_config.sql',
    '0007_billing_subscriptions.sql',
    '0008_prepaid_credit_balance.sql',
  ]) {
    db.exec(
      readFileSync(
        path.join(
          process.cwd(),
          'cloudflare',
          'migrations',
          name,
        ),
        'utf8',
      ),
    );
  }
}

test('D1 billing migration stores subscriptions and idempotent webhook metadata', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const control = new ControlPlaneService(
      new D1ControlPlaneStore(adapter),
      {
        now: () =>
          new Date('2026-10-04T12:00:00.000Z'),
      },
    );
    const billing = new D1BillingStore(adapter);
    const account = await control.ensureAccount({
      id: 'acct_d1_billing',
    });

    await billing.putSubscription({
      provider: 'lemonsqueezy',
      providerSubscriptionId: '7001',
      providerCustomerId: '8001',
      accountId: account.id,
      planId: 'plus',
      variantId: '2001',
      status: 'active',
      renewsAt: '2026-11-01T12:00:00.000Z',
      endsAt: null,
      trialEndsAt: null,
      providerUpdatedAt:
        '2026-10-04T12:00:00.000Z',
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-04T12:00:00.000Z',
    });

    const stored = await billing.getSubscription(
      'lemonsqueezy',
      '7001',
    );
    assert.equal(stored?.accountId, account.id);
    assert.equal(stored?.planId, 'plus');
    assert.equal(stored?.status, 'active');

    await billing.putSubscription({
      ...stored!,
      planId: 'pro',
      variantId: '2002',
      providerUpdatedAt:
        '2026-10-04T12:05:00.000Z',
      updatedAt: '2026-10-04T12:05:00.000Z',
    });
    assert.equal(
      (
        await billing.getSubscription(
          'lemonsqueezy',
          '7001',
        )
      )?.planId,
      'pro',
    );

    const event = {
      provider: 'lemonsqueezy' as const,
      eventHash: 'a'.repeat(64),
      eventName: 'subscription_updated',
      providerObjectId: '7001',
      accountId: account.id,
      receivedAt: '2026-10-04T12:05:01.000Z',
      processedAt: '2026-10-04T12:05:01.100Z',
    };
    await billing.putWebhookEvent(event);
    await billing.putWebhookEvent({
      ...event,
      eventName: 'should-not-overwrite',
    });

    const storedEvent = await billing.getWebhookEvent(
      'lemonsqueezy',
      event.eventHash,
    );
    assert.equal(
      storedEvent?.eventName,
      'subscription_updated',
    );

    const listed = await billing.listSubscriptions(
      account.id,
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.planId, 'pro');
  } finally {
    db.close();
  }
});

test('D1 prepaid balance carries across periods and credit events are idempotent', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const store = new D1ControlPlaneStore(adapter);
    const control = new ControlPlaneService(store, {
      now: () =>
        new Date('2026-10-04T12:00:00.000Z'),
    });
    const account = await control.ensureAccount({
      id: 'acct_prepaid_d1',
    });
    await store.putQuotaSubject({
      id: account.quotaSubjectId,
      kind: 'prepaid',
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });

    const firstCredit = await store.addPrepaidCreditsAtomic({
      quotaSubjectId: account.quotaSubjectId,
      eventId: 'order-1',
      credits: 10,
      creditedAt: '2026-10-04T12:00:00.000Z',
    });
    assert.equal(firstCredit.status, 'credited');
    assert.equal(firstCredit.prepaidCredits, 10);

    const duplicateCredit =
      await store.addPrepaidCreditsAtomic({
        quotaSubjectId: account.quotaSubjectId,
        eventId: 'order-1',
        credits: 10,
        creditedAt: '2026-10-04T12:00:01.000Z',
      });
    assert.equal(duplicateCredit.status, 'duplicate');
    assert.equal(duplicateCredit.prepaidCredits, 10);

    const october = await store.chargeUsageAtomic({
      quotaSubjectId: account.quotaSubjectId,
      periodKey: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      eventId: 'oct-use',
      credits: 3,
      billingMode: 'prepaid-metered',
      monthlyCredits: null,
      chargedAt: '2026-10-31T23:59:00.000Z',
    });
    assert.equal(october.status, 'charged');
    assert.equal(october.record.prepaidCredits, 7);

    const november = await store.chargeUsageAtomic({
      quotaSubjectId: account.quotaSubjectId,
      periodKey: '2026-11',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-12-01T00:00:00.000Z',
      eventId: 'nov-use',
      credits: 2,
      billingMode: 'prepaid-metered',
      monthlyCredits: null,
      chargedAt: '2026-11-01T00:01:00.000Z',
    });
    assert.equal(november.status, 'charged');
    assert.equal(november.record.prepaidCredits, 5);
    assert.equal(
      await store.getPrepaidCreditsBalance(
        account.quotaSubjectId,
      ),
      5,
    );
  } finally {
    db.close();
  }
});

test('D1 prepaid credit event ids are globally unique across quota subjects', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const store = new D1ControlPlaneStore(adapter);
    const control = new ControlPlaneService(store, {
      now: () =>
        new Date('2026-10-04T12:00:00.000Z'),
    });
    const accountA = await control.ensureAccount({
      id: 'acct_prepaid_event_a',
    });
    const accountB = await control.ensureAccount({
      id: 'acct_prepaid_event_b',
    });
    for (const account of [accountA, accountB]) {
      await store.putQuotaSubject({
        id: account.quotaSubjectId,
        kind: 'prepaid',
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });
    }

    await store.addPrepaidCreditsAtomic({
      quotaSubjectId: accountA.quotaSubjectId,
      eventId: 'lemonsqueezy:order:shared-order',
      credits: 100,
      creditedAt: '2026-10-04T12:00:00.000Z',
    });

    await assert.rejects(
      store.addPrepaidCreditsAtomic({
        quotaSubjectId: accountB.quotaSubjectId,
        eventId: 'lemonsqueezy:order:shared-order',
        credits: 100,
        creditedAt: '2026-10-04T12:00:01.000Z',
      }),
      /PREPAID_CREDIT_EVENT_MISMATCH/,
    );
    assert.equal(
      await store.getPrepaidCreditsBalance(
        accountA.quotaSubjectId,
      ),
      100,
    );
    assert.equal(
      await store.getPrepaidCreditsBalance(
        accountB.quotaSubjectId,
      ),
      0,
    );
  } finally {
    db.close();
  }
});

test('D1 prepaid refund atomically claws back balance, creates debt, and future top-up repays debt first', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const adapter = new SqliteD1Database(db);
    const store = new D1ControlPlaneStore(adapter);
    const control = new ControlPlaneService(store, {
      now: () =>
        new Date('2026-10-04T12:00:00.000Z'),
    });
    const account = await control.ensureAccount({
      id: 'acct_prepaid_refund_d1',
    });
    await store.putQuotaSubject({
      id: account.quotaSubjectId,
      kind: 'prepaid',
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });

    await store.addPrepaidCreditsAtomic({
      quotaSubjectId: account.quotaSubjectId,
      eventId: 'lemonsqueezy:order:9001',
      credits: 100_000,
      creditedAt: '2026-10-04T12:00:00.000Z',
    });
    await store.putPrepaidPurchase({
      provider: 'lemonsqueezy',
      providerOrderId: '9001',
      accountId: account.id,
      quotaSubjectId: account.quotaSubjectId,
      variantId: '3001',
      purchasedCredits: 100_000,
      totalAmount: 1000,
      refundedAmount: 0,
      revokedCredits: 0,
      providerUpdatedAt: '2026-10-04T12:00:00.000Z',
      createdAt: '2026-10-04T11:59:00.000Z',
      updatedAt: '2026-10-04T12:00:00.000Z',
    });

    const spent = await store.chargeUsageAtomic({
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

    const half = await store.applyPrepaidRefundAtomic({
      provider: 'lemonsqueezy',
      providerOrderId: '9001',
      refundedAmount: 500,
      targetRevokedCredits: 50_000,
      providerUpdatedAt: '2026-10-04T12:30:00.000Z',
      appliedAt: '2026-10-04T12:30:01.000Z',
    });
    assert.equal(half.status, 'applied');
    assert.equal(half.prepaidCredits, 0);
    assert.equal(half.refundDebtCredits, 30_000);
    assert.equal(half.purchase.refundedAmount, 500);
    assert.equal(half.purchase.revokedCredits, 50_000);

    const duplicate = await store.applyPrepaidRefundAtomic({
      provider: 'lemonsqueezy',
      providerOrderId: '9001',
      refundedAmount: 500,
      targetRevokedCredits: 50_000,
      providerUpdatedAt: '2026-10-04T12:30:00.000Z',
      appliedAt: '2026-10-04T12:31:00.000Z',
    });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.refundDebtCredits, 30_000);

    const blocked = await store.chargeUsageAtomic({
      quotaSubjectId: account.quotaSubjectId,
      periodKey: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      eventId: 'blocked-by-refund-debt',
      credits: 1,
      billingMode: 'prepaid-metered',
      monthlyCredits: null,
      chargedAt: '2026-10-04T12:32:00.000Z',
    });
    assert.equal(blocked.status, 'quota-exhausted');

    await store.addPrepaidCreditsAtomic({
      quotaSubjectId: account.quotaSubjectId,
      eventId: 'lemonsqueezy:order:9002',
      credits: 100_000,
      creditedAt: '2026-10-04T12:40:00.000Z',
    });
    assert.equal(
      await store.getPrepaidRefundDebt(
        account.quotaSubjectId,
      ),
      0,
    );
    assert.equal(
      await store.getPrepaidCreditsBalance(
        account.quotaSubjectId,
      ),
      70_000,
    );

    const full = await store.applyPrepaidRefundAtomic({
      provider: 'lemonsqueezy',
      providerOrderId: '9001',
      refundedAmount: 1000,
      targetRevokedCredits: 100_000,
      providerUpdatedAt: '2026-10-04T12:50:00.000Z',
      appliedAt: '2026-10-04T12:50:01.000Z',
    });
    assert.equal(full.status, 'applied');
    assert.equal(full.prepaidCredits, 20_000);
    assert.equal(full.refundDebtCredits, 0);
    assert.equal(full.purchase.refundedAmount, 1000);
    assert.equal(full.purchase.revokedCredits, 100_000);

    const stale = await store.applyPrepaidRefundAtomic({
      provider: 'lemonsqueezy',
      providerOrderId: '9001',
      refundedAmount: 750,
      targetRevokedCredits: 75_000,
      providerUpdatedAt: '2026-10-04T12:45:00.000Z',
      appliedAt: '2026-10-04T12:55:00.000Z',
    });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.prepaidCredits, 20_000);
    assert.equal(stale.refundDebtCredits, 0);
  } finally {
    db.close();
  }
});

test('D1 billing migration enforces supported provider, plan and status values', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO billing_subscriptions (
             provider, provider_subscription_id,
             provider_customer_id, account_id,
             plan_id, variant_id, status,
             provider_updated_at, created_at, updated_at
           ) VALUES (
             'stripe', '1', '2', 'missing',
             'plus', '3', 'active',
             '2026-10-04T12:00:00.000Z',
             '2026-10-04T12:00:00.000Z',
             '2026-10-04T12:00:00.000Z'
           )`,
        ),
      /CHECK constraint failed/i,
    );
  } finally {
    db.close();
  }
});
