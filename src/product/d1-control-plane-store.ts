import type {
  ControlPlaneStore,
  DeviceAnchorRecord,
  DeviceFolderRecord,
  DeviceFolderAssignmentRecord,
  ExternalIdentityRecord,
  ProductAccountRecord,
  ProductDeviceRecord,
  RootModeLeaseRecord,
  DeviceMaintenancePreferenceRecord,
  DeviceBridgePreferenceRecord,
  BridgeCommandRecord,
  BridgeQueuedCommand,
  ProductQuotaSubjectRecord,
  ProductUsagePeriodRecord,
  PrepaidCreditInput,
  PrepaidCreditResult,
  PrepaidPurchaseRecord,
  PrepaidRefundInput,
  PrepaidRefundResult,
  UsageAggregate,
  UsageAtomicChargeInput,
  UsageAtomicChargeResult,
} from './control-plane-store.js';
import type { PairingRecord } from './pairing.js';
import { isValidBridgeQueuedCommand, isCanonicalBridgeTimestamp } from './bridge-command-ledger.js';
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

type DbQuotaSubjectRow = {
  id: string;
  kind: 'free-cluster' | 'subscription' | 'prepaid';
  created_at: string;
  updated_at: string;
};

type DbDeviceAnchorRow = {
  anchor_hash: string;
  quota_subject_id: string;
  created_at: string;
  last_seen_at: string;
};

type DbAccountRow = {
  id: string;
  quota_subject_id: string;
  display_name: string | null;
  plan_id: ProductPlanId;
  custom_plan_json: string | null;
  admin: number;
  created_at: string;
  updated_at: string;
};

type DbIdentityRow = {
  provider: string;
  subject: string;
  account_id: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  last_login_at: string;
};

type DbDeviceRow = {
  id: string;
  owner_account_id: string;
  device_anchor_hash: string | null;
  name: string;
  platform: string;
  credential_hash: string;
  access_mode: 'safe' | 'full';
  agent_version: string | null;
  privilege_mode: 'direct' | 'broker' | null;
  admin_bridge_ready: number | null;
  online: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbPairingRow = {
  id: string;
  owner_account_id: string;
  requested_device_id: string | null;
  requested_device_name: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

type DbUsageRow = {
  quota_subject_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  used_credits: number;
  prepaid_credits: number;
};

type DbPrepaidPurchaseRow = {
  provider: string;
  provider_order_id: string;
  account_id: string;
  quota_subject_id: string;
  variant_id: string;
  purchased_credits: number;
  total_amount: number;
  refunded_amount: number;
  revoked_credits: number;
  provider_updated_at: string;
  created_at: string;
  updated_at: string;
};

function prepaidPurchaseFromRow(
  row: DbPrepaidPurchaseRow,
): PrepaidPurchaseRecord {
  return {
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    accountId: row.account_id,
    quotaSubjectId: row.quota_subject_id,
    variantId: row.variant_id,
    purchasedCredits: row.purchased_credits,
    totalAmount: row.total_amount,
    refundedAmount: row.refunded_amount,
    revokedCredits: row.revoked_credits,
    providerUpdatedAt: row.provider_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
    quotaSubjectId: row.quota_subject_id,
    displayName: row.display_name,
    planId: row.plan_id,
    customPlan: parseCustomPlan(row.custom_plan_json),
    admin: row.admin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identityFromRow(
  row: DbIdentityRow,
): ExternalIdentityRecord {
  return {
    provider: row.provider,
    subject: row.subject,
    accountId: row.account_id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function deviceFromRow(row: DbDeviceRow): ProductDeviceRecord {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    deviceAnchorHash: row.device_anchor_hash,
    name: row.name,
    platform: row.platform,
    credentialHash: row.credential_hash,
    accessMode: row.access_mode,
    agentVersion: row.agent_version,
    privilegeMode: row.privilege_mode,
    adminBridgeReady:
      row.admin_bridge_ready === null
        ? null
        : row.admin_bridge_ready === 1,
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
    requestedDeviceId: row.requested_device_id,
    requestedDeviceName: row.requested_device_name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function usageFromRow(row: DbUsageRow): ProductUsagePeriodRecord {
  return {
    quotaSubjectId: row.quota_subject_id,
    periodKey: row.period_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    usedCredits: row.used_credits,
    prepaidCredits: row.prepaid_credits,
  };
}

export class D1ControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getQuotaSubject(
    id: string,
  ): Promise<ProductQuotaSubjectRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, kind, created_at, updated_at FROM quota_subjects WHERE id = ?',
      )
      .bind(id)
      .first<DbQuotaSubjectRow>();
    return row
      ? {
          id: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async putQuotaSubject(
    record: ProductQuotaSubjectRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO quota_subjects
          (id, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.kind,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async getDeviceAnchor(
    anchorHash: string,
  ): Promise<DeviceAnchorRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT anchor_hash, quota_subject_id, created_at, last_seen_at FROM device_anchors WHERE anchor_hash = ?',
      )
      .bind(anchorHash)
      .first<DbDeviceAnchorRow>();
    return row
      ? {
          anchorHash: row.anchor_hash,
          quotaSubjectId: row.quota_subject_id,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
        }
      : null;
  }

  async putDeviceAnchor(
    record: DeviceAnchorRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO device_anchors
          (anchor_hash, quota_subject_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(anchor_hash) DO UPDATE SET
           quota_subject_id = excluded.quota_subject_id,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        record.anchorHash,
        record.quotaSubjectId,
        record.createdAt,
        record.lastSeenAt,
      )
      .run();
  }

  async mergeFreeQuotaSubjects(
    sourceQuotaSubjectId: string,
    targetQuotaSubjectId: string,
  ): Promise<void> {
    if (sourceQuotaSubjectId === targetQuotaSubjectId) return;

    const [source, target] = await Promise.all([
      this.getQuotaSubject(sourceQuotaSubjectId),
      this.getQuotaSubject(targetQuotaSubjectId),
    ]);
    if (!source || !target) {
      throw new Error('QUOTA_SUBJECT_NOT_FOUND');
    }
    if (
      source.kind !== 'free-cluster' ||
      target.kind !== 'free-cluster'
    ) {
      throw new Error('QUOTA_SUBJECT_MERGE_NOT_FREE');
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO quota_usage_periods
            (quota_subject_id, period_key, period_start, period_end, used_credits, prepaid_credits)
           SELECT ?, period_key, period_start, period_end, used_credits, prepaid_credits
           FROM quota_usage_periods
           WHERE quota_subject_id = ?
           ON CONFLICT(quota_subject_id, period_key) DO UPDATE SET
             used_credits = quota_usage_periods.used_credits + excluded.used_credits,
             prepaid_credits = quota_usage_periods.prepaid_credits + excluded.prepaid_credits`,
        )
        .bind(targetQuotaSubjectId, sourceQuotaSubjectId),
      this.db
        .prepare(
          'DELETE FROM quota_usage_periods WHERE quota_subject_id = ?',
        )
        .bind(sourceQuotaSubjectId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO quota_usage_events
            (quota_subject_id, period_key, event_id, credits, billing_mode, monthly_credits, period_start, period_end, charged_at, apply_usage)
           SELECT ?, period_key, event_id, credits, billing_mode, monthly_credits, period_start, period_end, charged_at, 0
           FROM quota_usage_events
           WHERE quota_subject_id = ?`,
        )
        .bind(targetQuotaSubjectId, sourceQuotaSubjectId),
      this.db
        .prepare(
          'DELETE FROM quota_usage_events WHERE quota_subject_id = ?',
        )
        .bind(sourceQuotaSubjectId),
      this.db
        .prepare(
          'UPDATE accounts SET quota_subject_id = ? WHERE quota_subject_id = ?',
        )
        .bind(targetQuotaSubjectId, sourceQuotaSubjectId),
      this.db
        .prepare(
          'UPDATE device_anchors SET quota_subject_id = ? WHERE quota_subject_id = ?',
        )
        .bind(targetQuotaSubjectId, sourceQuotaSubjectId),
      this.db
        .prepare(
          'DELETE FROM quota_subjects WHERE id = ?',
        )
        .bind(sourceQuotaSubjectId),
    ]);
  }

  async getAccount(id: string): Promise<ProductAccountRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, quota_subject_id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at FROM accounts WHERE id = ?',
      )
      .bind(id)
      .first<DbAccountRow>();
    return row ? accountFromRow(row) : null;
  }

  async putAccount(record: ProductAccountRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO accounts
          (id, quota_subject_id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           quota_subject_id = excluded.quota_subject_id,
           display_name = excluded.display_name,
           plan_id = excluded.plan_id,
           custom_plan_json = excluded.custom_plan_json,
           admin = excluded.admin,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.quotaSubjectId,
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
        'SELECT id, quota_subject_id, display_name, plan_id, custom_plan_json, admin, created_at, updated_at FROM accounts ORDER BY created_at ASC',
      )
      .all<DbAccountRow>();
    return (result.results ?? []).map(accountFromRow);
  }

  async getExternalIdentity(
    provider: string,
    subject: string,
  ): Promise<ExternalIdentityRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT provider, subject, account_id, display_name, email, created_at, last_login_at FROM external_identities WHERE provider = ? AND subject = ?',
      )
      .bind(provider, subject)
      .first<DbIdentityRow>();
    return row ? identityFromRow(row) : null;
  }

  async putExternalIdentity(
    record: ExternalIdentityRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO external_identities
          (provider, subject, account_id, display_name, email, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, subject) DO UPDATE SET
           account_id = excluded.account_id,
           display_name = excluded.display_name,
           email = excluded.email,
           last_login_at = excluded.last_login_at`,
      )
      .bind(
        record.provider,
        record.subject,
        record.accountId,
        record.displayName,
        record.email,
        record.createdAt,
        record.lastLoginAt,
      )
      .run();
  }

  async getDevice(id: string): Promise<ProductDeviceRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, owner_account_id, device_anchor_hash, name, platform, credential_hash, access_mode, agent_version, privilege_mode, admin_bridge_ready, online, last_seen_at, created_at, updated_at FROM devices WHERE id = ?',
      )
      .bind(id)
      .first<DbDeviceRow>();
    return row ? deviceFromRow(row) : null;
  }

  async getDeviceByCredentialHash(
    credentialHash: string,
  ): Promise<ProductDeviceRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, owner_account_id, device_anchor_hash, name, platform, credential_hash, access_mode, agent_version, privilege_mode, admin_bridge_ready, online, last_seen_at, created_at, updated_at FROM devices WHERE credential_hash = ?',
      )
      .bind(credentialHash)
      .first<DbDeviceRow>();
    return row ? deviceFromRow(row) : null;
  }

  async putDevice(record: ProductDeviceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO devices
          (id, owner_account_id, device_anchor_hash, name, platform, credential_hash, access_mode, agent_version, privilege_mode, admin_bridge_ready, online, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_account_id = excluded.owner_account_id,
           device_anchor_hash = excluded.device_anchor_hash,
           name = excluded.name,
           platform = excluded.platform,
           credential_hash = excluded.credential_hash,
           access_mode = excluded.access_mode,
           agent_version = excluded.agent_version,
           privilege_mode = excluded.privilege_mode,
           admin_bridge_ready = excluded.admin_bridge_ready,
           online = excluded.online,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.ownerAccountId,
        record.deviceAnchorHash,
        record.name,
        record.platform,
        record.credentialHash,
        record.accessMode,
        record.agentVersion,
        record.privilegeMode,
        record.adminBridgeReady === null
          ? null
          : record.adminBridgeReady
            ? 1
            : 0,
        record.online ? 1 : 0,
        record.lastSeenAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async getRootModeLease(deviceId: string): Promise<RootModeLeaseRecord | null> {
    const row = await this.db.prepare(
      'SELECT device_id, owner_account_id, expires_at, updated_at FROM device_root_mode_leases WHERE device_id = ?',
    ).bind(deviceId).first<{
      device_id: string;
      owner_account_id: string;
      expires_at: string;
      updated_at: string;
    }>();
    return row ? {
      deviceId: row.device_id,
      ownerAccountId: row.owner_account_id,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async putRootModeLease(record: RootModeLeaseRecord): Promise<void> {
    await this.db.prepare(
      'INSERT INTO device_root_mode_leases (device_id, owner_account_id, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET owner_account_id = excluded.owner_account_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at',
    ).bind(record.deviceId, record.ownerAccountId, record.expiresAt, record.updatedAt).run();
  }

  async getDeviceMaintenancePreference(deviceId: string): Promise<DeviceMaintenancePreferenceRecord | null> {
    const row = await this.db.prepare(
      'SELECT device_id, owner_account_id, enabled, updated_at FROM device_maintenance_preferences WHERE device_id = ?',
    ).bind(deviceId).first<{ device_id: string; owner_account_id: string; enabled: number; updated_at: string }>();
    return row ? {
      deviceId: row.device_id,
      ownerAccountId: row.owner_account_id,
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    } : null;
  }

  async putDeviceMaintenancePreference(record: DeviceMaintenancePreferenceRecord): Promise<void> {
    await this.db.prepare(
      'INSERT INTO device_maintenance_preferences (device_id, owner_account_id, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET owner_account_id = excluded.owner_account_id, enabled = excluded.enabled, updated_at = excluded.updated_at',
    ).bind(record.deviceId, record.ownerAccountId, record.enabled ? 1 : 0, record.updatedAt).run();
  }

  async getDeviceBridgePreference(deviceId: string): Promise<DeviceBridgePreferenceRecord | null> {
    const row = await this.db.prepare(
      'SELECT device_id, owner_account_id, desired_mode, updated_at FROM device_bridge_preferences WHERE device_id = ?',
    ).bind(deviceId).first<{ device_id: string; owner_account_id: string; desired_mode: string; updated_at: string }>();
    const desiredMode = row?.desired_mode;
    if (!row || (desiredMode !== 'auto' && desiredMode !== 'on' && desiredMode !== 'off')) return null;
    return { deviceId: row.device_id, ownerAccountId: row.owner_account_id, desiredMode, updatedAt: row.updated_at };
  }

  async putDeviceBridgePreference(record: DeviceBridgePreferenceRecord): Promise<void> {
    await this.db.prepare(
      'INSERT INTO device_bridge_preferences (device_id, owner_account_id, desired_mode, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET owner_account_id = excluded.owner_account_id, desired_mode = excluded.desired_mode, updated_at = excluded.updated_at',
    ).bind(record.deviceId, record.ownerAccountId, record.desiredMode, record.updatedAt).run();
  }

  async queueBridgeCommand(record: BridgeQueuedCommand): Promise<boolean> {
    if (!isValidBridgeQueuedCommand(record)) return false;
    const result = await this.db.prepare(
      `INSERT INTO device_bridge_commands
        (request_id,device_id,owner_account_id,credential_binding,preference_revision,desired_mode,issued_at,expires_at,status)
       SELECT ?,d.id,d.owner_account_id,d.credential_hash,
         (SELECT e.id FROM device_bridge_preference_events e
           WHERE e.device_id=d.id ORDER BY e.rowid DESC LIMIT 1),?,?,?,'queued'
       FROM devices d
       WHERE d.id=? AND d.owner_account_id=? AND d.credential_hash=?
         AND EXISTS (SELECT 1 FROM device_bridge_preferences p
           WHERE p.device_id=d.id AND p.owner_account_id=d.owner_account_id
             AND p.desired_mode=? AND p.updated_at<=?)
       ON CONFLICT(request_id) DO NOTHING`,
    ).bind(
      record.requestId, record.desiredMode, record.issuedAt,
      record.expiresAt, record.deviceId, record.ownerAccountId,
      record.credentialBinding, record.desiredMode, record.issuedAt,
    ).run();
    return result.meta?.changes === 1;
  }

  async getBridgeCommand(requestId: string): Promise<BridgeCommandRecord | null> {
    const row = await this.db.prepare(
      `SELECT request_id,device_id,owner_account_id,credential_binding,preference_revision,desired_mode,
       issued_at,expires_at,status,claimed_at,completed_at,failure_code
       FROM device_bridge_commands WHERE request_id=?`,
    ).bind(requestId).first<{
      request_id: string; device_id: string; owner_account_id: string;
      credential_binding: string; preference_revision: string;
      desired_mode: BridgeCommandRecord['desiredMode'];
      issued_at: string; expires_at: string; status: BridgeCommandRecord['status'];
      claimed_at: string | null; completed_at: string | null; failure_code: string | null;
    }>();
    return row ? {
      requestId:row.request_id,deviceId:row.device_id,
      ownerAccountId:row.owner_account_id,credentialBinding:row.credential_binding,
      preferenceRevision:row.preference_revision,
      desiredMode:row.desired_mode,issuedAt:row.issued_at,expiresAt:row.expires_at,
      status:row.status,claimedAt:row.claimed_at,
      completedAt:row.completed_at,failureCode:row.failure_code,
    } : null;
  }

  async claimBridgeCommand(
    requestId: string, deviceId: string, credentialBinding: string, at: string,
  ): Promise<boolean> {
    if (!isCanonicalBridgeTimestamp(at)) return false;
    const result = await this.db.prepare(
      `UPDATE device_bridge_commands SET status='claimed',claimed_at=?
       WHERE request_id=? AND device_id=? AND credential_binding=?
         AND status='queued' AND issued_at<=? AND expires_at>?
         AND EXISTS (
           SELECT 1 FROM devices d WHERE d.id=device_bridge_commands.device_id
             AND d.owner_account_id=device_bridge_commands.owner_account_id
             AND d.credential_hash=device_bridge_commands.credential_binding
         )
         AND EXISTS (SELECT 1 FROM device_bridge_preferences p
           WHERE p.device_id=device_bridge_commands.device_id
             AND p.owner_account_id=device_bridge_commands.owner_account_id
             AND p.desired_mode=device_bridge_commands.desired_mode
             AND p.updated_at<=device_bridge_commands.issued_at
             AND (SELECT e.id FROM device_bridge_preference_events e
               WHERE e.device_id=device_bridge_commands.device_id
               ORDER BY e.rowid DESC LIMIT 1)=device_bridge_commands.preference_revision)`,
    ).bind(at,requestId,deviceId,credentialBinding,at,at).run();
    return result.meta?.changes === 1;
  }

  async completeBridgeCommand(
    requestId: string, deviceId: string, credentialBinding: string,
    result: 'applied' | 'failed', at: string, failureCode: string | null,
  ): Promise<boolean> {
    if (!isCanonicalBridgeTimestamp(at) ||
        (result !== 'applied' && result !== 'failed') ||
        (result === 'applied' && failureCode !== null) ||
        (result === 'failed' && !/^[A-Z0-9_]{1,80}$/.test(failureCode ?? ''))) {
      return false;
    }
    const update = await this.db.prepare(
      `UPDATE device_bridge_commands SET
         status=?,completed_at=?,failure_code=?
       WHERE request_id=? AND device_id=? AND credential_binding=?
         AND status='claimed' AND claimed_at<=? AND expires_at>?
         AND EXISTS (
           SELECT 1 FROM devices d WHERE d.id=device_bridge_commands.device_id
             AND d.owner_account_id=device_bridge_commands.owner_account_id
             AND d.credential_hash=device_bridge_commands.credential_binding
         )
         AND EXISTS (SELECT 1 FROM device_bridge_preferences p
           WHERE p.device_id=device_bridge_commands.device_id
             AND p.owner_account_id=device_bridge_commands.owner_account_id
             AND p.desired_mode=device_bridge_commands.desired_mode
             AND p.updated_at<=device_bridge_commands.issued_at
             AND (SELECT e.id FROM device_bridge_preference_events e
               WHERE e.device_id=device_bridge_commands.device_id
               ORDER BY e.rowid DESC LIMIT 1)=device_bridge_commands.preference_revision)`,
    ).bind(
      result,at,failureCode,requestId,deviceId,credentialBinding,at,at,
    ).run();
    return update.meta?.changes === 1;
  }

  async listDevices(
    ownerAccountId?: string,
  ): Promise<ProductDeviceRecord[]> {
    const statement =
      ownerAccountId === undefined
        ? this.db.prepare(
            'SELECT id, owner_account_id, device_anchor_hash, name, platform, credential_hash, access_mode, agent_version, privilege_mode, admin_bridge_ready, online, last_seen_at, created_at, updated_at FROM devices ORDER BY created_at ASC',
          )
        : this.db
            .prepare(
              'SELECT id, owner_account_id, device_anchor_hash, name, platform, credential_hash, access_mode, agent_version, privilege_mode, admin_bridge_ready, online, last_seen_at, created_at, updated_at FROM devices WHERE owner_account_id = ? ORDER BY created_at ASC',
            )
            .bind(ownerAccountId);
    const result = await statement.all<DbDeviceRow>();
    return (result.results ?? []).map(deviceFromRow);
  }

  async getAutoDeviceSelection(ownerAccountId: string): Promise<boolean> {
    const row = await this.db.prepare(
      'SELECT enabled FROM owner_device_selection_settings WHERE owner_account_id = ?',
    ).bind(ownerAccountId).first<{enabled: number}>();
    return row?.enabled === 1;
  }

  async putAutoDeviceSelection(ownerAccountId: string, enabled: boolean): Promise<void> {
    await this.db.prepare(
      'INSERT INTO owner_device_selection_settings(owner_account_id, enabled) VALUES(?, ?) ON CONFLICT(owner_account_id) DO UPDATE SET enabled = excluded.enabled',
    ).bind(ownerAccountId, enabled ? 1 : 0).run();
  }

  async listDeviceFolders(ownerAccountId: string): Promise<DeviceFolderRecord[]> {
    const result = await this.db.prepare(
      'SELECT id, owner_account_id, name, created_at FROM device_folders WHERE owner_account_id = ? ORDER BY name COLLATE NOCASE',
    ).bind(ownerAccountId).all<{id:string;owner_account_id:string;name:string;created_at:string}>();
    return (result.results ?? []).map(row => ({
      id: row.id, ownerAccountId: row.owner_account_id, name: row.name, createdAt: row.created_at,
    }));
  }

  async listDeviceFolderAssignments(ownerAccountId: string): Promise<DeviceFolderAssignmentRecord[]> {
    const result = await this.db.prepare(
      'SELECT a.device_id, a.folder_id FROM device_folder_assignments a JOIN devices d ON d.id = a.device_id JOIN device_folders f ON f.id = a.folder_id WHERE d.owner_account_id = ? AND f.owner_account_id = ?',
    ).bind(ownerAccountId, ownerAccountId).all<{device_id:string;folder_id:string}>();
    return (result.results ?? []).map(row => ({deviceId: row.device_id, folderId: row.folder_id}));
  }

  async putDeviceFolder(record: DeviceFolderRecord): Promise<void> {
    await this.db.prepare(
      'INSERT INTO device_folders(id, owner_account_id, name, created_at) VALUES (?, ?, ?, ?)',
    ).bind(record.id, record.ownerAccountId, record.name, record.createdAt).run();
  }

  async deleteDeviceFolder(ownerAccountId: string, folderId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM device_folders WHERE id = ? AND owner_account_id = ?',
    ).bind(folderId, ownerAccountId).run();
  }

  async assignDeviceFolder(deviceId: string, folderId: string | null): Promise<void> {
    if (folderId === null) {
      await this.db.prepare('DELETE FROM device_folder_assignments WHERE device_id = ?').bind(deviceId).run();
    } else {
      await this.db.prepare(
        'INSERT INTO device_folder_assignments(device_id, folder_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET folder_id = excluded.folder_id',
      ).bind(deviceId, folderId).run();
    }
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT id, owner_account_id, requested_device_id, requested_device_name, token_hash, created_at, expires_at, consumed_at FROM pairings WHERE id = ?',
      )
      .bind(id)
      .first<DbPairingRow>();
    return row ? pairingFromRow(row) : null;
  }

  async putPairing(record: PairingRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pairings
          (id, owner_account_id, requested_device_id, requested_device_name, token_hash, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           requested_device_id = excluded.requested_device_id,
           consumed_at = excluded.consumed_at`,
      )
      .bind(
        record.id,
        record.ownerAccountId,
        record.requestedDeviceId,
        record.requestedDeviceName,
        record.tokenHash,
        record.createdAt,
        record.expiresAt,
        record.consumedAt,
      )
      .run();
  }

  async getUsagePeriod(
    quotaSubjectId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT quota_subject_id, period_key, period_start, period_end, used_credits, prepaid_credits FROM quota_usage_periods WHERE quota_subject_id = ? AND period_key = ?',
      )
      .bind(quotaSubjectId, periodKey)
      .first<DbUsageRow>();
    return row ? usageFromRow(row) : null;
  }

  async chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult> {
    const eventLookup = () =>
      this.db
        .prepare(
          'SELECT event_id FROM quota_usage_events WHERE quota_subject_id = ? AND period_key = ? AND event_id = ?',
        )
        .bind(
          input.quotaSubjectId,
          input.periodKey,
          input.eventId,
        )
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
          `INSERT INTO quota_usage_events
            (quota_subject_id, period_key, event_id, credits, billing_mode, monthly_credits, period_start, period_end, charged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.quotaSubjectId,
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
    quotaSubjectId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO prepaid_credit_balances
            (quota_subject_id, prepaid_credits, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(quota_subject_id) DO UPDATE SET
             prepaid_credits = excluded.prepaid_credits,
             updated_at = excluded.updated_at`,
        )
        .bind(quotaSubjectId, credits, now),
      this.db
        .prepare(
          `INSERT INTO quota_usage_periods
            (quota_subject_id, period_key, period_start, period_end, used_credits, prepaid_credits)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(quota_subject_id, period_key) DO UPDATE SET
             prepaid_credits = excluded.prepaid_credits`,
        )
        .bind(
          quotaSubjectId,
          periodKey,
          periodStart,
          periodEnd,
          credits,
        ),
    ]);

    const row = await this.getUsagePeriod(
      quotaSubjectId,
      periodKey,
    );
    if (!row) throw new Error('D1 prepaid upsert did not persist.');
    return row;
  }

  async getPrepaidCreditsBalance(
    quotaSubjectId: string,
  ): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT prepaid_credits FROM prepaid_credit_balances WHERE quota_subject_id = ?',
      )
      .bind(quotaSubjectId)
      .first<{ prepaid_credits: number }>();
    return row?.prepaid_credits ?? 0;
  }

  async getPrepaidRefundDebt(
    quotaSubjectId: string,
  ): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT refund_debt_credits FROM prepaid_credit_balances WHERE quota_subject_id = ?',
      )
      .bind(quotaSubjectId)
      .first<{ refund_debt_credits: number }>();
    return row?.refund_debt_credits ?? 0;
  }

  async addPrepaidCreditsAtomic(
    input: PrepaidCreditInput,
  ): Promise<PrepaidCreditResult> {
    const eventLookup = () =>
      this.db
        .prepare(
          'SELECT quota_subject_id FROM prepaid_credit_events WHERE event_id = ?',
        )
        .bind(input.eventId)
        .first<{ quota_subject_id: string }>();

    const existingEvent = await eventLookup();
    if (existingEvent) {
      if (existingEvent.quota_subject_id !== input.quotaSubjectId) {
        throw new Error('PREPAID_CREDIT_EVENT_MISMATCH');
      }
      return {
        status: 'duplicate',
        prepaidCredits:
          await this.getPrepaidCreditsBalance(
            input.quotaSubjectId,
          ),
      };
    }

    try {
      await this.db
        .prepare(
          `INSERT INTO prepaid_credit_events
            (quota_subject_id, event_id, credits, credited_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          input.quotaSubjectId,
          input.eventId,
          input.credits,
          input.creditedAt,
        )
        .run();
      return {
        status: 'credited',
        prepaidCredits:
          await this.getPrepaidCreditsBalance(
            input.quotaSubjectId,
          ),
      };
    } catch (error) {
      const racedEvent = await eventLookup();
      if (racedEvent) {
        if (racedEvent.quota_subject_id !== input.quotaSubjectId) {
          throw new Error('PREPAID_CREDIT_EVENT_MISMATCH');
        }
        return {
          status: 'duplicate',
          prepaidCredits:
            await this.getPrepaidCreditsBalance(
              input.quotaSubjectId,
            ),
        };
      }
      throw error;
    }
  }

  async getPrepaidPurchase(
    provider: string,
    providerOrderId: string,
  ): Promise<PrepaidPurchaseRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, provider_order_id, account_id,
                quota_subject_id, variant_id, purchased_credits,
                total_amount, refunded_amount, revoked_credits,
                provider_updated_at, created_at, updated_at
         FROM prepaid_purchases
         WHERE provider = ? AND provider_order_id = ?`,
      )
      .bind(provider, providerOrderId)
      .first<DbPrepaidPurchaseRow>();
    return row ? prepaidPurchaseFromRow(row) : null;
  }

  async putPrepaidPurchase(
    record: PrepaidPurchaseRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO prepaid_purchases (
           provider, provider_order_id, account_id,
           quota_subject_id, variant_id, purchased_credits,
           total_amount, refunded_amount, revoked_credits,
           provider_updated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.provider,
        record.providerOrderId,
        record.accountId,
        record.quotaSubjectId,
        record.variantId,
        record.purchasedCredits,
        record.totalAmount,
        record.refundedAmount,
        record.revokedCredits,
        record.providerUpdatedAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async applyPrepaidRefundAtomic(
    input: PrepaidRefundInput,
  ): Promise<PrepaidRefundResult> {
    const current = await this.getPrepaidPurchase(
      input.provider,
      input.providerOrderId,
    );
    if (!current) throw new Error('PREPAID_PURCHASE_NOT_FOUND');
    if (
      input.refundedAmount < current.refundedAmount ||
      input.targetRevokedCredits < current.revokedCredits
    ) {
      return {
        status: 'stale',
        prepaidCredits:
          await this.getPrepaidCreditsBalance(
            current.quotaSubjectId,
          ),
        refundDebtCredits:
          await this.getPrepaidRefundDebt(
            current.quotaSubjectId,
          ),
        purchase: current,
      };
    }
    if (
      input.refundedAmount === current.refundedAmount &&
      input.targetRevokedCredits === current.revokedCredits
    ) {
      return {
        status: 'duplicate',
        prepaidCredits:
          await this.getPrepaidCreditsBalance(
            current.quotaSubjectId,
          ),
        refundDebtCredits:
          await this.getPrepaidRefundDebt(
            current.quotaSubjectId,
          ),
        purchase: current,
      };
    }
    if (
      input.refundedAmount > current.totalAmount ||
      input.targetRevokedCredits > current.purchasedCredits
    ) {
      throw new Error('PREPAID_REFUND_INVALID');
    }

    const eventLookup = () =>
      this.db
        .prepare(
          `SELECT refunded_amount FROM prepaid_refund_events
           WHERE provider = ? AND provider_order_id = ?
             AND refunded_amount = ?`,
        )
        .bind(
          input.provider,
          input.providerOrderId,
          input.refundedAmount,
        )
        .first<{ refunded_amount: number }>();

    let status: 'applied' | 'duplicate' | 'stale' = 'applied';
    try {
      await this.db
        .prepare(
          `INSERT INTO prepaid_refund_events (
             provider, provider_order_id, refunded_amount,
             target_revoked_credits, provider_updated_at,
             applied_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.provider,
          input.providerOrderId,
          input.refundedAmount,
          input.targetRevokedCredits,
          input.providerUpdatedAt,
          input.appliedAt,
        )
        .run();
    } catch (error) {
      if (await eventLookup()) {
        status = 'duplicate';
      } else {
        const message =
          error instanceof Error ? error.message : String(error);
        if (message.includes('prepaid_refund_stale')) {
          status = 'stale';
        } else {
          throw error;
        }
      }
    }

    const purchase =
      (await this.getPrepaidPurchase(
        input.provider,
        input.providerOrderId,
      )) ?? current;
    return {
      status,
      prepaidCredits:
        await this.getPrepaidCreditsBalance(
          purchase.quotaSubjectId,
        ),
      refundDebtCredits:
        await this.getPrepaidRefundDebt(
          purchase.quotaSubjectId,
        ),
      purchase,
    };
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
          'SELECT COUNT(*) AS count FROM quota_usage_events WHERE charged_at >= ?',
        )
        .bind(since24h)
        .first<{ count: number }>(),
      this.db
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(credits), 0) AS credits FROM quota_usage_events WHERE charged_at >= ?',
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
      input.quotaSubjectId,
      input.periodKey,
    );
    if (record) return record;
    return {
      quotaSubjectId: input.quotaSubjectId,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      usedCredits: 0,
      prepaidCredits:
        input.billingMode === 'prepaid-metered'
          ? await this.getPrepaidCreditsBalance(
              input.quotaSubjectId,
            )
          : 0,
    };
  }
}
