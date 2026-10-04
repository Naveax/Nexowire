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
