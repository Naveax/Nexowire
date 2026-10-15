import type {D1DatabaseLike} from './d1-control-plane-store.js';
import {utcQuotaDay} from './daily-quota-proposal.js';

/**
 * S2 transactional dual-ledger prototype ONLY. No production imports, routes,
 * migrations, or billing changes. Trusted daily/monthly limits and credits
 * MUST be computed by authoritative first-party services, not MCP clients.
 */
export interface TrustedDualQuotaRequest {
  quotaSubjectId: string;
  invocationId: string;
  acceptedAt: Date;
  dailyLimit: number;
  monthlyCredits: number;
  toolCredits: number;
  billingMode: 'free' | 'subscription';
}
export type DualQuotaResult = Readonly<{
  status: 'reserved'|'duplicate'|'daily-exhausted'|'monthly-exhausted';
  dayUtc: string;
  monthUtc: string;
  usedDaily: number;
  usedMonthlyCredits: number;
}>;

const validId=(value:string,name:string):string=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_.:@-]{8,128}$/.test(value)){
    throw new Error('Invalid '+name);
  }
  return value;
};
const validPositive=(value:number,name:string):number=>{
  if(!Number.isSafeInteger(value)||value<1){
    throw new Error('Invalid '+name);
  }
  return value;
};

export class ProposedDualQuotaD1Ledger {
  constructor(private readonly db:D1DatabaseLike){}
  async reserve(input:TrustedDualQuotaRequest):Promise<DualQuotaResult> {
    const subject=validId(input.quotaSubjectId,'quota subject');
    const id=validId(input.invocationId,'invocation ID');
    const daily=validPositive(input.dailyLimit,'daily limit');
    const monthly=validPositive(input.monthlyCredits,'monthly credits');
    const credits=validPositive(input.toolCredits,'tool credits');
    if(input.billingMode!=='free'&&input.billingMode!=='subscription'){
      throw new Error('Unsupported dual quota billing mode');
    }
    const day=utcQuotaDay(input.acceptedAt);
    const yyyy=input.acceptedAt.getUTCFullYear();
    const month=input.acceptedAt.getUTCMonth();
    const periodStart=new Date(Date.UTC(yyyy,month,1)).toISOString();
    const periodEnd=new Date(Date.UTC(yyyy,month+1,1)).toISOString();
    const monthKey=day.slice(0,7);
    const acceptedAt=input.acceptedAt.toISOString();

    const existing=async()=>{
      const row=await this.db.prepare(
        'SELECT invocation_id FROM dual_quota_reservations WHERE quota_subject_id = ? AND invocation_id = ?',
      ).bind(subject,id).first<{invocation_id:string}>();
      return row!==null;
    };
    const summary=async(status:DualQuotaResult['status']):Promise<DualQuotaResult>=>{
      const [dailyRow,monthRow]=await Promise.all([
        this.db.prepare(
          'SELECT used_requests FROM daily_request_periods WHERE quota_subject_id = ? AND day_key = ?',
        ).bind(subject,day).first<{used_requests:number}>(),
        this.db.prepare(
          'SELECT used_credits FROM quota_usage_periods WHERE quota_subject_id = ? AND period_key = ?',
        ).bind(subject,monthKey).first<{used_credits:number}>(),
      ]);
      const usedDaily=dailyRow?.used_requests??0;
      const usedMonthlyCredits=monthRow?.used_credits??0;
      if(!Number.isSafeInteger(usedDaily)||usedDaily<0||
         !Number.isSafeInteger(usedMonthlyCredits)||usedMonthlyCredits<0){
        throw new Error('Invalid persisted quota counters');
      }
      return {status,dayUtc:day,monthUtc:monthKey,usedDaily,usedMonthlyCredits};
    };

    // Database-level unique reservation key includes NO day/month component.
    if(await existing())return summary('duplicate');
    try {
      const result=await this.db.prepare(
        'INSERT INTO dual_quota_reservations (quota_subject_id, invocation_id, day_key, daily_limit, period_key, period_start, period_end, tool_credits, billing_mode, monthly_credits, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(subject,id,day,daily,monthKey,periodStart,periodEnd,credits,
        input.billingMode,monthly,acceptedAt).run();
      if(result.success===false || !Number.isSafeInteger(result.meta?.changes) ||
         Number(result.meta?.changes)<1){
        throw new Error('Unacknowledged dual D1 reservation');
      }
      return summary('reserved');
    }catch(error){
      // After a possibly committed remote write, never grant a second execution.
      if(await existing())return summary('duplicate');
      const message=error instanceof Error?error.message:String(error);
      if(message.includes('daily_request_limit_exhausted')){
        return summary('daily-exhausted');
      }
      if(message.includes('quota_exhausted')){
        return summary('monthly-exhausted');
      }
      // A provider failure or unknown commit status must fail closed.
      throw error;
    }
  }
}
