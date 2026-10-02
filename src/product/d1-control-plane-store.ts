import type {
  ControlPlaneStore,
  ProductAccountRecord,
  ProductDeviceRecord,
  ProductUsagePeriodRecord,
  UsageAggregate,
  UsageAtomicChargeInput,
  UsageAtomicChargeResult,
} from './control-plane-store.js';
import type { PairingRecord } from './pairing.js';
import type { CustomPlanInput, ProductPlanId } from './plans.js';

export interface D1ResultMetaLike {
  changes?: number;
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results?: T[];
  meta?: D1ResultMetaLike;
  success?: boolean;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike[]>;
}

type DbAccountRow = {
  id: string;
  display_name: string | null;
  plan_id: ProductPlanId;
  custom_plan_json: string | null;
  admin: number;
  created_at: string;
  updated_at: string;
};

type DbDeviceRow = {
  id: string;
  owner_account_id: string;
  name: string;
  platform: string;
  credential_hash: string;
  online: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbPairingRow = {
  id: string;
  owner_account_id: string;
  requested_device_name: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

type DbUsageRow = {
  account_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  used_credits: number;
  prepaid_credits: number;
};

function parseCustomPlan(
  raw: string | null,
): CustomPlanInput | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Stored custom plan JSON is invalid.');
  }
  return value as CustomPlanInput;
}

function accountFromRow(row: DbAccountRow): ProductAccountRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    planId: row.plan_id,
    customPlan: parseCustomPlan(row.custom_plan_json),
    admin: row.admin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deviceFromRow(row: DbDeviceRow): ProductDeviceRecord {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    name: row.name,
    platform: row.platform,
    credentialHash: row.credential_hash,
    online: row.online === 1,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pairingFromRow(row: DbPairingRow): PairingRecord {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    requestedDeviceName: row.requested_device_name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function usageFromRow(row: DbUsageRow): ProductUsagePeriodRecord {
  return {
    accountId: row.account_id,
    periodKey: row.period_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    usedCredits: row.used_credits,
    prepaidCredits: row.prepaid_credits,
  };
}

export class D1ControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getAccount(id: string): Promise<ProductAccountRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at FROM accounts WHERE id = ?',
      )
      .bind(id)
      .first<DbAccountRow>();
    return row ? accountFromRow(row) : null;
  }

  async putAccount(record: ProductAccountRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO accounts
          (id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           plan_id = excluded.plan_id,
           custom_plan_json = excluded.custom_plan_json,
           admin = excluded.admin,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.displayName,
        record.planId,
        record.customPlan === null
          ? null
          : JSON.stringify(record.customPlan),
        record.admin ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async listAccounts(): Promise<ProductAccountRecord[]> {
    const result = await this.db
      .prepare(
        'SELECT id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at FROM accounts ORDER BY created_at ASC',
      )
      .all<DbAccountRow>();
    return (result.results ?? []).map(accountFromRow);
  }

  async getDevice(id: string): Promise<ProductDeviceRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, owner_account_id, name, platform, credential_hash, online, last_seen_at, created_at, updated_at FROM devices WHERE id = ?',
      )
      .bind(id)
      .first<DbDeviceRow>();
    return row ? deviceFromRow(row) : null;
  }

  async putDevice(record: ProductDeviceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO devices
          (id, owner_account_id, name, platform, credential_hash, online, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_account_id = excluded.owner_account_id,
           name = excluded.name,
           platform = excluded.platform,
           credential_hash = excluded.credential_hash,
           online = excluded.online,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.ownerAccountId,
        record.name,
        record.platform,
        record.credentialHash,
        record.online ? 1 : 0,
        record.lastSeenAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async listDevices(
    ownerAccountId?: string,
  ): Promise<ProductDeviceRecord[]> {
    const statement =
      ownerAccountId === undefined
        ? this.db.prepare(
            'SELECT id, owner_account_id, name, platform, credential_hash, online, last_seen_at, created_at, updated_at FROM devices ORDER BY created_at ASC',
          )
        : this.db
            .prepare(
              'SELECT id, owner_account_id, name, platform, credential_hash, online, last_seen_at, created_at, updated_at FROM devices WHERE owner_account_id = ? ORDER BY created_at ASC',
            )
            .bind(ownerAccountId);
    const result = await statement.all<DbDeviceRow>();
    return (result.results ?? []).map(deviceFromRow);
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, owner_account_id, requested_device_name, token_hash, created_at, expires_at, consumed_at FROM pairings WHERE id = ?',
      )
      .bind(id)
      .first<DbPairingRow>();
    return row ? pairingFromRow(row) : null;
  }

  async putPairing(record: PairingRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pairings
          (id, owner_account_id, requested_device_name, token_hash, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           consumed_at = excluded.consumed_at`,
      )
      .bind(
        record.id,
        record.ownerAccountId,
        record.requestedDeviceName,
        record.tokenHash,
        record.createdAt,
        record.expiresAt,
        record.consumedAt,
      )
      .run();
  }

  async getUsagePeriod(
    accountId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT account_id, period_key, period_start, period_end, used_credits, prepaid_credits FROM usage_periods WHERE account_id = ? AND period_key = ?',
      )
      .bind(accountId, periodKey)
      .first<DbUsageRow>();
    return row ? usageFromRow(row) : null;
  }

  async chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult> {
    const eventLookup = () =>
      this.db
        .prepare(
          'SELECT event_id FROM usage_events WHERE account_id = ? AND period_key = ? AND event_id = ?',
        )
        .bind(input.accountId, input.periodKey, input.eventId)
        .first<{ event_id: string }>();

    if (await eventLookup()) {
      return {
        status: 'duplicate',
        record: await this.requireUsageRecord(input),
      };
    }

    try {
      await this.db
        .prepare(
          `INSERT INTO usage_events
            (account_id, period_key, event_id, credits, billing_mode, monthly_credits, period_start, period_end, charged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.accountId,
          input.periodKey,
          input.eventId,
          input.credits,
          input.billingMode,
          input.monthlyCredits,
          input.periodStart,
          input.periodEnd,
          input.chargedAt,
        )
        .run();

      return {
        status: 'charged',
        record: await this.requireUsageRecord(input),
      };
    } catch (error) {
      if (await eventLookup()) {
        return {
          status: 'duplicate',
          record: await this.requireUsageRecord(input),
        };
      }

      const message =
        error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('quota_exhausted')) {
        return {
          status: 'quota-exhausted',
          record: await this.requireUsageRecord(input),
        };
      }
      throw error;
    }
  }

  async setPrepaidCredits(
    accountId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord> {
    await this.db
      .prepare(
        `INSERT INTO usage_periods
          (account_id, period_key, period_start, period_end, used_credits, prepaid_credits)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(account_id, period_key) DO UPDATE SET
           prepaid_credits = excluded.prepaid_credits`,
      )
      .bind(
        accountId,
        periodKey,
        periodStart,
        periodEnd,
        credits,
      )
      .run();

    const row = await this.getUsagePeriod(accountId, periodKey);
    if (!row) throw new Error('D1 prepaid upsert did not persist.');
    return row;
  }

  async getUsageAggregate(now = new Date()): Promise<UsageAggregate> {
    const since24h = new Date(
      now.getTime() - 86_400_000,
    ).toISOString();
    const since30d = new Date(
      now.getTime() - 30 * 86_400_000,
    ).toISOString();

    const [row24, row30] = await Promise.all([
      this.db
        .prepare(
          'SELECT COUNT(*) AS count FROM usage_events WHERE charged_at >= ?',
        )
        .bind(since24h)
        .first<{ count: number }>(),
      this.db
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(credits), 0) AS credits FROM usage_events WHERE charged_at >= ?',
        )
        .bind(since30d)
        .first<{ count: number; credits: number }>(),
    ]);

    return {
      calls24h: row24?.count ?? 0,
      calls30d: row30?.count ?? 0,
      chargedCredits30d: row30?.credits ?? 0,
    };
  }

  private async requireUsageRecord(
    input: UsageAtomicChargeInput,
  ): Promise<ProductUsagePeriodRecord> {
    const record = await this.getUsagePeriod(
      input.accountId,
      input.periodKey,
    );
    if (record) return record;
    return {
      accountId: input.accountId,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      usedCredits: 0,
      prepaidCredits: 0,
    };
  }
}
