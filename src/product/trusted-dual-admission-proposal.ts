import { hostedMcpUsageEventId } from '../mcp/hosted-metering.js';
import type { ProposedDailyEntitlementResolver } from './daily-entitlement-proposal.js';
import type { DualQuotaResult, TrustedDualQuotaRequest } from './dual-quota-d1-proposal.js';
import { PRODUCT_PLANS } from './plans.js';
import { quoteToolUsage } from './usage-policy.js';

/**
 * STAGING-ONLY S2 composition. NOT a Worker endpoint, permission provider,
 * production migration, or permission to execute a tool.
 *
 * The accountId must come from a freshly verified first-party OAuth token.
 * authorizeCurrentScopeAndOwnership MUST check that token's current scope,
 * account role, owner/device/folder permissions and current revocation state.
 * Never substitute client-provided subject, tier, quota, billing or credits.
 * Production needs one exclusive admission path and a proven replay cutover.
 */
export interface ProposedTrustedDualAdmissionDependencies {
  entitlement: Pick<ProposedDailyEntitlementResolver, 'resolve'>;
  authorizeCurrentScopeAndOwnership(input: {
    authenticatedAccountId: string;
    toolName: string;
  }): Promise<boolean>;
  ledger: { reserve(input: TrustedDualQuotaRequest): Promise<DualQuotaResult> };
  now?: () => Date;
}

export type ProposedTrustedDualDecision =
  | Readonly<{
      status: DualQuotaResult['status'];
      tier: 'free' | 'plus' | 'pro';
      dayUtc: string;
      monthUtc: string;
      dailyLimit: number;
      monthlyCredits: number;
      chargedCredits: number;
      usedDaily: number;
      usedMonthlyCredits: number;
    }>
  | Readonly<{
      status: 'denied';
      reason: 'unauthorized' | 'entitlement-denied' | 'feature-not-in-plan';
    }>;

const boundedId = (value: string, label: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new Error('Invalid ' + label);
  }
};

/**
 * A single reserve() call, never one daily reserve followed by a monthly
 * charge. Any unknown failure propagates: the caller MUST fail closed,
 * never retry execution under a new invocation ID or a legacy charge path.
 */
export class ProposedTrustedDualAdmission {
  private readonly now: () => Date;

  constructor(private readonly dependencies: ProposedTrustedDualAdmissionDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async reserveAuthenticated(input: {
    authenticatedAccountId: string;
    invocationId: string;
    toolName: string;
    specialSkill?: boolean;
  }): Promise<ProposedTrustedDualDecision> {
    boundedId(input.authenticatedAccountId, 'authenticated account ID');
    boundedId(input.invocationId, 'invocation ID');
    if (typeof input.toolName !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.toolName) ||
        (input.specialSkill !== undefined && typeof input.specialSkill !== 'boolean')) {
      throw new Error('Invalid trusted tool request');
    }

    // Fresh scope, role and device ownership validation must complete before
    // any reservation. Errors fail closed rather than granting a free tool.
    const authorized = await this.dependencies.authorizeCurrentScopeAndOwnership({
      authenticatedAccountId: input.authenticatedAccountId,
      toolName: input.toolName,
    });
    if (authorized !== true) return { status: 'denied', reason: 'unauthorized' };

    const entitlement = await this.dependencies.entitlement.resolve(
      input.authenticatedAccountId,
    );
    if (entitlement.status !== 'allowed') {
      return { status: 'denied', reason: 'entitlement-denied' };
    }

    const plan = PRODUCT_PLANS[entitlement.tier];
    // Null/unlimited/prepaid plans are intentionally not supported here.
    if (!plan || plan.monthlyCredits === null ||
        !Number.isSafeInteger(plan.monthlyCredits) ||
        plan.monthlyCredits < 1 ||
        (plan.billingMode !== 'free' && plan.billingMode !== 'subscription')) {
      throw new Error('Unsupported finite dual quota plan');
    }
    const quote = quoteToolUsage(plan, input.toolName, 1, input.specialSkill === true);
    if (!quote.allowed) {
      return { status: 'denied', reason: 'feature-not-in-plan' };
    }
    if (!Number.isSafeInteger(quote.credits) || quote.credits < 1) {
      throw new Error('Invalid trusted tool quote');
    }

    const acceptedAt = this.now();
    if (!(acceptedAt instanceof Date) || !Number.isFinite(acceptedAt.getTime())) {
      throw new Error('Trusted dual admission clock unavailable');
    }
    // The hashed ID matches the legacy monthly hosted MCP event identity.
    // Subject comes from the latest server-authoritative entitlement.
    const reservation = await this.dependencies.ledger.reserve({
      quotaSubjectId: entitlement.quotaSubjectId,
      invocationId: hostedMcpUsageEventId({
        accountId: input.authenticatedAccountId, invocationId: input.invocationId,
      }),
      acceptedAt,
      dailyLimit: entitlement.dailyRequestLimit,
      monthlyCredits: plan.monthlyCredits,
      toolCredits: quote.credits,
      billingMode: plan.billingMode,
    });
    return {
      status: reservation.status,
      tier: entitlement.tier,
      dayUtc: reservation.dayUtc,
      monthUtc: reservation.monthUtc,
      dailyLimit: entitlement.dailyRequestLimit,
      monthlyCredits: plan.monthlyCredits,
      chargedCredits: reservation.status === 'reserved' ? quote.credits : 0,
      usedDaily: reservation.usedDaily,
      usedMonthlyCredits: reservation.usedMonthlyCredits,
    };
  }
}
