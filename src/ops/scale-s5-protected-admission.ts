/**
 * Scale S5 proposed STRICT SHARE allocator (DEV/STAGING only).
 *
 * The transport scope and tenant weights MUST originate from trusted operator
 * configuration, NEVER from a client-supplied header/token/plan field.
 *
 * This strict non-work-conserving partition preserves each tenant's share even
 * if a noisy neighbor arrives first. Idle capacity is intentionally unused.
 * It is NOT an upstream provider ingress admission or paid entitlement.
 */
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export type FairConfig=Readonly<{
  globalRollingMinuteLimit:number;
  scope:string;
  tenants:ReadonlyArray<Readonly<{tenantId:string;weight:number}>>;
}>;
export type FairDecision=Readonly<{
  status:'reserved'|'duplicate'|'collision'|'tenant-exhausted'|'global-exhausted'|'unknown-tenant';
  tenantLimit:number;
  globalLimit:number;
  tenantRollingUsed:number;
  globalRollingUsed:number;
  retryAfterMs:number;
  authorizesToolExecution:false;
}>;
const identity=(s:string)=>typeof s==='string'&&/^[a-zA-Z0-9_.:@-]{8,128}$/.test(s);
const fingerprint=(s:string)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function calculateS5ProtectedShares(config:FairConfig):ReadonlyMap<string,number>{
  if(!identity(config.scope)||!Number.isSafeInteger(config.globalRollingMinuteLimit)||
    config.globalRollingMinuteLimit<1||config.globalRollingMinuteLimit>600||
    !Array.isArray(config.tenants)||config.tenants.length<1||config.tenants.length>256){
    throw new Error('Invalid trusted S5 fairness configuration');
  }
  const sorted=[...config.tenants].sort((a,b)=>a.tenantId.localeCompare(b.tenantId,'en'));
  if(sorted.some(t=>!identity(t.tenantId)||!Number.isSafeInteger(t.weight)||
    t.weight<1||t.weight>100))throw new Error('Invalid authenticated tenant or weight');
  if(new Set(sorted.map(t=>t.tenantId)).size!==sorted.length)throw new Error('Duplicate tenant');
  if(sorted.length>config.globalRollingMinuteLimit)throw new Error('Cannot protect all tenant shares');
  const total=sorted.reduce((a,t)=>a+t.weight,0);
  let allocated=0;
  const shares=sorted.map(t=>{
    const exact=t.weight*config.globalRollingMinuteLimit;
    const base=Math.floor(exact/total);
    allocated+=base;
    return {id:t.tenantId,base,remainder:exact%total};
  });
  // Hamilton apportionment; deterministic lexical tie-breaking.
  shares.sort((a,b)=>b.remainder-a.remainder||a.id.localeCompare(b.id,'en'));
  for(let i=0;i<config.globalRollingMinuteLimit-allocated;i++)shares[i]!.base++;
  if(shares.some(s=>s.base<1))throw new Error('Insufficient budget for guaranteed tenant share');
  return new Map(shares.map(s=>[s.id,s.base]));
}

export class ProposedS5ProtectedTenantAdmission{
  private readonly shares:ReadonlyMap<string,number>;
  private readonly policyHash:string;
  constructor(private readonly db:DatabaseSync,private readonly config:FairConfig){
    this.shares=calculateS5ProtectedShares(config);
    this.policyHash=createHash('sha256').update(JSON.stringify({
      scope:config.scope,limit:config.globalRollingMinuteLimit,
      shares:[...this.shares.entries()].sort(([a],[b])=>a.localeCompare(b,'en')),
    })).digest('hex');
  }
  tenantAllocation(){return new Map(this.shares)}
  private validNow(now:Date){
    if(!(now instanceof Date)||!Number.isSafeInteger(now.getTime()))throw new Error('Bad trusted clock');
    return now.getTime();
  }
  /**
   * Idempotent protected reservation. A duplicate never executes a native tool.
   * Fail-closed on database failures, clock regression and unknown principal.
   */
  observe(trustedTenant:string,invocationId:string,requestSha256:string,now:Date):FairDecision{
    if(!identity(invocationId)||!fingerprint(requestSha256))throw new Error('Invalid canonical invocation');
    const at=this.validNow(now),scope=this.config.scope;
    const tenantLimit=this.shares.get(trustedTenant);
    const make=(status:FairDecision['status'],tenantRollingUsed:number,globalRollingUsed:number,
      retryAfterMs=0):FairDecision=>({
      status,tenantLimit:tenantLimit??0,globalLimit:this.config.globalRollingMinuteLimit,
      tenantRollingUsed,globalRollingUsed,retryAfterMs,authorizesToolExecution:false,
    });
    if(tenantLimit===undefined)return make('unknown-tenant',0,0);
    let opened=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');opened=true;
      const persistedPolicy=this.db.prepare('SELECT policy_hash FROM s5_fair_policy WHERE scope=?')
        .get(scope) as {policy_hash:string}|undefined;
      if(persistedPolicy?.policy_hash!==undefined&&persistedPolicy.policy_hash!==this.policyHash){
        throw new Error('S5 fair policy mismatch: reconfiguration requires a controlled revision');
      }
      if(!persistedPolicy){
        this.db.prepare('INSERT INTO s5_fair_policy(scope,policy_hash) VALUES(?,?)')
          .run(scope,this.policyHash);
      }
      const clock=this.db.prepare('SELECT last_seen_ms FROM s5_fair_clock WHERE scope=?')
        .get(scope) as {last_seen_ms:number}|undefined;
      if(clock&&at<clock.last_seen_ms)throw new Error('S5 trusted clock rollback');
      const already=this.db.prepare('SELECT request_sha256,tenant_id FROM s5_fair_invocations WHERE scope=? AND invocation_id=?')
        .get(scope,invocationId) as {request_sha256:string;tenant_id:string}|undefined;
      const query=()=>this.db.prepare('SELECT tenant_id,admitted_at_ms FROM s5_fair_window WHERE scope=? AND admitted_at_ms>? AND admitted_at_ms<=?')
        .all(scope,at-60000,at) as Array<{tenant_id:string;admitted_at_ms:number}>;
      // Only roll the fixed admission window after checking replay.
      if(already){
        const rows=query(),used=rows.filter(r=>r.tenant_id===trustedTenant).length;
        this.db.exec('ROLLBACK');opened=false;
        return make(already.tenant_id===trustedTenant&&already.request_sha256===requestSha256
          ?'duplicate':'collision',used,rows.length);
      }
      this.db.prepare('DELETE FROM s5_fair_window WHERE scope=? AND admitted_at_ms<=?')
        .run(scope,at-60000);
      const rows=query(),used=rows.filter(r=>r.tenant_id===trustedTenant).length;
      if(used>=tenantLimit||rows.length>=this.config.globalRollingMinuteLimit){
        const oldest=rows.filter(r=>used>=tenantLimit?r.tenant_id===trustedTenant:true)
          .reduce((min,r)=>Math.min(min,r.admitted_at_ms),Infinity);
        const retry=Number.isFinite(oldest)?Math.max(1,oldest+60000-at):60000;
        this.db.exec('ROLLBACK');opened=false;
        return make(used>=tenantLimit?'tenant-exhausted':'global-exhausted',used,rows.length,retry);
      }
      this.db.prepare('INSERT INTO s5_fair_invocations(scope,invocation_id,tenant_id,request_sha256) VALUES(?,?,?,?)')
        .run(scope,invocationId,trustedTenant,requestSha256);
      this.db.prepare('INSERT INTO s5_fair_window(scope,tenant_id,admitted_at_ms) VALUES(?,?,?)')
        .run(scope,trustedTenant,at);
      this.db.prepare('INSERT INTO s5_fair_clock(scope,last_seen_ms) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET last_seen_ms=excluded.last_seen_ms')
        .run(scope,at);
      this.db.exec('COMMIT');opened=false;
      return make('reserved',used+1,rows.length+1);
    }catch(error){
      if(opened){try{this.db.exec('ROLLBACK')}catch{/* fail closed even after ambiguous write */}}
      throw error;
    }
  }
}
