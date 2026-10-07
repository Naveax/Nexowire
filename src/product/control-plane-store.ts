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
  accessMode: 'safe' | 'full';
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

export interface PrepaidCreditInput {
  quotaSubjectId: string;
  eventId: string;
  credits: number;
  creditedAt: string;
}

export interface PrepaidCreditResult {
  status: 'credited' | 'duplicate';
  prepaidCredits: number;
}

export interface PrepaidPurchaseRecord {
  provider: string;
  providerOrderId: string;
  accountId: string;
  quotaSubjectId: string;
  variantId: string;
  purchasedCredits: number;
  totalAmount: number;
  refundedAmount: number;
  revokedCredits: number;
  providerUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrepaidRefundInput {
  provider: string;
  providerOrderId: string;
  refundedAmount: number;
  targetRevokedCredits: number;
  providerUpdatedAt: string;
  appliedAt: string;
}

export interface PrepaidRefundResult {
  status: 'applied' | 'duplicate' | 'stale';
  prepaidCredits: number;
  refundDebtCredits: number;
  purchase: PrepaidPurchaseRecord;
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
  getDeviceByCredentialHash(
    credentialHash: string,
  ): Promise<ProductDeviceRecord | null>;
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

  getPrepaidCreditsBalance(
    quotaSubjectId: string,
  ): Promise<number>;

  getPrepaidRefundDebt(
    quotaSubjectId: string,
  ): Promise<number>;

  addPrepaidCreditsAtomic(
    input: PrepaidCreditInput,
  ): Promise<PrepaidCreditResult>;

  getPrepaidPurchase(
    provider: string,
    providerOrderId: string,
  ): Promise<PrepaidPurchaseRecord | null>;

  putPrepaidPurchase(
    record: PrepaidPurchaseRecord,
  ): Promise<void>;

  applyPrepaidRefundAtomic(
    input: PrepaidRefundInput,
  ): Promise<PrepaidRefundResult>;

  getUsageAggregate(now?: Date): Promise<UsageAggregate>;
}
