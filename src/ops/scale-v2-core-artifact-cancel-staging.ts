import type {StagingArtifactByteBudget,BudgetDecision} from './scale-v2-artifact-byte-budget-staging.js';

/**
 * SOURCE/STAGING ONLY: verified CORE owner/device cancellation boundary.
 * The caller MUST load the job from a trusted, persisted job/owner authority.
 * No HTTP/MCP JSON field may directly instantiate these server-bound types.
 *
 * This is NOT a Windows elevation implementation and is not a substitute for
 * the signed, protected elevated Broker and external monotonic authority.
 */
export interface ServerBoundQuotaJob {
  readonly ownerId:string;
  readonly deviceId:string;
  readonly projectId:string;
  readonly sessionId:string;
  readonly ownerEpoch:number;
  readonly deviceEpoch:number;
}

export interface VerifiedCoreArtifactLease {
  readonly ownerId:string;
  readonly deviceId:string;
  readonly projectId:string;
  readonly sessionId:string;
  readonly ownerEpoch:number;
  readonly deviceEpoch:number;
  readonly mode:'CORE';
  readonly brokerTokenIntegrity:'high';
  readonly signedBrokerVerified:true;
  readonly protectedBrokerVerified:true;
  readonly delegationCurrent:true;
  readonly grantRevoked:false;
}

export interface TrustedCoreArtifactAuthority {
  /**
   * MUST lock/fence the CURRENT owner/device/CORE grant while invoking apply;
   * stale epoch, revoked owner/re-pair, unknown broker token or unreliable
   * external witness MUST throw before apply runs.
   *
   * Returned lease is for source checks, NOT user-supplied evidence.
   * An implementation that simply calls apply with JSON data is UNSAFE.
   */
  withVerifiedCoreLease<T>(
    scope:Readonly<ServerBoundQuotaJob>,
    apply:(proof:Readonly<VerifiedCoreArtifactLease>)=>T,
  ):Promise<T>;
}

function safeEpoch(x:number):boolean{
  return Number.isSafeInteger(x)&&x>0;
}

export class StagingCoreArtifactCancellationGate {
  constructor(
    private readonly budget:Pick<StagingArtifactByteBudget,'requestCancel'>,
    private readonly authority:TrustedCoreArtifactAuthority|undefined,
  ){}

  async cancel(
    binding:Readonly<ServerBoundQuotaJob>,
    expectedOffsetBytes:number,
  ):Promise<BudgetDecision>{
    if(!this.authority)throw Error('CORE_TRUST_AUTHORITY_REQUIRED');
    if(!safeEpoch(binding.ownerEpoch)||!safeEpoch(binding.deviceEpoch)||
       !Number.isSafeInteger(expectedOffsetBytes)||expectedOffsetBytes<0){
      throw Error('CORE_CANCEL_BINDING_INVALID');
    }
    return this.authority.withVerifiedCoreLease(binding,proof=>{
      if(!proof||proof.ownerId!==binding.ownerId||
        proof.deviceId!==binding.deviceId||
        proof.projectId!==binding.projectId||
        proof.sessionId!==binding.sessionId||
        proof.ownerEpoch!==binding.ownerEpoch||
        proof.deviceEpoch!==binding.deviceEpoch||
        proof.mode!=='CORE'||
        proof.brokerTokenIntegrity!=='high'||
        proof.signedBrokerVerified!==true||
        proof.protectedBrokerVerified!==true||
        proof.delegationCurrent!==true||
        proof.grantRevoked!==false){
        throw Error('CORE_CANCEL_EFFECTIVE_PROOF_INVALID');
      }
      return this.budget.requestCancel({
        ownerId:binding.ownerId,
        deviceId:binding.deviceId,
        projectId:binding.projectId,
        sessionId:binding.sessionId,
        expectedOffsetBytes,
      });
    });
  }
}
