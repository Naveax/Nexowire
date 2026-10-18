import type { AtomicDailyInvocationResult } from './daily-request-d1-ledger.js';
import type { ProposedDailyEntitlementResolver } from './daily-entitlement-proposal.js';

/**
 * S2 staging-only orchestration of two separate, verified primitives.
 * NOT imported by production Worker, MCP routing or the live monthly ledger.
 *
 * The authenticatedAccountId MUST be issued from a fresh first-party
 * authentication result, never from a request JSON body.
 */
export type ProposedAuthorizedDailyDecision =
  | Readonly<{
      status: 'reserved' | 'duplicate' | 'exhausted';
      tier: 'free' | 'plus' | 'pro';
      dayUtc: string;
      dailyLimit: number;
      usedRequests: number;
      remainingRequests: number;
    }>
  | Readonly<{status:'denied';reason:string}>;

export interface ProposedDailyLedgerLike {
  reserve(input: {
    quotaSubjectId: string;
    invocationId: string;
    acceptedAt: Date;
    trustedDailyLimit: number;
  }): Promise<AtomicDailyInvocationResult>;
}

export class ProposedTrustedDailyReservation {
  constructor(
    private readonly resolver: Pick<ProposedDailyEntitlementResolver,'resolve'>,
    private readonly ledger: ProposedDailyLedgerLike,
    private readonly now: ()=>Date=()=>new Date(),
  ){}

  async reserveAuthenticated(
    authenticatedAccountId:string,
    invocationId:string,
  ):Promise<ProposedAuthorizedDailyDecision> {
    // Resolve the current plan+quota subject on every call; never persist or
    // trust a caller-provided plan/cap/subject.
    const entitlement=await this.resolver.resolve(authenticatedAccountId);
    if(entitlement.status==='denied') {
      return {status:'denied',reason:entitlement.reason};
    }
    const stamp=this.now();
    // Timestamp comes from the trusted server clock, not MCP arguments.
    if(!(stamp instanceof Date)||!Number.isFinite(stamp.getTime())) {
      throw new Error('Daily reservation clock unavailable');
    }
    const result=await this.ledger.reserve({
      quotaSubjectId:entitlement.quotaSubjectId,
      invocationId,
      acceptedAt:stamp,
      trustedDailyLimit:entitlement.dailyRequestLimit,
    });
    return {
      status:result.status,
      tier:entitlement.tier,
      dayUtc:result.dayUtc,
      dailyLimit:entitlement.dailyRequestLimit,
      usedRequests:result.usedRequests,
      remainingRequests:result.remainingRequests,
    };
  }
}
