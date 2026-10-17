import type { DatabaseSync } from 'node:sqlite';
import {
  ProposedAllIngressTransportMeter,
  type LocalFirstTransportBudgetHook,
} from '../mcp/all-ingress-transport-meter-proposal.js';
import {
  createSignedStagingTransportBudget,
  type SignedTransportRoute,
} from '../mcp/signed-transport-scope-proposal.js';
import {
  resolveCustomDailyLimit,
  type CustomUsageTier,
} from './custom-usage-owner-meter-proposal.js';

/**
 * STAGING ONLY: this entire object MUST run on an owner-controlled existing
 * server. It does not start a network server, authenticate real OAuth, modify
 * billing, or grant native-Agent execution. It demonstrates a SINGLE durable
 * central quota decision across independently connected client machines.
 *
 * The caller does not provide an entitlement, a "verified" bool, account ID
 * or daily maximum. Only the trusted FIRST-PARTY authenticator returns account
 * identity + token epoch; DB ownership/access and plan are checked in the SAME
 * SQLite transaction as the daily reservation.
 */
export interface StagingVerifiedPrincipal {
  accountId:string;
  sessionGeneration:number;
}
export type StagingAuthenticateToken =
  (bearerToken:string)=>Promise<StagingVerifiedPrincipal|null>;

export interface StagingLogicalToolRequest {
  bearerToken:string;
  deviceId:string;
  invocationId:string;
  /** Must be derived from the canonical server-side dispatcher request. */
  toolFingerprint:string;
  /** Must be assigned by server tool classification, not MCP parameters. */
  operationClass:'read'|'write';
}
export interface StagingOwnerQuotaDecision {
  status:'reserved'|'duplicate'|'unauthorized'|'device-denied'|
    'daily-exhausted'|'invocation-collision';
  dayUtc:string;
  dailyLimit:number;
  used:number;
  remaining:number;
  /** This is an admission decision, not permission to skip broker/tool checks. */
  authorizesToolExecution:false;
}

function validId(value:string,field:string):string {
  if(typeof value!=='string' || !/^[A-Za-z0-9_:.@-]{8,128}$/.test(value)){
    throw new Error('Invalid '+field);
  }
  return value;
}
function validFingerprint(value:string):string {
  if(typeof value!=='string'|| !/^[a-f0-9]{64}$/.test(value)){
    throw new Error('Invalid canonical tool fingerprint');
  }
  return value;
}
function currentTime(now:Date):number {
  if(!(now instanceof Date)||!Number.isSafeInteger(now.getTime())){
    throw new Error('Trusted owner quota clock invalid');
  }
  return now.getTime();
}

/** Reads all entitlement, account session, device owner and daily counters
 * inside one BEGIN IMMEDIATE on an owner-operated *single* shared database.
 * Client-controlled SQLite cannot be an authoritative SaaS meter.
 */
export class ProposedTrustedOwnerQuotaAuthority {
  private readonly ingress:ProposedAllIngressTransportMeter;
  constructor(
    private readonly db:DatabaseSync,
    private readonly authenticate:StagingAuthenticateToken,
    private readonly clock:()=>Date=()=>new Date(),
  ){
    this.ingress=new ProposedAllIngressTransportMeter(db);
  }

  /** Creates the ONLY transport entrypoint for this staging authority.
   * The scope is derived from an operator-signed route, NEVER supplied as an
   * arbitrary customer string or forwarded HTTP header. Each invocation is
   * reverified against the trusted owner generation accessor.
   */
  bindSignedIngress(input:{
    signedRoute:SignedTransportRoute;
    operatorPublicKeyPem:string;
    expectedIssuer:string;
    expectedKeyId:string;
    expectedPublicResourceUrl:string;
    minimumRouteGeneration:()=>number;
  }):LocalFirstTransportBudgetHook {
    return createSignedStagingTransportBudget({
      route:input.signedRoute,
      operatorPublicKeyPem:input.operatorPublicKeyPem,
      expectedIssuer:input.expectedIssuer,
      expectedKeyId:input.expectedKeyId,
      expectedPublicResourceUrl:input.expectedPublicResourceUrl,
      minimumRouteGeneration:input.minimumRouteGeneration,
      meter:this.ingress,
      clock:this.clock,
    });
  }

  /** Call ONLY for an already-admitted canonical MCP tool invocation, after
   * OAuth and per-tool consent checks. This method RECHECKS first-party
   * account epoch and device ownership, and reserves ONE logical daily unit.
   *
   * This intentionally has NO second 600/min window: the ingress-wide scope
   * is the one canonical rolling transport budget from PR #514.
   */
  async reserveLogicalTool(input:StagingLogicalToolRequest):
    Promise<StagingOwnerQuotaDecision> {
    const device=validId(input.deviceId,'device ID');
    const invocation=validId(input.invocationId,'invocation ID');
    const fingerprint=validFingerprint(input.toolFingerprint);
    if(input.operationClass!=='read'&&input.operationClass!=='write'){
      throw new Error('Operation class not server-verified');
    }
    if(typeof input.bearerToken!=='string'||input.bearerToken.length<16 ||
      input.bearerToken.length>8192){
      throw new Error('Invalid authentication token input');
    }
    // The real implementation MUST replace this injected DEV verifier with
    // session-epoch-aware trusted first-party OAuth validation.
    const p=await this.authenticate(input.bearerToken);
    const now=this.clock();
    const at=currentTime(now);
    const dayUtc=now.toISOString().slice(0,10);
    const result=(status:StagingOwnerQuotaDecision['status'],
      dailyLimit:number,used:number):StagingOwnerQuotaDecision=>({
      status,dayUtc,dailyLimit,used,remaining:Math.max(0,dailyLimit-used),
      authorizesToolExecution:false,
    });
    if(!p) return result('unauthorized',0,0);
    const subject=validId(p.accountId,'authenticated account');
    if(!Number.isSafeInteger(p.sessionGeneration)||p.sessionGeneration<0){
      throw new Error('Trusted OAuth session generation invalid');
    }
    let begun=false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      begun=true;
      const account=this.db.prepare(
        'SELECT tier,custom_daily_limit,enabled,session_generation '+
        'FROM proposed_owner_quota_accounts WHERE account_id=?',
      ).get(subject) as {
        tier:CustomUsageTier;custom_daily_limit:number|null;
        enabled:number;session_generation:number;
      }|undefined;
      if(!account||account.enabled!==1 ||
         account.session_generation!==p.sessionGeneration){
        this.db.exec('ROLLBACK');begun=false;
        return result('unauthorized',0,0);
      }
      const limit=resolveCustomDailyLimit({
        tier:account.tier,
        ...(account.tier==='custom'
          ? {authorizedCustomDailyLimit:account.custom_daily_limit??undefined}:{}),
      });
      const used=Number((this.db.prepare(
        'SELECT used FROM proposed_owner_quota_daily '+
        'WHERE account_id=? AND day_utc=?',
      ).get(subject,dayUtc) as {used:number}|undefined)?.used??0);
      if(!Number.isSafeInteger(used)||used<0){
        throw new Error('Persisted daily usage corrupt; deny');
      }
      const clockRow=this.db.prepare(
        'SELECT last_seen_ms FROM proposed_owner_quota_account_clock WHERE account_id=?',
      ).get(subject) as {last_seen_ms:number}|undefined;
      if(clockRow && at<clockRow.last_seen_ms){
        throw new Error('Trusted clock rollback detected; deny');
      }
      const deviceRow=this.db.prepare(
        'SELECT owner_account_id,enabled,access_mode FROM proposed_owner_quota_devices '+
        'WHERE device_id=?',
      ).get(device) as {
        owner_account_id:string;enabled:number;access_mode:'safe'|'full';
      }|undefined;
      if(!deviceRow||deviceRow.owner_account_id!==subject||
        deviceRow.enabled!==1 ||
        (input.operationClass==='write'&&deviceRow.access_mode!=='full')){
        this.db.exec('ROLLBACK');begun=false;
        return result('device-denied',limit,used);
      }
      // Replay is AFTER account/session/device authorization, so revocation
      // remains effective even for an already-reserved invocation ID.
      const prior=this.db.prepare(
        'SELECT device_id,tool_fingerprint FROM proposed_owner_quota_invocations '+
        'WHERE account_id=? AND invocation_id=?',
      ).get(subject,invocation) as {
        device_id:string;tool_fingerprint:string;
      }|undefined;
      if(prior){
        this.db.exec('ROLLBACK');begun=false;
        return result(
          prior.device_id===device && prior.tool_fingerprint===fingerprint
            ? 'duplicate':'invocation-collision',
          limit,used,
        );
      }
      if(used>=limit){
        this.db.exec('ROLLBACK');begun=false;
        return result('daily-exhausted',limit,used);
      }
      this.db.prepare(
        'INSERT INTO proposed_owner_quota_invocations '+
        '(account_id,invocation_id,device_id,tool_fingerprint,day_utc,accepted_at_ms) '+
        'VALUES(?,?,?,?,?,?)',
      ).run(subject,invocation,device,fingerprint,dayUtc,at);
      this.db.prepare(
        'INSERT INTO proposed_owner_quota_daily(account_id,day_utc,used) '+
        'VALUES(?,?,1) ON CONFLICT(account_id,day_utc) DO UPDATE SET used=used+1',
      ).run(subject,dayUtc);
      this.db.prepare(
        'INSERT INTO proposed_owner_quota_account_clock(account_id,last_seen_ms) '+
        'VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms',
      ).run(subject,at);
      this.db.exec('COMMIT');begun=false;
      return result('reserved',limit,used+1);
    }catch(error){
      if(begun){try{this.db.exec('ROLLBACK')}catch{
        // DB state uncertain: NEVER authorize any execution.
      }}
      throw error;
    }
  }
}
