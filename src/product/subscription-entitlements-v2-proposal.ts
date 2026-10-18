import type { BillingSubscriptionStatus } from './billing-store.js';
import { PROPOSED_DAILY_REQUEST_LIMITS } from './daily-quota-proposal.js';

/**
 * DORMANT Scale v2 S2/S4 contract. NEVER import into live Worker/Hub/billing.
 * All arguments are a snapshot read from SERVER-owned identity, payment,
 * tenant membership, contract and consent stores, NOT client JSON.
 */
export type QuotaTierV2 = 'free' | 'plus' | 'pro' | 'enterprise';
export type SubscriptionStateV2 =
  | 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'PAUSED' | 'UNPAID'
  | 'CANCELED' | 'EXPIRED' | 'CHARGEBACK' | 'REFUNDED';

export interface VerifiedQuotaIdentityV2 {
  accountId: string;
  tenantId: string;
  quotaSubjectId: string;
  /** A NULL device is allowed only for device-independent hosted actions. */
  deviceId: string | null;
  deviceOwnerAccountId: string | null;
  accountSubjectId: string;
  tenantSubjectId: string;
  /** Present for enterprise only. Membership is verified by first-party auth. */
  membership: 'owner' | 'admin' | 'member' | null;
  membershipActive: boolean;
}

export interface VerifiedPaymentEvidenceV2 {
  provider: 'lemonsqueezy';
  accountId: string;
  providerSubscriptionId: string;
  providerStatus: BillingSubscriptionStatus;
  /** Passed by the signed-webhook reconciler after matching a paid order. */
  paymentConfirmed: boolean;
  providerUpdatedAt: string;
  endsAt: string | null;
  trialEndsAt: string | null;
}

export interface QuotaContractV2 {
  id: string;
  revision: number;
  tier: QuotaTierV2;
  accountId: string;
  tenantId: string;
  quotaSubjectId: string;
  effectiveAt: string;
  expiresAt: string | null;
  /** For enterprise, positive finite contract ceiling, max 850,000 in the proposal. */
  customDailyLimit?: number;
  /** Optional per-subject application budget, distinct from provider tunnel limits. */
  customRollingMinuteLimit?: number;
  /** A finite monthly credit ceiling; cannot silently remove the legacy protection. */
  monthlyWeightedCredits: number;
  /** Staging-only acceptance snapshot. No checkout authority. */
  disclosure: {
    termsHash: string;
    termsVersion: string;
    acceptedAccountId: string;
    acceptedAt: string;
    revokedAt: string | null;
  } | null;
}

export interface QuotaEntitlementSnapshotV2 {
  identity: VerifiedQuotaIdentityV2;
  contract: QuotaContractV2;
  payment: VerifiedPaymentEvidenceV2 | null;
  state: SubscriptionStateV2 | null;
  /** OFF unless a separately authorized staging test explicitly opts in. */
  candidateEntitlementsEnabled: boolean;
  /** Live billing stays independently paused, even for staging checks. */
  productionBillingEnabled: false;
}

export type QuotaEntitlementDecisionV2 =
  | Readonly<{
      status: 'allowed';
      tier: QuotaTierV2;
      accountId: string;
      tenantId: string;
      quotaSubjectId: string;
      deviceId: string | null;
      revision: number;
      dailyLimit: number;
      rollingMinuteLimit: number | null;
      monthlyWeightedCredits: number;
      termsHash: string | null;
    }>
  | Readonly<{
      status: 'denied';
      reason: 'invalid-authority' | 'scope-mismatch' | 'device-owner-mismatch'
        | 'tenant-membership-required' | 'paid-plans-disabled'
        | 'subscription-not-active' | 'payment-not-confirmed'
        | 'provider-state-invalid' | 'contract-expired'
        | 'disclosure-not-accepted' | 'enterprise-contract-invalid';
    }>;

const idPattern = /^[A-Za-z0-9_.:@-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/i;
const denied = (reason: Extract<QuotaEntitlementDecisionV2, {status:'denied'}>['reason']):
  QuotaEntitlementDecisionV2 => ({status:'denied', reason});
function goodId(v: unknown): v is string {
  return typeof v === 'string' && idPattern.test(v);
}
function time(value: string | null): number {
  return value === null ? NaN : Date.parse(value);
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function evaluateQuotaEntitlementV2(
  snapshot: QuotaEntitlementSnapshotV2,
  now: Date,
): QuotaEntitlementDecisionV2 {
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) {
    return denied('invalid-authority');
  }
  const {identity: i, contract: c, payment: p} = snapshot;
  if (!goodId(i.accountId) || !goodId(i.tenantId) ||
      !goodId(i.quotaSubjectId) || !goodId(c.id) ||
      !positive(c.revision) || !positive(c.monthlyWeightedCredits)) {
    return denied('invalid-authority');
  }
  if (i.accountId !== c.accountId || i.tenantId !== c.tenantId ||
      i.quotaSubjectId !== c.quotaSubjectId ||
      i.accountSubjectId !== c.quotaSubjectId ||
      i.tenantSubjectId !== c.quotaSubjectId) {
    return denied('scope-mismatch');
  }
  if (i.deviceId !== null &&
      (!goodId(i.deviceId) || i.deviceOwnerAccountId !== i.accountId)) {
    return denied('device-owner-mismatch');
  }
  if (i.deviceId === null && i.deviceOwnerAccountId !== null) {
    return denied('device-owner-mismatch');
  }
  const start = time(c.effectiveAt);
  const end = time(c.expiresAt);
  if (!Number.isFinite(start) || start > now.getTime() ||
      (c.expiresAt !== null && (!Number.isFinite(end) || end <= now.getTime()))) {
    return denied('contract-expired');
  }

  if (c.tier === 'free') {
    // The candidate Free daily model does not affect the live monthly meter.
    if (snapshot.state !== null || p !== null ||
        c.monthlyWeightedCredits !== PROPOSED_DAILY_REQUEST_LIMITS.free ||
        c.customDailyLimit !== undefined ||
        c.customRollingMinuteLimit !== undefined) {
      return denied('invalid-authority');
    }
    return {
      status:'allowed', tier:'free', accountId:i.accountId, tenantId:i.tenantId,
      quotaSubjectId:i.quotaSubjectId, deviceId:i.deviceId, revision:c.revision,
      dailyLimit:PROPOSED_DAILY_REQUEST_LIMITS.free, rollingMinuteLimit:null,
      monthlyWeightedCredits:c.monthlyWeightedCredits, termsHash:null,
    };
  }
  if (snapshot.candidateEntitlementsEnabled !== true ||
      snapshot.productionBillingEnabled !== false) return denied('paid-plans-disabled');
  if (c.tier === 'enterprise' &&
      (!i.membershipActive || i.membership === null)) {
    return denied('tenant-membership-required');
  }
  // No grace period, postpaid spending or paid access on failed payments.
  if (snapshot.state !== 'ACTIVE') return denied('subscription-not-active');
  if (!p || !p.paymentConfirmed || p.accountId !== i.accountId ||
      !goodId(p.providerSubscriptionId)) return denied('payment-not-confirmed');
  const providerUpdated = time(p.providerUpdatedAt);
  if (p.provider !== 'lemonsqueezy' || p.providerStatus !== 'active' ||
      !Number.isFinite(providerUpdated) || providerUpdated > now.getTime() ||
      (p.endsAt !== null && (!Number.isFinite(time(p.endsAt)) ||
        time(p.endsAt) <= now.getTime()))) return denied('provider-state-invalid');

  const consent = c.disclosure;
  if (!consent || !hashPattern.test(consent.termsHash) ||
      !goodId(consent.termsVersion) ||
      consent.acceptedAccountId !== i.accountId ||
      consent.revokedAt !== null ||
      !Number.isFinite(time(consent.acceptedAt)) ||
      time(consent.acceptedAt) > now.getTime() ||
      time(consent.acceptedAt) < start) return denied('disclosure-not-accepted');

  let dailyLimit: number;
  let rollingMinuteLimit: number | null = null;
  if (c.tier === 'enterprise') {
    if (!positive(c.customDailyLimit ?? 0) || c.customDailyLimit! > 850_000 ||
        !positive(c.customRollingMinuteLimit ?? 0) ||
        c.customRollingMinuteLimit! > 600) return denied('enterprise-contract-invalid');
    dailyLimit = c.customDailyLimit!;
    rollingMinuteLimit = c.customRollingMinuteLimit!;
  } else if (c.tier === 'plus' || c.tier === 'pro') {
    if (c.customDailyLimit !== undefined || c.customRollingMinuteLimit !== undefined) {
      return denied('enterprise-contract-invalid');
    }
    dailyLimit = PROPOSED_DAILY_REQUEST_LIMITS[c.tier];
  } else {
    return denied('invalid-authority');
  }
  return {
    status:'allowed', tier:c.tier, accountId:i.accountId, tenantId:i.tenantId,
    quotaSubjectId:i.quotaSubjectId, deviceId:i.deviceId, revision:c.revision,
    dailyLimit, rollingMinuteLimit, monthlyWeightedCredits:c.monthlyWeightedCredits,
    termsHash:consent.termsHash,
  };
}

/**
 * Exactly one billable hosted root action. Nested fan-out, retries of that
 * root, local operations and network ingress are not new billable actions.
 * Returning "internal" is never an authorization to dispatch a command.
 */
export type LogicalInvocationV2 =
  | {kind:'hosted-root'; invocationId:string}
  | {kind:'hosted-child'; rootInvocationId:string; childId:string}
  | {kind:'retry'; rootInvocationId:string}
  | {kind:'local-operation'; operationId:string}
  | {kind:'transport-request'; requestId:string}
  | {kind:'relay-byte-stream'; streamId:string};

export function billableInvocationV2(input:LogicalInvocationV2):
  {billable:true; invocationId:string} | {billable:false; reason:string} {
  if (input.kind !== 'hosted-root') {
    return {billable:false, reason:'not-an-independent-hosted-root'};
  }
  if (!goodId(input.invocationId) || input.invocationId.length < 8) {
    throw new Error('INVOCATION_ID_INVALID');
  }
  return {billable:true, invocationId:input.invocationId};
}
