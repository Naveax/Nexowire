import type { D1DatabaseLike } from './d1-control-plane-store.js';
import { utcQuotaDay } from './daily-quota-proposal.js';

/**
 * S2 experimental D1 adapter. NOT called by production ControlPlaneService
 * or Worker: the owner-bound subject and limit MUST be resolved and verified
 * server-side before invoking this operation in any future integration.
 */
export interface TrustedDailyInvocationInput {
  quotaSubjectId: string;
  invocationId: string;
  acceptedAt: Date;
  /** From authenticated server-side plan/contract only. Never from MCP JSON. */
  trustedDailyLimit: number;
}
export type AtomicDailyInvocationResult = Readonly<{
  status: 'reserved' | 'duplicate' | 'exhausted';
  dayUtc: string;
  usedRequests: number;
  remainingRequests: number;
}>;

function validIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' ||
      !/^[a-zA-Z0-9_.:@-]{8,128}$/.test(value)) {
    throw new Error('Invalid ' + label);
  }
  return value;
}
function dailyLimit(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new Error('Invalid trusted daily limit');
  }
  return input;
}

export class DailyRequestD1Ledger {
  constructor(private readonly database: D1DatabaseLike) {}

  async reserve(input: TrustedDailyInvocationInput): Promise<AtomicDailyInvocationResult> {
    const subject = validIdentifier(input.quotaSubjectId, 'quota subject');
    const id = validIdentifier(input.invocationId, 'invocation');
    const day = utcQuotaDay(input.acceptedAt);
    const limit = dailyLimit(input.trustedDailyLimit);

    const existing = async (): Promise<boolean> =>
      (await this.database.prepare(
        'SELECT invocation_id FROM daily_request_invocations WHERE quota_subject_id = ? AND invocation_id = ?',
      ).bind(subject, id).first<{ invocation_id: string }>()) !== null;
    const used = async (): Promise<number> => {
      const row = await this.database.prepare(
        'SELECT used_requests FROM daily_request_periods WHERE quota_subject_id = ? AND day_key = ?',
      ).bind(subject, day).first<{ used_requests: number }>();
      if (!row) return 0;
      if (!Number.isSafeInteger(row.used_requests) || row.used_requests < 0) {
        throw new Error('Invalid daily D1 usage counter');
      }
      return row.used_requests;
    };
    const response = async (status: AtomicDailyInvocationResult['status']):
      Promise<AtomicDailyInvocationResult> => {
      const count = await used();
      return {
        status,
        dayUtc: day,
        usedRequests: count,
        remainingRequests: Math.max(0, limit - count),
      };
    };

    if (await existing()) return response('duplicate');

    try {
      // D1 executes each INSERT + its trigger as a single atomic statement.
      // No separate read-modify-write can grant a parallel over-quota call.
      const result = await this.database.prepare(
        'INSERT INTO daily_request_invocations (quota_subject_id, invocation_id, day_key, daily_limit, accepted_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(subject, id, day, limit, input.acceptedAt.toISOString()).run();
      if (result.success === false ||
          !Number.isSafeInteger(result.meta?.changes) ||
          Number(result.meta?.changes) < 1) {
        throw new Error('Daily D1 write not acknowledged');
      }
      return response('reserved');
    } catch (error) {
      // Duplicate may race the pre-check on a separate Worker instance.
      // An ambiguous committed insert is treated as a duplicate, never retried.
      if (await existing()) return response('duplicate');
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('daily_request_limit_exhausted')) {
        return response('exhausted');
      }
      // A DB outage or ambiguous outcome MUST NOT grant a free execution.
      throw error;
    }
  }
}
