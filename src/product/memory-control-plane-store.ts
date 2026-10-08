import type { PairingRecord } from './pairing.js';
import type {
  ControlPlaneStore,
  DeviceAnchorRecord,
  ExternalIdentityRecord,
  ProductAccountRecord,
  ProductDeviceRecord,
  RootModeLeaseRecord,
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
  private readonly rootModeLeases = new Map<string, RootModeLeaseRecord>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly usage = new Map<string, ProductUsagePeriodRecord>();
  private readonly events = new Map<string, UsageEventRecord>();
  private readonly prepaidBalances = new Map<string, number>();
  private readonly prepaidRefundDebts = new Map<string, number>();
  private readonly prepaidCreditEvents = new Map<string, string>();
  private readonly prepaidPurchases =
    new Map<string, PrepaidPurchaseRecord>();
  private readonly prepaidRefundEvents = new Set<string>();

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

  async getDeviceByCredentialHash(
    credentialHash: string,
  ): Promise<ProductDeviceRecord | null> {
    for (const device of this.devices.values()) {
      if (device.credentialHash === credentialHash) {
        return clone(device);
      }
    }
    return null;
  }

  async putDevice(record: ProductDeviceRecord): Promise<void> {
    this.devices.set(record.id, clone(record));
  }

  async getRootModeLease(deviceId: string): Promise<RootModeLeaseRecord | null> {
    const value = this.rootModeLeases.get(deviceId);
    return value ? clone(value) : null;
  }

  async putRootModeLease(record: RootModeLeaseRecord): Promise<void> {
    this.rootModeLeases.set(record.deviceId, clone(record));
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
        prepaidCredits:
          input.billingMode === 'prepaid-metered'
            ? this.prepaidBalances.get(
                input.quotaSubjectId,
              ) ?? 0
            : 0,
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
      const balance =
        this.prepaidBalances.get(input.quotaSubjectId) ?? 0;
      const refundDebt =
        this.prepaidRefundDebts.get(input.quotaSubjectId) ?? 0;
      if (balance < input.credits || refundDebt > 0) {
        existing.prepaidCredits = balance;
        return {
          status: 'quota-exhausted',
          record: clone(existing),
        };
      }
      const remaining = balance - input.credits;
      this.prepaidBalances.set(
        input.quotaSubjectId,
        remaining,
      );
      existing.prepaidCredits = remaining;
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
    this.prepaidBalances.set(quotaSubjectId, credits);
    this.usage.set(key, clone(existing));
    return clone(existing);
  }

  async getPrepaidCreditsBalance(
    quotaSubjectId: string,
  ): Promise<number> {
    return this.prepaidBalances.get(quotaSubjectId) ?? 0;
  }

  async getPrepaidRefundDebt(
    quotaSubjectId: string,
  ): Promise<number> {
    return this.prepaidRefundDebts.get(quotaSubjectId) ?? 0;
  }

  async addPrepaidCreditsAtomic(
    input: PrepaidCreditInput,
  ): Promise<PrepaidCreditResult> {
    validateCredits('credits', input.credits);
    if (input.credits < 1) {
      throw new Error('credits must be at least 1.');
    }
    const existingQuotaSubjectId =
      this.prepaidCreditEvents.get(input.eventId);
    if (existingQuotaSubjectId) {
      if (existingQuotaSubjectId !== input.quotaSubjectId) {
        throw new Error('PREPAID_CREDIT_EVENT_MISMATCH');
      }
      return {
        status: 'duplicate',
        prepaidCredits:
          this.prepaidBalances.get(
            input.quotaSubjectId,
          ) ?? 0,
      };
    }

    const debt =
      this.prepaidRefundDebts.get(input.quotaSubjectId) ?? 0;
    const debtPayment = Math.min(debt, input.credits);
    const nextDebt = debt - debtPayment;
    const next =
      (this.prepaidBalances.get(input.quotaSubjectId) ?? 0) +
      (input.credits - debtPayment);
    this.prepaidBalances.set(input.quotaSubjectId, next);
    this.prepaidRefundDebts.set(
      input.quotaSubjectId,
      nextDebt,
    );
    this.prepaidCreditEvents.set(
      input.eventId,
      input.quotaSubjectId,
    );
    return {
      status: 'credited',
      prepaidCredits: next,
    };
  }

  async getPrepaidPurchase(
    provider: string,
    providerOrderId: string,
  ): Promise<PrepaidPurchaseRecord | null> {
    const value = this.prepaidPurchases.get(
      provider + ':' + providerOrderId,
    );
    return value ? clone(value) : null;
  }

  async putPrepaidPurchase(
    record: PrepaidPurchaseRecord,
  ): Promise<void> {
    const key = record.provider + ':' + record.providerOrderId;
    if (!this.prepaidPurchases.has(key)) {
      this.prepaidPurchases.set(key, clone(record));
    }
  }

  async applyPrepaidRefundAtomic(
    input: PrepaidRefundInput,
  ): Promise<PrepaidRefundResult> {
    const key = input.provider + ':' + input.providerOrderId;
    const current = this.prepaidPurchases.get(key);
    if (!current) throw new Error('PREPAID_PURCHASE_NOT_FOUND');

    if (
      input.refundedAmount < current.refundedAmount ||
      input.targetRevokedCredits < current.revokedCredits
    ) {
      return {
        status: 'stale',
        prepaidCredits:
          this.prepaidBalances.get(current.quotaSubjectId) ?? 0,
        refundDebtCredits:
          this.prepaidRefundDebts.get(current.quotaSubjectId) ?? 0,
        purchase: clone(current),
      };
    }
    if (
      input.refundedAmount === current.refundedAmount &&
      input.targetRevokedCredits === current.revokedCredits
    ) {
      return {
        status: 'duplicate',
        prepaidCredits:
          this.prepaidBalances.get(current.quotaSubjectId) ?? 0,
        refundDebtCredits:
          this.prepaidRefundDebts.get(current.quotaSubjectId) ?? 0,
        purchase: clone(current),
      };
    }
    if (
      input.refundedAmount > current.totalAmount ||
      input.targetRevokedCredits > current.purchasedCredits
    ) {
      throw new Error('PREPAID_REFUND_INVALID');
    }

    const eventKey =
      key + ':refund:' + String(input.refundedAmount);
    if (this.prepaidRefundEvents.has(eventKey)) {
      return {
        status: 'duplicate',
        prepaidCredits:
          this.prepaidBalances.get(current.quotaSubjectId) ?? 0,
        refundDebtCredits:
          this.prepaidRefundDebts.get(current.quotaSubjectId) ?? 0,
        purchase: clone(current),
      };
    }

    const delta =
      input.targetRevokedCredits - current.revokedCredits;
    const balance =
      this.prepaidBalances.get(current.quotaSubjectId) ?? 0;
    const removed = Math.min(balance, delta);
    const nextBalance = balance - removed;
    const nextDebt =
      (this.prepaidRefundDebts.get(current.quotaSubjectId) ?? 0) +
      (delta - removed);
    this.prepaidBalances.set(current.quotaSubjectId, nextBalance);
    this.prepaidRefundDebts.set(current.quotaSubjectId, nextDebt);

    const updated: PrepaidPurchaseRecord = {
      ...current,
      refundedAmount: input.refundedAmount,
      revokedCredits: input.targetRevokedCredits,
      providerUpdatedAt: input.providerUpdatedAt,
      updatedAt: input.appliedAt,
    };
    this.prepaidPurchases.set(key, clone(updated));
    this.prepaidRefundEvents.add(eventKey);
    return {
      status: 'applied',
      prepaidCredits: nextBalance,
      refundDebtCredits: nextDebt,
      purchase: clone(updated),
    };
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
