import type { DatabaseSync } from 'node:sqlite';

/**
 * DEV/STAGING ONLY: counts ALL arrivals to a trusted ingress, regardless of
 * MCP method, metadata/discovery, bearer, eventual authorization or response.
 * This enforces the LOCAL forwarding budget, not the OpenAI-hosted tunnel's
 * already-counted request rate. Never imported by a live provider connector.
 *
 * The scope MUST be set by authenticated upstream routing / operator config
 * as (tunnel identity + calling application), or provider fallback
 * (tunnel identity + calling user). NEVER derive from untrusted Host, Origin,
 * Authorization, X-Forwarded-* headers or raw user tool arguments.
 */
export interface IngressTransportAdmission {
  allowed: boolean;
  observedTotal: number;
  admittedTotal: number;
  rejectedTotal: number;
  admittedRollingMinute: number;
  retryAfterMs: number;
}

export const DEFAULT_INGRESS_MINUTE_LIMIT=600;

/** Applies to one trusted, shared local writer. A larger value is rejected. */
export function verifyIngressMinuteLimit(input:number):number {
  if(!Number.isSafeInteger(input)||input<1||input>DEFAULT_INGRESS_MINUTE_LIMIT){
    throw new Error('Local ingress minute budget must be 1..600');
  }
  return input;
}
function trustedScope(input:string):string {
  if(typeof input!=='string'||input.length<8||input.length>128||
      !/^[A-Za-z0-9_:.@-]+$/.test(input)){
    throw new Error('Untrusted transport scope');
  }
  return input;
}
function serverClock(input:Date):number {
  if(!(input instanceof Date)||!Number.isSafeInteger(input.getTime())){
    throw new Error('Untrusted ingress clock');
  }
  return input.getTime();
}

export class ProposedAllIngressTransportMeter {
  private readonly minuteLimit:number;

  constructor(private readonly db:DatabaseSync,limit=DEFAULT_INGRESS_MINUTE_LIMIT){
    this.minuteLimit=verifyIngressMinuteLimit(limit);
  }

  /** Called for EVERY attempted request on the associated origin, before auth. */
  observe(trustedTransportScope:string,now:Date):IngressTransportAdmission {
    const scope=trustedScope(trustedTransportScope);
    const at=serverClock(now);
    let tx=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      tx=true;
      const last=this.db.prepare(
        'SELECT last_seen_ms FROM proposed_ingress_transport_clock WHERE scope_id=?',
      ).get(scope) as {last_seen_ms:number}|undefined;
      if(last && at<last.last_seen_ms){
        throw new Error('Trusted ingress clock moved backward; deny all');
      }
      // Remove only expired window samples for THIS authenticated scope,
      // keeping a separate monotonic total of ALL arrivals including 429s.
      this.db.prepare(
        'DELETE FROM proposed_ingress_transport_admissions '+
        'WHERE scope_id=? AND admitted_at_ms<=?',
      ).run(scope,at-60000);
      const rolling=Number((this.db.prepare(
        'SELECT COUNT(*) AS n FROM proposed_ingress_transport_admissions '+
        'WHERE scope_id=? AND admitted_at_ms>? AND admitted_at_ms<=?',
      ).get(scope,at-60000,at) as {n:number}).n);
      const allowed=rolling<this.minuteLimit;
      if(allowed){
        this.db.prepare(
          'INSERT INTO proposed_ingress_transport_admissions(scope_id,admitted_at_ms) '+
          'VALUES(?,?)',
        ).run(scope,at);
      }
      this.db.prepare(
        'INSERT INTO proposed_ingress_transport_totals(scope_id,observed,admitted,rejected) '+
        'VALUES(?,1,?,?) ON CONFLICT(scope_id) DO UPDATE SET '+
        'observed=observed+1, admitted=admitted+excluded.admitted, '+
        'rejected=rejected+excluded.rejected',
      ).run(scope,allowed?1:0,allowed?0:1);
      this.db.prepare(
        'INSERT INTO proposed_ingress_transport_clock(scope_id,last_seen_ms) '+
        'VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE '+
        'SET last_seen_ms=excluded.last_seen_ms',
      ).run(scope,at);
      const totals=this.db.prepare(
        'SELECT observed,admitted,rejected FROM proposed_ingress_transport_totals '+
        'WHERE scope_id=?',
      ).get(scope) as {observed:number,admitted:number,rejected:number};
      let retryAfterMs=0;
      if(!allowed){
        const oldest=this.db.prepare(
          'SELECT MIN(admitted_at_ms) AS oldest FROM proposed_ingress_transport_admissions '+
          'WHERE scope_id=?',
        ).get(scope) as {oldest:number|null};
        if(oldest.oldest===null) throw new Error('Rate window inconsistent');
        retryAfterMs=Math.max(1,oldest.oldest+60000-at);
      }
      this.db.exec('COMMIT');
      tx=false;
      return {
        allowed,observedTotal:totals.observed,
        admittedTotal:totals.admitted,rejectedTotal:totals.rejected,
        admittedRollingMinute:rolling+(allowed?1:0),retryAfterMs,
      };
    }catch(error){
      if(tx){try{this.db.exec('ROLLBACK')}catch{
        // Unknown state means NO admission. A caller must reject.
      }}
      throw error;
    }
  }
}

/** Interface used only by the explicitly injected staging ingress hook. */
export interface LocalFirstTransportBudgetHook {
  readonly trustedScope:string;
  readonly meter: Pick<ProposedAllIngressTransportMeter,'observe'>;
  readonly clock?:()=>Date;
}
