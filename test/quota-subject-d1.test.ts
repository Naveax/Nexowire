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
    '0009_device_access_mode.sql',
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

test('isolated D1 Free quota enforces 999/1000 boundaries, 5x skills, replay and UTC reset', async () => {
  // All state lives in an in-memory SQLite fixture. Production D1 is untouched.
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  try {
    let clock = new Date('2026-10-31T23:59:59.000Z');
    const store = new D1ControlPlaneStore(new SqliteD1Database(db));
    const service = new ControlPlaneService(store, {
      freeOnly: true,
      now: () => clock,
    });
    const account = await service.ensureAccount({ id: 'isolated_d1_free_quota' });
    const charge = (eventId: string, toolName = 'machine_health', baseCredits = 1) =>
      service.chargeUsage({ accountId: account.id, eventId, toolName, baseCredits });

    const at999 = await charge('fill-october-999', 'machine_health', 999);
    assert.equal(at999.status, 'charged');
    assert.equal(at999.remainingCredits, 1);

    const skillOver = await charge('skill-too-large-october', 'skills_list');
    assert.equal(skillOver.status, 'denied');
    assert.equal(skillOver.reason, 'quota-exhausted');
    assert.equal(skillOver.remainingCredits, 1);

    const at1000 = await charge('fill-october-1000');
    assert.equal(at1000.status, 'charged');
    assert.equal(at1000.remainingCredits, 0);

    const replay = await charge('fill-october-1000');
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.chargedCredits, 0);

    const at1001 = await charge('blocked-october-1001');
    assert.equal(at1001.status, 'denied');
    assert.equal(at1001.reason, 'quota-exhausted');
    const october = await store.getUsagePeriod(account.quotaSubjectId, '2026-10');
    assert.equal(october?.usedCredits, 1_000);

    clock = new Date('2026-11-01T00:00:00.000Z');
    const firstSkill = await charge('november-special-skill', 'skill_read');
    assert.equal(firstSkill.status, 'charged');
    assert.equal(firstSkill.chargedCredits, 5);
    assert.equal(firstSkill.remainingCredits, 995);

    const at999Again = await charge('fill-november-999', 'machine_health', 994);
    assert.equal(at999Again.status, 'charged');
    assert.equal(at999Again.remainingCredits, 1);

    // Concurrent callers share one SQLite ledger; the D1 schema trigger must
    // permit only one final credit. This models contention, not live WAN proof.
    const raced = await Promise.all(
      Array.from({ length: 8 }, (_, index) => charge('race-' + index)),
    );
    assert.equal(raced.filter((result) => result.status === 'charged').length, 1);
    assert.equal(raced.filter((result) => result.status === 'denied').length, 7);
    const november = await store.getUsagePeriod(account.quotaSubjectId, '2026-11');
    assert.equal(november?.usedCredits, 1_000);
    assert.equal(october?.usedCredits, 1_000);
  } finally {
    db.close();
  }
});

test('D1-backed verified owner remains unmetered past Free quota; other accounts remain limited', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  try {
    const store = new D1ControlPlaneStore(new SqliteD1Database(db));
    const service = new ControlPlaneService(store, {
      freeOnly: true,
      ownerGithubId: '79841922',
      now: () => new Date('2026-10-07T01:20:00.000Z'),
    });
    const { account: owner } = await service.loginExternalIdentity({
      provider: 'github', subject: '79841922',
    });
    const other = await service.ensureAccount({ id: 'not-the-owner' });
    const charged = await service.chargeUsage({
      accountId: owner.id, eventId: 'd1-owner-1500',
      toolName: 'machine_health', baseCredits: 1_500,
    });
    assert.equal(charged.status, 'charged');
    assert.equal(charged.remainingCredits, null);
    const replay = await service.chargeUsage({
      accountId: owner.id, eventId: 'd1-owner-1500', toolName: 'machine_health',
    });
    assert.equal(replay.status, 'duplicate');
    const ownerUsage = await store.getUsagePeriod(owner.quotaSubjectId, '2026-10');
    assert.equal(ownerUsage?.usedCredits, 1_500);
    const exhausted = await service.chargeUsage({
      accountId: other.id, eventId: 'd1-other-1500',
      toolName: 'machine_health', baseCredits: 1_500,
    });
    assert.equal(exhausted.status, 'denied');
    assert.equal(exhausted.reason, 'quota-exhausted');
    const otherUsage = await store.getUsagePeriod(other.quotaSubjectId, '2026-10');
    assert.equal(otherUsage?.usedCredits ?? 0, 0);
  } finally {
    db.close();
  }
});
