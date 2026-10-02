import type { ProductPlan } from './plans.js';
import {
  authorizeUsageBalance,
  quoteToolUsage,
} from './usage-policy.js';

export interface UsageLedgerState {
  usedCredits: number;
  prepaidCredits: number;
  chargedEventIds: ReadonlySet<string>;
}

export interface UsageChargeRequest {
  eventId: string;
  toolName: string;
  baseCredits?: number;
}

export interface UsageChargeResult {
  allowed: boolean;
  duplicate: boolean;
  chargedCredits: number;
  nextState: UsageLedgerState;
  denialReason:
    | 'feature-not-in-plan'
    | 'monthly-quota-exhausted'
    | 'prepaid-balance-exhausted'
    | null;
}

function validEventId(input: string): string {
  const value = input.trim();
  if (
    !value ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(
      'eventId must be a bounded identifier containing only A-Z, a-z, 0-9, ., _, :, or -.',
    );
  }
  return value;
}

function copyState(
  state: UsageLedgerState,
): UsageLedgerState {
  return {
    usedCredits: state.usedCredits,
    prepaidCredits: state.prepaidCredits,
    chargedEventIds: new Set(state.chargedEventIds),
  };
}

function validateState(state: UsageLedgerState): void {
  for (const [name, value] of [
    ['usedCredits', state.usedCredits],
    ['prepaidCredits', state.prepaidCredits],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(name + ' must be a non-negative integer.');
    }
  }
}

export function applyUsageCharge(
  plan: ProductPlan,
  state: UsageLedgerState,
  request: UsageChargeRequest,
): UsageChargeResult {
  validateState(state);
  const eventId = validEventId(request.eventId);

  if (state.chargedEventIds.has(eventId)) {
    return {
      allowed: true,
      duplicate: true,
      chargedCredits: 0,
      nextState: copyState(state),
      denialReason: null,
    };
  }

  const quote = quoteToolUsage(
    plan,
    request.toolName,
    request.baseCredits ?? 1,
  );

  if (!quote.allowed) {
    return {
      allowed: false,
      duplicate: false,
      chargedCredits: 0,
      nextState: copyState(state),
      denialReason: quote.denialReason,
    };
  }

  const balance = authorizeUsageBalance(
    {
      usedCredits: state.usedCredits,
      requestedCredits: quote.credits,
      monthlyCredits: plan.monthlyCredits,
      prepaidCredits: state.prepaidCredits,
    },
    plan.billingMode,
  );

  if (!balance.allowed) {
    return {
      allowed: false,
      duplicate: false,
      chargedCredits: 0,
      nextState: copyState(state),
      denialReason: balance.denialReason,
    };
  }

  const charged = new Set(state.chargedEventIds);
  charged.add(eventId);

  return {
    allowed: true,
    duplicate: false,
    chargedCredits: quote.credits,
    nextState: {
      usedCredits:
        plan.billingMode === 'prepaid-metered'
          ? state.usedCredits
          : state.usedCredits + quote.credits,
      prepaidCredits:
        plan.billingMode === 'prepaid-metered'
          ? Math.max(0, balance.remainingCredits ?? 0)
          : state.prepaidCredits,
      chargedEventIds: charged,
    },
    denialReason: null,
  };
}

export interface PersistentUsageLedgerStore {
  /**
   * Implementations MUST atomically enforce unique (account, billing period,
   * eventId) and the balance/quota mutation in one transaction.
   */
  chargeAtomic(input: {
    accountId: string;
    periodKey: string;
    eventId: string;
    toolName: string;
    credits: number;
  }): Promise<
    | { status: 'charged' }
    | { status: 'duplicate' }
    | { status: 'quota-exhausted' }
  >;
}
