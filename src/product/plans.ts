export type ProductPlanId = 'free' | 'plus' | 'pro' | 'custom';

export type BillingMode =
  | 'free'
  | 'subscription'
  | 'prepaid-metered';

export type ProductFeature =
  | 'private-pointer'
  | 'private-keyboard'
  | 'private-screen'
  | 'automation'
  | 'priority-routing';

export interface ProductPlan {
  id: ProductPlanId;
  billingMode: BillingMode;
  monthlyCredits: number | null;
  maxDevices: number | null;
  maxConcurrentTasks: number | null;
  features: ReadonlySet<ProductFeature>;
}

function features(...values: ProductFeature[]): ReadonlySet<ProductFeature> {
  return new Set(values);
}

export const PRODUCT_PLANS: Readonly<Record<Exclude<ProductPlanId, 'custom'>, ProductPlan>> =
  Object.freeze({
    free: {
      id: 'free',
      billingMode: 'free',
      monthlyCredits: 1_000,
      maxDevices: 2,
      maxConcurrentTasks: 1,
      features: features(),
    },
    plus: {
      id: 'plus',
      billingMode: 'subscription',
      monthlyCredits: 100_000,
      maxDevices: 10,
      maxConcurrentTasks: 5,
      features: features(
        'private-pointer',
        'private-keyboard',
        'private-screen',
        'automation',
      ),
    },
    pro: {
      id: 'pro',
      billingMode: 'subscription',
      monthlyCredits: 500_000,
      maxDevices: 50,
      maxConcurrentTasks: 20,
      features: features(
        'private-pointer',
        'private-keyboard',
        'private-screen',
        'automation',
        'priority-routing',
      ),
    },
  });

export function createOwnerFullAccessFreePlan(): ProductPlan {
  return {
    id: 'free',
    billingMode: 'free',
    monthlyCredits: null,
    maxDevices: null,
    maxConcurrentTasks: null,
    features: features(
      'private-pointer',
      'private-keyboard',
      'private-screen',
      'automation',
      'priority-routing',
    ),
  };
}

export interface CustomPlanInput {
  billingMode: 'subscription' | 'prepaid-metered';
  monthlyCredits?: number | null;
  maxDevices?: number | null;
  maxConcurrentTasks?: number | null;
  features?: readonly ProductFeature[];
}

function positiveOrNull(
  name: string,
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer or null.');
  }
  return value;
}

export function createCustomPlan(input: CustomPlanInput): ProductPlan {
  return {
    id: 'custom',
    billingMode: input.billingMode,
    monthlyCredits: positiveOrNull(
      'monthlyCredits',
      input.monthlyCredits,
    ),
    maxDevices: positiveOrNull('maxDevices', input.maxDevices),
    maxConcurrentTasks: positiveOrNull(
      'maxConcurrentTasks',
      input.maxConcurrentTasks,
    ),
    features: features(...(input.features ?? [])),
  };
}

export function planHasFeature(
  plan: ProductPlan,
  feature: ProductFeature,
): boolean {
  return plan.features.has(feature);
}
