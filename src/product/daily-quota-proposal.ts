/**
 * Scale v2 S2 planning contract ONLY. This module is intentionally NOT
 * imported by the live Worker, D1 usage ledger, billing or Hub.
 *
 * Counts accepted *logical hosted tool invocations* (not HTTP Worker fetches,
 * weighted legacy credits, compute time, relay bytes, or user messages).
 */
export const PROPOSED_DAILY_REQUEST_LIMITS = Object.freeze({
  free: 1_000,
  plus: 5_000,
  pro: 10_000,
});
export type ProposedDailyTier = keyof typeof PROPOSED_DAILY_REQUEST_LIMITS | 'enterprise';
export type DailyQuotaOutcome = 'reserved' | 'duplicate' | 'denied';
export type DailyQuotaDenial =
  | 'daily-request-limit-exhausted'
  | 'unverified-paid-entitlement'
  | 'simulation-capacity-exhausted';

export interface ProposedDailyRequest {
  accountKey: string;
  invocationId: string;
  tier: ProposedDailyTier;
  at: Date;
  /** For Plus/Pro/Enterprise, MUST come from a trusted billing server in a future production system. */
  trustedPaidEntitlement?: boolean;
  /** Finite, positive, contracted request/day ceiling. Never null or "unlimited" by default. */
  enterpriseRequestLimit?: number;
}

export interface DailyRequestReservation {
  status: DailyQuotaOutcome;
  denial: DailyQuotaDenial | null;
  dayUtc: string;
  dailyLimit: number;
  dayUsed: number;
  remaining: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return value;
}
function key(value: string, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      !/^[A-Za-z0-9_.:@-]+$/.test(value)) {
    throw new Error(name + ' is invalid');
  }
  return value;
}
export function utcQuotaDay(at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new Error('Invalid UTC quota timestamp');
  }
  return at.toISOString().slice(0, 10);
}
export function proposedDailyLimit(
  tier: ProposedDailyTier,
  enterpriseRequestLimit?: number,
): number {
  if (tier === 'enterprise') {
    return positiveInteger(enterpriseRequestLimit ?? 0,'enterpriseRequestLimit');
  }
  const limit = PROPOSED_DAILY_REQUEST_LIMITS[tier];
  if (!limit) throw new Error('Unknown tier');
  return limit;
}

/**
 * A single-process TEST-ONLY replay/period simulator. NEVER use as a D1
 * replacement. Keeps cross-UTC-day replay IDs to catch risky rollover logic.
 */
export class ProposedDailyQuotaSimulator {
  private readonly daily = new Map<string, number>();
  private readonly globallyReserved = new Map<string, {dayUtc:string}>();

  constructor(private readonly maxRecordedInvocations=50_000) {
    positiveInteger(maxRecordedInvocations,'maxRecordedInvocations');
  }

  reserve(input: ProposedDailyRequest): DailyRequestReservation {
    const owner = key(input.accountKey,'accountKey');
    const invocation = key(input.invocationId,'invocationId');
    const day = utcQuotaDay(input.at);
    const limit = proposedDailyLimit(input.tier,input.enterpriseRequestLimit);
    const dailyKey = owner.length + ':' + owner + ':' + day;
    const replayKey = owner.length + ':' + owner + ':' + invocation;
    const used = this.daily.get(dailyKey) ?? 0;
    const remaining = Math.max(0,limit-used);
    const finish = (status:DailyQuotaOutcome, denial:DailyQuotaDenial|null):
      DailyRequestReservation => ({
        status,denial,dayUtc:day,dailyLimit:limit,dayUsed:used,
        remaining,
      });

    // Same logical invocation MUST NOT become a fresh operation at UTC rollover.
    if (this.globallyReserved.has(replayKey)) return finish('duplicate',null);

    if (input.tier !== 'free' && input.trustedPaidEntitlement !== true) {
      return finish('denied','unverified-paid-entitlement');
    }
    if (used >= limit) return finish('denied','daily-request-limit-exhausted');

    if (this.globallyReserved.size >= this.maxRecordedInvocations) {
      return finish('denied','simulation-capacity-exhausted');
    }
    if (!Number.isSafeInteger(used+1)) throw new Error('Counter overflow');
    this.daily.set(dailyKey,used+1);
    this.globallyReserved.set(replayKey,{dayUtc:day});
    return {status:'reserved',denial:null,dayUtc:day,dailyLimit:limit,
      dayUsed:used+1,remaining:limit-used-1};
  }
}
