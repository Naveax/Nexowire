/** SYNTHETIC / OFFLINE EXAMPLE. Not an authoritative quota engine. No IO. */
export type PolicyVersion = 'free-monthly-weighted-example-v1' | 'daily-logical-proposal-example-v1';
export interface ExampleInput {
  policyVersion: PolicyVersion;
  tier: 'free' | 'plus' | 'pro';
  at: string;
  events: { invocationId: string; kind: 'ordinary' | 'skill'; quantity: number }[];
}
export function quotaExample(input: ExampleInput) {
  if (!input || !['free-monthly-weighted-example-v1','daily-logical-proposal-example-v1'].includes(input.policyVersion)) throw new Error('Explicit supported policyVersion required');
  const monthly = input.policyVersion === 'free-monthly-weighted-example-v1';
  if (!['free','plus','pro'].includes(input.tier) || (monthly && input.tier !== 'free')) throw new Error('Tier unavailable for policy');
  // One explicit UTC period per input; callers supply only that period’s synthetic events.
  if (typeof input.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.at)) throw new Error('Canonical UTC timestamp required');
  const date = new Date(input.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input.at) throw new Error('Invalid UTC timestamp');
  if (!Array.isArray(input.events)) throw new Error('Events array required');
  const limit = monthly ? 1000 : ({free:1000,plus:5000,pro:10000})[input.tier];
  const seen = new Set<string>();
  const warnings: string[] = ['SYNTHETIC_EXAMPLE_NOT_AUTHORITY'];
  if (!monthly) warnings.push('PROPOSAL_NOT_ACTIVE_NO_PAID_ENTITLEMENT_GRANTED');
  let used = 0, ordinaryWeighted = 0, skillWeighted = 0;
  const decisions: {invocationId:string; status:'accepted'|'duplicate'|'denied'; units:number}[] = [];
  for (const event of input.events) {
    if (!event || typeof event.invocationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(event.invocationId)) throw new Error('Invalid synthetic invocation ID');
    // One row describes one logical invocation. Aggregating counts under one replay key is ambiguous.
    if (!Number.isSafeInteger(event.quantity) || event.quantity !== 1) throw new Error('Quantity must be 1; negative/zero/fractional/aggregated amounts forbidden');
    if (event.kind !== 'ordinary' && event.kind !== 'skill') throw new Error('Invalid kind');
    if (seen.has(event.invocationId)) {
      warnings.push('DUPLICATE_ID:'+event.invocationId+'; no second execution implied');
      decisions.push({invocationId:event.invocationId,status:'duplicate',units:0}); continue;
    }
    seen.add(event.invocationId);
    const weighted = event.kind === 'skill' ? 5 : 1;
    const units = monthly ? weighted : 1;
    if (used + units > limit) { decisions.push({invocationId:event.invocationId,status:'denied',units:0}); continue; }
    used += units;
    if (event.kind === 'skill') skillWeighted += weighted; else ordinaryWeighted += weighted;
    decisions.push({invocationId:event.invocationId,status:'accepted',units});
  }
  const start = new Date(date);
  start.setUTCHours(0,0,0,0);
  if (monthly) start.setUTCDate(1);
  const reset = new Date(start);
  if (monthly) reset.setUTCMonth(reset.getUTCMonth()+1); else reset.setUTCDate(reset.getUTCDate()+1);
  return { policyVersion:input.policyVersion, evidence:'synthetic', period:monthly?'UTC calendar month':'UTC day (proposal)', periodStartUtc:start.toISOString(), resetUtc:reset.toISOString(), unit:monthly?'weighted units':'logical invocations', limit,used,remaining:limit-used, weightedIllustration:{ordinary1x:ordinaryWeighted,skill5x:skillWeighted},decisions,warnings };
}
