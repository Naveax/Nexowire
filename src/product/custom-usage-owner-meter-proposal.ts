import type { DatabaseSync } from 'node:sqlite';

/**
 * DEV/STAGING only. Not imported by live Worker, Hub, billing or Agent.
 * Intended for a TRUSTED owner-controlled self-hosted quota coordinator,
 * never for client-controlled SQLite as the SaaS source of truth.
 *
 * 600/min is a default Secure MCP Tunnel (tunnel ID + calling app ID) limit,
 * NOT a general per-ChatGPT-user or Enterprise plan entitlement.
 */
export const CUSTOM_USAGE_PROPOSAL = Object.freeze({
  standardDaily: Object.freeze({free:1000,plus:5000,pro:10000}),
  customMinDaily: 100,
  customMaxDaily: 850_000,
  maxTransportRequestsPerRollingMinute: 600,
  theoreticalTransportDailyMax: 864_000,
});

export type CustomUsageTier = 'free'|'plus'|'pro'|'custom';
export type CustomUsageStatus = 'reserved'|'duplicate'|'daily-exhausted'|
  'transport-rate-exhausted'|'entitlement-not-verified';

export interface TrustedCustomUsageRequest {
  /** MUST come from real first-party owner auth, never request JSON. */
  quotaSubjectId: string;
  /** MUST come from authenticated OpenAI tunnel ID and calling app ID. */
  transportScope: string;
  invocationId: string;
  tier: CustomUsageTier;
  /** For custom only: MUST come from verified, purchased, versioned server entitlement. */
  authorizedCustomDailyLimit?: number;
  /** Explicit trusted server assertion. Never a client-provided boolean in production. */
  entitlementVerified: boolean;
  now: Date;
}
export interface CustomUsageDecision {
  status: CustomUsageStatus;
  dayUtc: string;
  dailyLimit: number;
  used: number;
  remaining: number;
  transportRollingMinuteUsed: number;
}

function safeId(value:string,name:string):string{
  if(typeof value!=='string'||!/^[a-zA-Z0-9_.:@-]{8,128}$/.test(value)){
    throw new Error('Invalid '+name);
  }
  return value;
}
export function resolveCustomDailyLimit(input:Pick<TrustedCustomUsageRequest,
  'tier'|'authorizedCustomDailyLimit'>):number {
  if(input.tier==='custom'){
    const n=input.authorizedCustomDailyLimit;
    if(!Number.isSafeInteger(n)||n===undefined ||
       n<CUSTOM_USAGE_PROPOSAL.customMinDaily ||
       n>CUSTOM_USAGE_PROPOSAL.customMaxDaily){
      throw new Error('Custom Usage must be an integer from 100 to 850000');
    }
    return n;
  }
  const standard=CUSTOM_USAGE_PROPOSAL.standardDaily;
  if(input.tier==='free'||input.tier==='plus'||input.tier==='pro'){
    if(input.authorizedCustomDailyLimit!==undefined){
      throw new Error('Custom allocation is not permitted for a standard tier');
    }
    return standard[input.tier];
  }
  throw new Error('Unknown Nexowire tier');
}
function nowMs(input:Date):number{
  if(!(input instanceof Date)||!Number.isSafeInteger(input.getTime())){
    throw new Error('Trusted quota clock unavailable');
  }
  return input.getTime();
}

/**
 * A synchronous SQLite proof: BEGIN IMMEDIATE gives a single writer across
 * connections into the SAME owner-hosted DB. Do not extrapolate to Cloudflare
 * D1 Workers/DO or to multiple machines without a shared durable authority.
 * The replay ledger is never pruned here: retention policy, space/cost metrics
 * and short-lived signed invocation freshness must be reviewed for production.
 */
export class ProposedOwnerHostedCustomUsageMeter {
  constructor(private readonly db:DatabaseSync) {}

  reserve(input:TrustedCustomUsageRequest):CustomUsageDecision {
    const subject=safeId(input.quotaSubjectId,'quota subject');
    const transport=safeId(input.transportScope,'transport scope');
    const invocation=safeId(input.invocationId,'invocation ID');
    const at=nowMs(input.now);
    const day=input.now.toISOString().slice(0,10);
    const limit=resolveCustomDailyLimit(input);
    const readUsed=()=>Number(
      (this.db.prepare(
        'SELECT used FROM custom_usage_daily WHERE quota_subject_id=? AND day_utc=?',
      ).get(subject,day) as {used:number}|undefined)?.used??0,
    );
    const readMinute=()=>Number(
      (this.db.prepare(
        'SELECT COUNT(*) AS n FROM custom_usage_transport_window '+
        'WHERE transport_scope=? AND accepted_at_ms>? AND accepted_at_ms<=?',
      ).get(transport,at-60000,at) as {n:number}).n,
    );
    let opened=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      opened=true;
      const used=readUsed();
      if(!Number.isSafeInteger(used)||used<0) {
        throw new Error('Invalid persisted usage counter');
      }
      const replay=this.db.prepare(
        'SELECT invocation_id FROM custom_usage_invocation_replay '+
        'WHERE quota_subject_id=? AND invocation_id=?',
      ).get(subject,invocation);
      if(replay){
        this.db.exec('ROLLBACK');opened=false;
        return {status:'duplicate',dayUtc:day,dailyLimit:limit,
          used,remaining:Math.max(0,limit-used),
          transportRollingMinuteUsed:readMinute()};
      }
      if(input.entitlementVerified!==true){
        this.db.exec('ROLLBACK');opened=false;
        return {status:'entitlement-not-verified',dayUtc:day,dailyLimit:limit,
          used,remaining:Math.max(0,limit-used),
          transportRollingMinuteUsed:readMinute()};
      }
      const clock=this.db.prepare(
        'SELECT last_seen_ms FROM custom_usage_tunnel_clock WHERE transport_scope=?',
      ).get(transport) as {last_seen_ms:number}|undefined;
      if(clock && at<clock.last_seen_ms) {
        throw new Error('Trusted transport clock moved backward; fail closed');
      }
      if(used>=limit){
        this.db.exec('ROLLBACK');opened=false;
        return {status:'daily-exhausted',dayUtc:day,dailyLimit:limit,
          used,remaining:0,transportRollingMinuteUsed:readMinute()};
      }
      // A 60-second rolling window, NOT fixed UTC minutes. A single scope is
      // shared across all subscribers using the same tunnel+calling app.
      const rolling=readMinute();
      if(rolling>=CUSTOM_USAGE_PROPOSAL.maxTransportRequestsPerRollingMinute){
        this.db.exec('ROLLBACK');opened=false;
        return {status:'transport-rate-exhausted',dayUtc:day,dailyLimit:limit,
          used,remaining:limit-used,transportRollingMinuteUsed:rolling};
      }
      this.db.prepare(
        'INSERT INTO custom_usage_invocation_replay '+
        '(quota_subject_id,invocation_id,day_utc,accepted_at_ms) VALUES (?,?,?,?)',
      ).run(subject,invocation,day,at);
      this.db.prepare(
        'INSERT INTO custom_usage_daily(quota_subject_id,day_utc,used) '+
        'VALUES(?,?,1) ON CONFLICT(quota_subject_id,day_utc) '+
        'DO UPDATE SET used=used+1',
      ).run(subject,day);
      this.db.prepare(
        'INSERT INTO custom_usage_transport_window(transport_scope,accepted_at_ms) '+
        'VALUES (?,?)',
      ).run(transport,at);
      this.db.prepare(
        'INSERT INTO custom_usage_tunnel_clock(transport_scope,last_seen_ms) '+
        'VALUES (?,?) ON CONFLICT(transport_scope) DO UPDATE '+
        'SET last_seen_ms=excluded.last_seen_ms',
      ).run(transport,at);
      this.db.prepare(
        'DELETE FROM custom_usage_transport_window WHERE transport_scope=? AND accepted_at_ms<=?',
      ).run(transport,at-60000);
      this.db.exec('COMMIT');opened=false;
      return {status:'reserved',dayUtc:day,dailyLimit:limit,
        used:used+1,remaining:limit-used-1,
        transportRollingMinuteUsed:rolling+1};
    }catch(e){
      if(opened){
        try{this.db.exec('ROLLBACK')}catch{
          // A failed rollback is an unknown-state error: NEVER grant.
        }
      }
      throw e;
    }
  }
}
