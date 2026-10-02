import type { PairingRecord } from './pairing.js';
import type {
  BillingMode,
  CustomPlanInput,
  ProductPlanId,
} from './plans.js';

export type QuotaSubjectKind =
  | 'free-cluster'
  | 'subscription'
  | 'prepaid';

export interface ProductQuotaSubjectRecord {
  id: string;
  kind: QuotaSubjectKind;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceAnchorRecord {
  anchorHash: string;
  quotaSubjectId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ProductAccountRecord {
  id: string;
  quotaSubjectId: string;
  displayName: string | null;
  planId: ProductPlanId;
  customPlan: CustomPlanInput | null;
  admin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalIdentityRecord {
  provider: string;
  subject: string;
  accountId: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string;
}

export interface ProductDeviceRecord {
  id: string;
  ownerAccountId: string;
  deviceAnchorHash: string | null;
  name: string;
  platform: string;
  credentialHash: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductUsagePeriodRecord {
  quotaSubjectId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  usedCredits: number;
  prepaidCredits: number;
}

export interface UsageAtomicChargeInput {
  quotaSubjectId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  eventId: string;
  credits: number;
  billingMode: BillingMode;
  monthlyCredits: number | null;
  chargedAt: string;
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
  getQuotaSubject(
    id: string,
  ): Promise<ProductQuotaSubjectRecord | null>;
  putQuotaSubject(
    record: ProductQuotaSubjectRecord,
  ): Promise<void>;
  getDeviceAnchor(
    anchorHash: string,
  ): Promise<DeviceAnchorRecord | null>;
  putDeviceAnchor(
    record: DeviceAnchorRecord,
  ): Promise<void>;
  mergeFreeQuotaSubjects(
    sourceQuotaSubjectId: string,
    targetQuotaSubjectId: string,
  ): Promise<void>;

  getAccount(id: string): Promise<ProductAccountRecord | null>;
  putAccount(record: ProductAccountRecord): Promise<void>;
  listAccounts(): Promise<ProductAccountRecord[]>;

  getExternalIdentity(
    provider: string,
    subject: string,
  ): Promise<ExternalIdentityRecord | null>;
  putExternalIdentity(
    record: ExternalIdentityRecord,
  ): Promise<void>;

  getDevice(id: string): Promise<ProductDeviceRecord | null>;
  putDevice(record: ProductDeviceRecord): Promise<void>;
  listDevices(ownerAccountId?: string): Promise<ProductDeviceRecord[]>;

  getPairing(id: string): Promise<PairingRecord | null>;
  putPairing(record: PairingRecord): Promise<void>;

  getUsagePeriod(
    quotaSubjectId: string,
    periodKey: string,
  ): Promise<ProductUsagePeriodRecord | null>;

  chargeUsageAtomic(
    input: UsageAtomicChargeInput,
  ): Promise<UsageAtomicChargeResult>;

  setPrepaidCredits(
    quotaSubjectId: string,
    periodKey: string,
    periodStart: string,
    periodEnd: string,
    credits: number,
  ): Promise<ProductUsagePeriodRecord>;

  getUsageAggregate(now?: Date): Promise<UsageAggregate>;
}
