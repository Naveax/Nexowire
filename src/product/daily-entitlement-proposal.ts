import type { BillingStore, BillingSubscriptionRecord } from './billing-store.js';
import type { ControlPlaneStore } from './control-plane-store.js';
import { PROPOSED_DAILY_REQUEST_LIMITS } from './daily-quota-proposal.js';

/**
 * S2 read-only entitlement proposal. This is NOT wired to the live Worker,
 * Hub, ledger, billing checkout or Cloudflare D1 migrations.
 *
 * Account ID must already be authenticated by the trusted control plane;
 * no client-provided plan, subject, limit or subscription can be passed here.
 */
export type DailyEntitlementResolution =
  | Readonly<{
      status: 'allowed';
      tier: 'free' | 'plus' | 'pro';
      quotaSubjectId: string;
      dailyRequestLimit: number;
    }>
  | Readonly<{
      status: 'denied';
      reason:
        | 'account-not-found'
        | 'account-subject-mismatch'
        | 'paid-plans-disabled'
        | 'provider-entitlement-missing'
        | 'enterprise-contract-required';
    }>;

export interface DailyEntitlementResolverStores {
  control: Pick<ControlPlaneStore,'getAccount'|'getQuotaSubject'>;
  billing: Pick<BillingStore,'listSubscriptions'>;
}
export interface DailyEntitlementResolverOptions {
  /**
   * Intentionally false by default. Only a future separately approved
   * service-side rollout may turn on paid entitlements.
   */
  paidEntitlementsEnabled?: boolean;
  now?: () => Date;
}
const reject=(reason:Extract<DailyEntitlementResolution,{status:'denied'}>['reason']):
  DailyEntitlementResolution=>({status:'denied',reason});

function isActiveRecord(record:BillingSubscriptionRecord,now:number):boolean {
  if(record.provider!=='lemonsqueezy' ||
     !record.providerSubscriptionId ||
     (record.status!=='active'&&record.status!=='on_trial'))return false;
  // Do not use a stale/forged future provider timestamp.
  const issuedAt=Date.parse(record.providerUpdatedAt);
  if(!Number.isFinite(issuedAt) || issuedAt>now)return false;
  if(record.endsAt!==null) {
    const ends=Date.parse(record.endsAt);
    if(!Number.isFinite(ends)||ends<=now)return false;
  }
  if(record.status==='on_trial') {
    const trial=Date.parse(record.trialEndsAt??'');
    if(!Number.isFinite(trial)||trial<=now)return false;
  }
  return true;
}

export class ProposedDailyEntitlementResolver {
  private readonly now:()=>Date;
  private readonly paidEnabled:boolean;
  constructor(
    private readonly stores:DailyEntitlementResolverStores,
    options:DailyEntitlementResolverOptions={},
  ) {
    this.now=options.now??(()=>new Date());
    this.paidEnabled=options.paidEntitlementsEnabled===true;
  }
  async resolve(authenticatedAccountId:string):Promise<DailyEntitlementResolution> {
    if(typeof authenticatedAccountId!=='string' ||
       !/^[a-zA-Z0-9._:-]{1,128}$/.test(authenticatedAccountId)) {
      return reject('account-not-found');
    }
    const account=await this.stores.control.getAccount(authenticatedAccountId);
    if(!account||account.id!==authenticatedAccountId) {
      return reject('account-not-found');
    }
    // Never give a plan without a real, server-owned quota subject.
    if(typeof account.quotaSubjectId!=='string' ||
       !/^[a-zA-Z0-9._:-]{1,128}$/.test(account.quotaSubjectId)) {
      return reject('account-subject-mismatch');
    }
    const subject=await this.stores.control.getQuotaSubject(account.quotaSubjectId);
    if(!subject||subject.id!==account.quotaSubjectId) {
      return reject('account-subject-mismatch');
    }
    if(account.planId==='free') {
      if(subject.kind!=='free-cluster')return reject('account-subject-mismatch');
      return {
        status:'allowed',tier:'free',quotaSubjectId:subject.id,
        dailyRequestLimit:PROPOSED_DAILY_REQUEST_LIMITS.free,
      };
    }
    if(account.planId==='custom')return reject('enterprise-contract-required');
    if(account.planId!=='plus'&&account.planId!=='pro') {
      return reject('provider-entitlement-missing');
    }
    if(!this.paidEnabled)return reject('paid-plans-disabled');
    if(subject.kind!=='subscription')return reject('account-subject-mismatch');
    const now=this.now().getTime();
    if(!Number.isFinite(now))throw new Error('Invalid entitlement clock');
    const records=await this.stores.billing.listSubscriptions(account.id);
    const eligible=records.some(record=>
      record.accountId===account.id &&
      record.planId===account.planId &&
      isActiveRecord(record,now),
    );
    if(!eligible)return reject('provider-entitlement-missing');
    return {
      status:'allowed',tier:account.planId,quotaSubjectId:subject.id,
      dailyRequestLimit:PROPOSED_DAILY_REQUEST_LIMITS[account.planId],
    };
  }
}
