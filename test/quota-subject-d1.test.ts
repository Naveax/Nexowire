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
      const results: D1ResultLike[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
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
  ]) {
    db.exec(
      readFileSync(
        path.join(process.cwd(), 'cloudflare', 'migrations', name),
        'utf8',
      ),
    );
  }
}

test('D1 quota subjects merge prior free usage for the same device anchor', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  try {
    const store = new D1ControlPlaneStore(
      new SqliteD1Database(db),
    );
    const service = new ControlPlaneService(store, {
      now: () => new Date('2026-10-02T12:00:00.000Z'),
    });
    const accountA = await service.ensureAccount({
      id: 'd1-account-a',
    });
    const accountB = await service.ensureAccount({
      id: 'd1-account-b',
    });

    await service.chargeUsage({
      accountId: accountA.id,
      eventId: 'd1-event-a',
      toolName: 'machine_health',
      baseCredits: 400,
    });
    await service.chargeUsage({
      accountId: accountB.id,
      eventId: 'd1-event-b',
      toolName: 'machine_health',
      baseCredits: 200,
    });

    const anchor = 'e'.repeat(64);
    for (const [account, deviceName] of [
      [accountA, 'd1-pc-a'],
      [accountB, 'd1-pc-b'],
    ] as const) {
      const pairing = await service.beginPairing(
        { accountId: account.id, role: 'user' },
        deviceName,
      );
      await service.consumePairing({
        pairingId: pairing.pairingId,
        token: pairing.token,
        platform: 'win32',
        deviceAnchorHash: anchor,
      });
    }

    const dashboardA = await service.dashboard({
      accountId: accountA.id,
      role: 'user',
    });
    const dashboardB = await service.dashboard({
      accountId: accountB.id,
      role: 'user',
    });
    assert.equal(dashboardA.usage.usedCredits, 600);
    assert.equal(dashboardB.usage.usedCredits, 600);

    const eventCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM quota_usage_events',
      )
      .get() as { count: number };
    assert.equal(Number(eventCount.count), 2);

    const overQuota = await service.chargeUsage({
      accountId: accountB.id,
      eventId: 'd1-event-c',
      toolName: 'machine_health',
      baseCredits: 401,
    });
    assert.equal(overQuota.status, 'denied');
    assert.equal(overQuota.remainingCredits, 400);
  } finally {
    db.close();
  }
});
