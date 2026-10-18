import type { D1DatabaseLike } from './d1-control-plane-store.js';
import { utcQuotaDay } from './daily-quota-proposal.js';
import type { QuotaEntitlementDecisionV2 } from './subscription-entitlements-v2-proposal.js';

/**
 * DORMANT S2/S4 adapter. Requires the dev/staging fixture:
 * scale-v2-tenant-minute-dual-staging.sql. No live imports or migrations.
 * Single outer INSERT and triggers reserve minute, day and legacy weighted
 * monthly quota atomically. A duplicate is ALWAYS denied dispatch, not a
 * second free execution. Unknown D1 state throws and also denies dispatch.
 */
type Allowed = Extract<QuotaEntitlementDecisionV2, {status:'allowed'}>;
export type V2ReservationResult = Readonly<{
  status: 'reserved' | 'duplicate' | 'conflict' | 'minute-exhausted'
    | 'daily-exhausted' | 'monthly-exhausted' | 'revoked';
  quotaSubjectId: string;
  invocationId: string;
  dayUtc: string;
  usedDaily: number;
  usedMonthlyCredits: number;
  usedRollingMinute: number;
}>;

export interface TrustedV2Reservation {
  /** Constructed from signed-auth + immutable server-side contract snapshot. */
  entitlement: Allowed;
  invocationId: string;
  /** SHA-256 of server-owned canonical root action, target and normalized params. */
  requestFingerprint: string;
  now: Date;
  /** Server's weighted tool quote: 1 ordinary, 5 special skill. */
  toolCredits: number;
}

const validId=(v:string,n:string):string=>{
  if(typeof v!=='string'||!/^[A-Za-z0-9_.:@-]{8,128}$/.test(v)){
    throw new Error('INVALID_'+n);
  }
  return v;
};
const positive=(v:number,n:string):number=>{
  if(!Number.isSafeInteger(v)||v<1)throw new Error('INVALID_'+n);
  return v;
};

export class ProposedV2QuotaD1Ledger {
  constructor(private readonly db:D1DatabaseLike) {}

  async reserve(input:TrustedV2Reservation):Promise<V2ReservationResult> {
    const a=input.entitlement;
    if(!a||a.status!=='allowed')throw new Error('V2_ENTITLEMENT_REQUIRED');
    const account=validId(a.accountId,'ACCOUNT');
    const tenant=validId(a.tenantId,'TENANT');
    const subject=validId(a.quotaSubjectId,'SUBJECT');
    const invocation=validId(input.invocationId,'INVOCATION');
    const fingerprint=input.requestFingerprint;
    if(typeof fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(fingerprint)){
      throw new Error('INVALID_REQUEST_FINGERPRINT');
    }
    const device=a.deviceId===null?null:validId(a.deviceId,'DEVICE');
    const dayLimit=positive(a.dailyLimit,'DAILY_LIMIT');
    const minuteLimit=a.rollingMinuteLimit===null?null:
      positive(a.rollingMinuteLimit,'MINUTE_LIMIT');
    const monthly=positive(a.monthlyWeightedCredits,'MONTHLY_LIMIT');
    const revision=positive(a.revision,'ENTITLEMENT_REVISION');
    const credits=positive(input.toolCredits,'TOOL_CREDITS');
    const now=input.now;
    const day=utcQuotaDay(now);
    const atMs=now.getTime();
    if(!Number.isSafeInteger(atMs)||atMs<0)throw new Error('V2_CLOCK_INVALID');
    const period=day.slice(0,7);
    const yy=now.getUTCFullYear(), mm=now.getUTCMonth();
    const start=new Date(Date.UTC(yy,mm,1)).toISOString();
    const end=new Date(Date.UTC(yy,mm+1,1)).toISOString();
    const mode=a.tier==='free'?'free':'subscription';

    const existing=async():Promise<'duplicate'|'conflict'|null>=>{
      const row=await this.db.prepare(
        'SELECT account_id,tenant_id,device_id,request_fingerprint FROM v2_quota_reservations WHERE quota_subject_id=? AND invocation_id=?',
      ).bind(subject,invocation).first<{
        account_id:string;tenant_id:string;device_id:string|null;request_fingerprint:string;
      }>();
      if(!row)return null;
      if(row.account_id!==account || row.tenant_id!==tenant ||
         row.device_id!==device || row.request_fingerprint!==fingerprint) return 'conflict';
      return 'duplicate';
    };
    const stats=async(status:V2ReservationResult['status']):Promise<V2ReservationResult>=>{
      const d=await this.db.prepare(
        'SELECT used_requests AS n FROM daily_request_periods WHERE quota_subject_id=? AND day_key=?',
      ).bind(subject,day).first<{n:number}>();
      const m=await this.db.prepare(
        'SELECT used_credits AS n FROM quota_usage_periods WHERE quota_subject_id=? AND period_key=?',
      ).bind(subject,period).first<{n:number}>();
      const rolling=await this.db.prepare(
        'SELECT COUNT(*) AS n FROM v2_quota_minute_events WHERE quota_subject_id=? AND accepted_at_ms>? AND accepted_at_ms<=?',
      ).bind(subject,atMs-60000,atMs).first<{n:number}>();
      const usedDaily=d?.n??0, usedMonthlyCredits=m?.n??0, usedRollingMinute=rolling?.n??0;
      if(![usedDaily,usedMonthlyCredits,usedRollingMinute].every(
        x=>Number.isSafeInteger(x)&&x>=0))throw new Error('V2_CORRUPT_COUNTER');
      return {status,quotaSubjectId:subject,invocationId:invocation,
        dayUtc:day,usedDaily,usedMonthlyCredits,usedRollingMinute};
    };

    const prior=await existing();
    if(prior)return stats(prior);
    try{
      const result=await this.db.prepare(
        'INSERT INTO v2_quota_reservations (account_id,tenant_id,quota_subject_id,device_id,invocation_id,request_fingerprint,plan_tier,entitlement_revision,day_key,accepted_at,accepted_at_ms,daily_limit,minute_limit,period_key,period_start,period_end,tool_credits,monthly_credits,billing_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(account,tenant,subject,device,invocation,fingerprint,a.tier,revision,
        day,now.toISOString(),atMs,dayLimit,minuteLimit,period,start,end,
        credits,monthly,mode).run();
      if(result.success===false || !Number.isSafeInteger(result.meta?.changes) ||
         Number(result.meta?.changes)<1)throw new Error('V2_UNACKNOWLEDGED_WRITE');
      return stats('reserved');
    }catch(error){
      // A committed but unacknowledged write must never execute the root twice.
      const committed=await existing();
      if(committed)return stats(committed);
      const message=error instanceof Error?error.message:String(error);
      if(message.includes('v2_minute_exhausted'))return stats('minute-exhausted');
      if(message.includes('daily_request_limit_exhausted'))return stats('daily-exhausted');
      if(message.includes('quota_exhausted'))return stats('monthly-exhausted');
      if(message.includes('v2_entitlement_epoch_invalid') ||
         message.includes('v2_account_subject_invalid') ||
         message.includes('v2_subject_kind_mismatch') ||
         message.includes('v2_wrong_device_owner') ||
         message.includes('v2_paid_tenant_conflict'))return stats('revoked');
      // Schema, clock, network and SQLite contention all fail closed.
      throw error;
    }
  }
}
