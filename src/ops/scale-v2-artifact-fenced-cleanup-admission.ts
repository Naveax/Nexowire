import type {StagingArtifactByteBudget,BudgetDecision}
  from './scale-v2-artifact-byte-budget-staging.js';
import type {ServerBoundQuotaJob,TrustedCoreArtifactAuthority,
  VerifiedCoreArtifactLease}
  from './scale-v2-core-artifact-cancel-staging.js';

/**
 * SOURCE/STAGING ONLY: trusted SERVER-side cleanup contract for #588/#596/#616.
 * No client booleans occur in the input. The trusted authority MUST hold a
 * rollback-independent writer-fence lease and verify actual physical deletion.
 * This module does not itself inspect physical files or establish Broker proof.
 */
export interface ServerBoundArtifactCleanup extends ServerBoundQuotaJob {
  readonly rootInvocationId:string;
  /** Highest dispatched writer generation, including writes with lost ACK. */
  readonly dispatchedWriterEpoch:number;
}
export interface IndependentFencedDeletionWitness {
  readonly ownerId:string;readonly deviceId:string;
  readonly projectId:string;readonly sessionId:string;
  readonly rootInvocationId:string;readonly ownerEpoch:number;
  readonly deviceEpoch:number;
  readonly writerStoppedThroughEpoch:number;
  readonly deletionEpoch:number;readonly fencingEpoch:number;
  readonly receiptId:string;
}
/** Must hold the CURRENT external writer fence throughout the callback. */
export interface TrustedFencedDeletionAuthority {
  withVerifiedFencedDeletion<T>(
    scope:Readonly<ServerBoundArtifactCleanup>,
    apply:(witness:Readonly<IndependentFencedDeletionWitness>)=>Promise<T>,
  ):Promise<T>;
}
const validId=(x:string)=>typeof x==='string'&&
  /^[A-Za-z0-9_.:@-]{8,128}$/.test(x);
const epoch=(x:number)=>Number.isSafeInteger(x)&&x>0;
function validCore(
  lease:VerifiedCoreArtifactLease,scope:ServerBoundArtifactCleanup,
):boolean{
  return lease?.ownerId===scope.ownerId&&lease.deviceId===scope.deviceId&&
    lease.projectId===scope.projectId&&lease.sessionId===scope.sessionId&&
    lease.ownerEpoch===scope.ownerEpoch&&
    lease.deviceEpoch===scope.deviceEpoch&&lease.mode==='CORE'&&
    lease.brokerTokenIntegrity==='high'&&
    lease.signedBrokerVerified===true&&
    lease.protectedBrokerVerified===true&&
    lease.delegationCurrent===true&&lease.grantRevoked===false;
}
function validWitness(
  proof:IndependentFencedDeletionWitness,scope:ServerBoundArtifactCleanup,
):boolean{
  return proof?.ownerId===scope.ownerId&&
    proof.deviceId===scope.deviceId&&
    proof.projectId===scope.projectId&&
    proof.sessionId===scope.sessionId&&
    proof.rootInvocationId===scope.rootInvocationId&&
    proof.ownerEpoch===scope.ownerEpoch&&
    proof.deviceEpoch===scope.deviceEpoch&&
    epoch(proof.writerStoppedThroughEpoch)&&
    epoch(proof.deletionEpoch)&&epoch(proof.fencingEpoch)&&
    proof.writerStoppedThroughEpoch>=scope.dispatchedWriterEpoch&&
    proof.deletionEpoch>=proof.writerStoppedThroughEpoch&&
    proof.fencingEpoch>=proof.deletionEpoch&&
    validId(proof.receiptId);
}
/**
 * RELEASED may mean new release or already released. Never infer a second
 * refund from that return. Disk quota is freed ONCE by persistent ledger
 * tombstone. Minute byte admissions never refund on cancellation/epoch.
 */
export class StagingArtifactFencedCleanupAdmission {
  constructor(
    private readonly budget:Pick<StagingArtifactByteBudget,'acknowledgeDeletion'>,
    private readonly core:TrustedCoreArtifactAuthority|undefined,
    private readonly durable:TrustedFencedDeletionAuthority|undefined,
  ){}
  async releaseReservedDiskAfterVerifiedCleanup(
    scope:Readonly<ServerBoundArtifactCleanup>,
  ):Promise<BudgetDecision>{
    if(!this.core||!this.durable)throw Error('CLEANUP_AUTHORITY_UNAVAILABLE');
    if(!scope||!validId(scope.ownerId)||!validId(scope.deviceId)||
      !validId(scope.projectId)||!validId(scope.sessionId)||
      !validId(scope.rootInvocationId)||!epoch(scope.ownerEpoch)||
      !epoch(scope.deviceEpoch)||!epoch(scope.dispatchedWriterEpoch)){
      throw Error('CLEANUP_SERVER_BINDING_INVALID');
    }
    // Outer external CAS authority MUST hold a fencing lock while the inner
    // signed/current CORE grant and local budget transaction both run.
    return this.durable.withVerifiedFencedDeletion(scope, async witness=>{
      if(!validWitness(witness,scope)){
        throw Error('CLEANUP_INDEPENDENT_WITNESS_INVALID');
      }
      return this.core!.withVerifiedCoreLease(scope,lease=>{
        if(!validCore(lease,scope)){
          throw Error('CLEANUP_CORE_GRANT_INVALID');
        }
        // Internal flags are synthesized ONLY after both protected external
        // authorities verified cleanup. Existing #610 ledger independently
        // checks its injected durable proof verifier yet again.
        const result=this.budget.acknowledgeDeletion({
          ownerId:scope.ownerId,deviceId:scope.deviceId,
          projectId:scope.projectId,sessionId:scope.sessionId,
          durableDeletionVerified:true,writersStoppedVerified:true,
        });
        if(result!=='RELEASED'){
          throw Error('CLEANUP_LEDGER_FAIL_CLOSED_'+result);
        }
        return result;
      });
    });
  }
}
