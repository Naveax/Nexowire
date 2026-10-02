import type { PairingRecord } from './pairing.js';
import type {
  BillingMode,
  CustomPlanInput,
  ProductPlanId,
} from './plans.js';

export interface ProductAccountRecord {
  id: string;
  displayName: string | null;
  planId: ProductPlanId;
  customPlan: CustomPlanInput | null;
  admin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDeviceRecord {
  id: string;
  ownerAccountId: string;
  name: string;
  platform: string;
  credentialHash: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductUsagePeriodRecord {
  accountId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  usedCredits: number;
  prepaidCredits: number;
}

export interface UsageAtomicChargeInput {
  accountId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  eventId: string;
  credits: number;
  billingMode: BillingMode;
  monthlyCredits: number | null;
}

export type UsageAtomicChargeResult =
  | {
      status: 'charged';
      record: ProductUsagePeriodRecord;
    }
  | {
      status: 'duplicate';
      record: ProductUsagePeriodRecord;
    }
  | {
      status: 'quota-exhausted';
      record: ProductUsagePeriodRecord;
    };

export interface UsageAggregate {
  calls24h: number;
  calls30d: number;
  chargedCredits30d: number;
}

export interface ControlPlaneStore {
  getAccount(id: string): Promise<ProductAccountRecord | null>;
  putAccount(record: ProductAccountRecord): Promise<void>;
  listAccounts(): Promise<ProductAccountRecord[]>;

  getDevice(id: string): Promise<ProductDeviceRecord | null>;
  putDevice(record: ProductDeviceRecord): Promise<void>;
  listDevices(ownerAccountId?: string): Promise<ProductDeviceRecord[]>;

  getPairing(id: string): Promise<PairingRecord | null>;
  putPairing(record: PairingRecord): Promise<void>;

  getUsagePeriod(
    accountId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null>;

  chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult>;

  setPrepaidCredits(
    accountId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord>;

  getUsageAggregate(now?: Date): Promise<UsageAggregate>;
}
