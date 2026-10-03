import type {
  ProductFeature,
  ProductPlan,
} from './plans.js';
import { planHasFeature } from './plans.js';

export interface ZeroOwnerSpendPolicy {
  ownerPaidSpendAllowed: false;
  providerAutoUpgradeAllowed: false;
  postpaidUsageAllowed: false;
  hardStopWhenFreeCapacityExhausted: true;
  relayPolicy: 'direct-first-free-or-prepaid-only';
}

export const ZERO_OWNER_SPEND_POLICY: ZeroOwnerSpendPolicy =
  Object.freeze({
    ownerPaidSpendAllowed: false,
    providerAutoUpgradeAllowed: false,
    postpaidUsageAllowed: false,
    hardStopWhenFreeCapacityExhausted: true,
    relayPolicy: 'direct-first-free-or-prepaid-only',
  });

export interface UsageRule {
  prefix: string;
  feature?: ProductFeature;
  creditMultiplier: 1 | 2 | 3 | 4 | 5;
}

const PREMIUM_USAGE_RULES: readonly UsageRule[] = Object.freeze([
  {
    prefix: 'windows_virtual_pointer_',
    feature: 'private-pointer',
    creditMultiplier: 2,
  },
  {
    prefix: 'windows_private_pointer_',
    feature: 'private-pointer',
    creditMultiplier: 2,
  },
  {
    prefix: 'windows_private_keyboard_',
    feature: 'private-keyboard',
    creditMultiplier: 3,
  },
  {
    prefix: 'windows_private_screen_',
    feature: 'private-screen',
    creditMultiplier: 5,
  },
  {
    prefix: 'windows_private_desktop_',
    feature: 'private-screen',
    creditMultiplier: 5,
  },
]);

export interface UsageQuote {
  allowed: boolean;
  credits: number;
  multiplier: 1 | 2 | 3 | 4 | 5;
  requiredFeature: ProductFeature | null;
  denialReason: 'feature-not-in-plan' | null;
}

export function usageRuleForTool(toolName: string): UsageRule | null {
  const normalized = toolName.trim().toLowerCase();
  return (
    PREMIUM_USAGE_RULES.find((rule) =>
      normalized.startsWith(rule.prefix),
    ) ?? null
  );
}

export function quoteToolUsage(
  plan: ProductPlan,
  toolName: string,
  baseCredits = 1,
): UsageQuote {
  if (!Number.isInteger(baseCredits) || baseCredits < 1) {
    throw new Error('baseCredits must be a positive integer.');
  }

  const rule = usageRuleForTool(toolName);
  const multiplier = rule?.creditMultiplier ?? 1;
  const requiredFeature = rule?.feature ?? null;

  if (
    requiredFeature &&
    !planHasFeature(plan, requiredFeature)
  ) {
    return {
      allowed: false,
      credits: 0,
      multiplier,
      requiredFeature,
      denialReason: 'feature-not-in-plan',
    };
  }

  return {
    allowed: true,
    credits: baseCredits * multiplier,
    multiplier,
    requiredFeature,
    denialReason: null,
  };
}

export interface UsageBalanceInput {
  usedCredits: number;
  requestedCredits: number;
  monthlyCredits: number | null;
  prepaidCredits?: number;
}

export interface UsageBalanceDecision {
  allowed: boolean;
  remainingCredits: number | null;
  denialReason: 'monthly-quota-exhausted' | 'prepaid-balance-exhausted' | null;
}

export function authorizeUsageBalance(
  input: UsageBalanceInput,
  billingMode: ProductPlan['billingMode'],
): UsageBalanceDecision {
  for (const [name, value] of [
    ['usedCredits', input.usedCredits],
    ['requestedCredits', input.requestedCredits],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(name + ' must be a non-negative integer.');
    }
  }

  if (input.requestedCredits < 1) {
    throw new Error('requestedCredits must be at least 1.');
  }

  if (billingMode === 'prepaid-metered') {
    const prepaid = input.prepaidCredits ?? 0;
    if (!Number.isInteger(prepaid) || prepaid < 0) {
      throw new Error('prepaidCredits must be a non-negative integer.');
    }
    if (prepaid < input.requestedCredits) {
      return {
        allowed: false,
        remainingCredits: prepaid,
        denialReason: 'prepaid-balance-exhausted',
      };
    }
    return {
      allowed: true,
      remainingCredits: prepaid - input.requestedCredits,
      denialReason: null,
    };
  }

  const limit = input.monthlyCredits;
  if (limit === null) {
    return {
      allowed: true,
      remainingCredits: null,
      denialReason: null,
    };
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('monthlyCredits must be a positive integer or null.');
  }

  const remaining = Math.max(0, limit - input.usedCredits);
  if (remaining < input.requestedCredits) {
    return {
      allowed: false,
      remainingCredits: remaining,
      denialReason: 'monthly-quota-exhausted',
    };
  }
  return {
    allowed: true,
    remainingCredits: remaining - input.requestedCredits,
    denialReason: null,
  };
}
