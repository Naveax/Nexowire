import type { PairingRecord } from './pairing.js';
import type {
  ControlPlaneStore,
  ProductAccountRecord,
  ProductDeviceRecord,
  ProductUsagePeriodRecord,
  UsageAggregate,
  UsageAtomicChargeInput,
  UsageAtomicChargeResult,
} from './control-plane-store.js';

interface UsageEventRecord {
  accountId: string;
  periodKey: string;
  eventId: string;
  credits: number;
  chargedAt: string;
}

function usageKey(accountId: string, periodKey: string): string {
  return accountId + ':' + periodKey;
}

function eventKey(
  accountId: string,
  periodKey: string,
  eventId: string,
): string {
  return accountId + ':' + periodKey + ':' + eventId;
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
  private readonly accounts = new Map<string, ProductAccountRecord>();
  private readonly devices = new Map<string, ProductDeviceRecord>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly usage = new Map<string, ProductUsagePeriodRecord>();
  private readonly events = new Map<string, UsageEventRecord>();

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
    accountId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null> {
    const value = this.usage.get(usageKey(accountId, periodKey));
    return value ? clone(value) : null;
  }

  async chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult> {
    validateCredits('credits', input.credits);
    if (input.credits < 1) {
      throw new Error('credits must be at least 1.');
    }

    const key = usageKey(input.accountId, input.periodKey);
    const existing =
      this.usage.get(key) ??
      {
        accountId: input.accountId,
        periodKey: input.periodKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        usedCredits: 0,
        prepaidCredits: 0,
      };

    const duplicateKey = eventKey(
      input.accountId,
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
      accountId: input.accountId,
      periodKey: input.periodKey,
      eventId: input.eventId,
      credits: input.credits,
      chargedAt: new Date().toISOString(),
    });

    return {
      status: 'charged',
      record: clone(existing),
    };
  }

  async setPrepaidCredits(
    accountId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord> {
    validateCredits('credits', credits);
    const key = usageKey(accountId, periodKey);
    const existing =
      this.usage.get(key) ??
      {
        accountId,
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
