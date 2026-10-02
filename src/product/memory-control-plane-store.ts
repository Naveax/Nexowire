import type { PairingRecord } from './pairing.js';
import type {
  ControlPlaneStore,
  DeviceAnchorRecord,
  ExternalIdentityRecord,
  ProductAccountRecord,
  ProductDeviceRecord,
  ProductQuotaSubjectRecord,
  ProductUsagePeriodRecord,
  UsageAggregate,
  UsageAtomicChargeInput,
  UsageAtomicChargeResult,
} from './control-plane-store.js';

interface UsageEventRecord {
  quotaSubjectId: string;
  periodKey: string;
  eventId: string;
  credits: number;
  chargedAt: string;
}

function usageKey(
  quotaSubjectId: string,
  periodKey: string,
): string {
  return quotaSubjectId + ':' + periodKey;
}

function eventKey(
  quotaSubjectId: string,
  periodKey: string,
  eventId: string,
): string {
  return quotaSubjectId + ':' + periodKey + ':' + eventId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateCredits(name: string, credits: number): void {
  if (!Number.isInteger(credits) || credits < 0) {
    throw new Error(name + ' must be a non-negative integer.');
  }
}

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private readonly quotaSubjects =
    new Map<string, ProductQuotaSubjectRecord>();
  private readonly deviceAnchors =
    new Map<string, DeviceAnchorRecord>();
  private readonly accounts = new Map<string, ProductAccountRecord>();
  private readonly identities = new Map<string, ExternalIdentityRecord>();
  private readonly devices = new Map<string, ProductDeviceRecord>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly usage = new Map<string, ProductUsagePeriodRecord>();
  private readonly events = new Map<string, UsageEventRecord>();

  async getQuotaSubject(
    id: string,
  ): Promise<ProductQuotaSubjectRecord | null> {
    const value = this.quotaSubjects.get(id);
    return value ? clone(value) : null;
  }

  async putQuotaSubject(
    record: ProductQuotaSubjectRecord,
  ): Promise<void> {
    this.quotaSubjects.set(record.id, clone(record));
  }

  async getDeviceAnchor(
    anchorHash: string,
  ): Promise<DeviceAnchorRecord | null> {
    const value = this.deviceAnchors.get(anchorHash);
    return value ? clone(value) : null;
  }

  async putDeviceAnchor(
    record: DeviceAnchorRecord,
  ): Promise<void> {
    this.deviceAnchors.set(record.anchorHash, clone(record));
  }

  async mergeFreeQuotaSubjects(
    sourceQuotaSubjectId: string,
    targetQuotaSubjectId: string,
  ): Promise<void> {
    if (sourceQuotaSubjectId === targetQuotaSubjectId) return;

    const source = this.quotaSubjects.get(sourceQuotaSubjectId);
    const target = this.quotaSubjects.get(targetQuotaSubjectId);
    if (!source || !target) {
      throw new Error('QUOTA_SUBJECT_NOT_FOUND');
    }
    if (
      source.kind !== 'free-cluster' ||
      target.kind !== 'free-cluster'
    ) {
      throw new Error('QUOTA_SUBJECT_MERGE_NOT_FREE');
    }

    for (const [id, account] of this.accounts) {
      if (account.quotaSubjectId === sourceQuotaSubjectId) {
        this.accounts.set(id, {
          ...account,
          quotaSubjectId: targetQuotaSubjectId,
          updatedAt: target.updatedAt,
        });
      }
    }

    for (const [hash, anchor] of this.deviceAnchors) {
      if (anchor.quotaSubjectId === sourceQuotaSubjectId) {
        this.deviceAnchors.set(hash, {
          ...anchor,
          quotaSubjectId: targetQuotaSubjectId,
        });
      }
    }

    for (const [key, record] of [...this.usage]) {
      if (record.quotaSubjectId !== sourceQuotaSubjectId) continue;
      const targetKey = usageKey(
        targetQuotaSubjectId,
        record.periodKey,
      );
      const existing = this.usage.get(targetKey);
      this.usage.set(targetKey, {
        quotaSubjectId: targetQuotaSubjectId,
        periodKey: record.periodKey,
        periodStart:
          existing?.periodStart ?? record.periodStart,
        periodEnd: existing?.periodEnd ?? record.periodEnd,
        usedCredits:
          (existing?.usedCredits ?? 0) + record.usedCredits,
        prepaidCredits:
          (existing?.prepaidCredits ?? 0) +
          record.prepaidCredits,
      });
      this.usage.delete(key);
    }

    for (const [key, event] of [...this.events]) {
      if (event.quotaSubjectId !== sourceQuotaSubjectId) continue;
      const nextKey = eventKey(
        targetQuotaSubjectId,
        event.periodKey,
        event.eventId,
      );
      if (!this.events.has(nextKey)) {
        this.events.set(nextKey, {
          ...event,
          quotaSubjectId: targetQuotaSubjectId,
        });
      }
      this.events.delete(key);
    }

    this.quotaSubjects.delete(sourceQuotaSubjectId);
  }

  async getAccount(id: string): Promise<ProductAccountRecord | null> {
    const value = this.accounts.get(id);
    return value ? clone(value) : null;
  }

  async putAccount(record: ProductAccountRecord): Promise<void> {
    this.accounts.set(record.id, clone(record));
  }

  async listAccounts(): Promise<ProductAccountRecord[]> {
    return [...this.accounts.values()].map(clone);
  }

  async getExternalIdentity(
    provider: string,
    subject: string,
  ): Promise<ExternalIdentityRecord | null> {
    const value = this.identities.get(provider + ':' + subject);
    return value ? clone(value) : null;
  }

  async putExternalIdentity(
    record: ExternalIdentityRecord,
  ): Promise<void> {
    this.identities.set(
      record.provider + ':' + record.subject,
      clone(record),
    );
  }

  async getDevice(id: string): Promise<ProductDeviceRecord | null> {
    const value = this.devices.get(id);
    return value ? clone(value) : null;
  }

  async putDevice(record: ProductDeviceRecord): Promise<void> {
    this.devices.set(record.id, clone(record));
  }

  async listDevices(
    ownerAccountId?: string,
  ): Promise<ProductDeviceRecord[]> {
    return [...this.devices.values()]
      .filter(
        (record) =>
          ownerAccountId === undefined ||
          record.ownerAccountId === ownerAccountId,
      )
      .map(clone);
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const value = this.pairings.get(id);
    return value ? clone(value) : null;
  }

  async putPairing(record: PairingRecord): Promise<void> {
    this.pairings.set(record.id, clone(record));
  }

  async getUsagePeriod(
    quotaSubjectId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null> {
    const value = this.usage.get(
      usageKey(quotaSubjectId, periodKey),
    );
    return value ? clone(value) : null;
  }

  async chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult> {
    validateCredits('credits', input.credits);
    if (input.credits < 1) {
      throw new Error('credits must be at least 1.');
    }

    const key = usageKey(input.quotaSubjectId, input.periodKey);
    const existing =
      this.usage.get(key) ??
      {
        quotaSubjectId: input.quotaSubjectId,
        periodKey: input.periodKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        usedCredits: 0,
        prepaidCredits: 0,
      };

    const duplicateKey = eventKey(
      input.quotaSubjectId,
      input.periodKey,
      input.eventId,
    );
    if (this.events.has(duplicateKey)) {
      return {
        status: 'duplicate',
        record: clone(existing),
      };
    }

    if (input.billingMode === 'prepaid-metered') {
      if (existing.prepaidCredits < input.credits) {
        return {
          status: 'quota-exhausted',
          record: clone(existing),
        };
      }
      existing.prepaidCredits -= input.credits;
    } else if (
      input.monthlyCredits !== null &&
      existing.usedCredits + input.credits >
        input.monthlyCredits
    ) {
      return {
        status: 'quota-exhausted',
        record: clone(existing),
      };
    } else {
      existing.usedCredits += input.credits;
    }

    this.usage.set(key, clone(existing));
    this.events.set(duplicateKey, {
      quotaSubjectId: input.quotaSubjectId,
      periodKey: input.periodKey,
      eventId: input.eventId,
      credits: input.credits,
      chargedAt: input.chargedAt,
    });

    return {
      status: 'charged',
      record: clone(existing),
    };
  }

  async setPrepaidCredits(
    quotaSubjectId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord> {
    validateCredits('credits', credits);
    const key = usageKey(quotaSubjectId, periodKey);
    const existing =
      this.usage.get(key) ??
      {
        quotaSubjectId,
        periodKey,
        periodStart,
        periodEnd,
        usedCredits: 0,
        prepaidCredits: 0,
      };
    existing.prepaidCredits = credits;
    this.usage.set(key, clone(existing));
    return clone(existing);
  }

  async getUsageAggregate(now = new Date()): Promise<UsageAggregate> {
    const t24 = now.getTime() - 86_400_000;
    const t30 = now.getTime() - 30 * 86_400_000;
    let calls24h = 0;
    let calls30d = 0;
    let chargedCredits30d = 0;

    for (const event of this.events.values()) {
      const at = Date.parse(event.chargedAt);
      if (at >= t30) {
        calls30d++;
        chargedCredits30d += event.credits;
      }
      if (at >= t24) calls24h++;
    }

    return {
      calls24h,
      calls30d,
      chargedCredits30d,
    };
  }
}
