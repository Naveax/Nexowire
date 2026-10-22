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
  /** Authenticated durable predispatch journal, never caller JSON. */
  readonly pendingDispatchState:'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN';
  /** From protected Native dispatch journal, NOT returned ACK / client JSON.
   * Both null only for independently witnessed zero-dispatch cancellation.
   */
  readonly lastDispatchedRequestId:string|null;
  readonly lastDispatchedChunkSha256:string|null;
}
export interface IndependentFencedDeletionWitness {
  readonly ownerId:string;readonly deviceId:string;
  readonly projectId:string;readonly sessionId:string;
  readonly rootInvocationId:string;readonly ownerEpoch:number;
  readonly deviceEpoch:number;
  readonly writerStoppedThroughEpoch:number;
  readonly pendingDispatchState:'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN';
  /** Immutable Native dispatch identity, not a possibly forged ACK. */
  readonly lastDispatchedRequestId:string|null;
  readonly lastDispatchedChunkSha256:string|null;
  readonly deletionEpoch:number;readonly fencingEpoch:number;
  readonly receiptId:string;
}
/** Readback is from a rollback-independent external CAS + protected disk
 * authority, not a claimed receipt in client JSON or a local SQLite mirror.
 * Values MUST be read under the same exclusive writer-fence lease.
 */
export interface CurrentFencedDeletionReadback {
  readonly ownerId:string;readonly deviceId:string;
  readonly projectId:string;readonly sessionId:string;
  readonly rootInvocationId:string;
  readonly ownerEpoch:number;readonly deviceEpoch:number;
  /** Persistently revoked all old writer generations across every Hub. */
  readonly writerRevokeEpoch:number;
  readonly writerStoppedThroughEpoch:number;
  /** Trusted readback of highest Native dispatch, NOT confirmed ACK count. */
  readonly nativeDispatchHighWaterEpoch:number;
  /** Trusted persisted dispatch intent, distinguishes #691 from #682. */
  readonly pendingDispatchState:'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN';
  /** Independent protected write-journal readback; must match BOTH sources. */
  readonly lastDispatchedRequestId:string|null;
  readonly lastDispatchedChunkSha256:string|null;
  readonly deletionEpoch:number;readonly fencingEpoch:number;
  readonly receiptId:string;
  readonly inFlightNativeWriters:number;
  readonly deletionState:'VERIFIED_ABSENT';
}
/** Must hold the CURRENT external writer fence throughout the callback. */
export interface TrustedFencedDeletionAuthority {
  withVerifiedFencedDeletion<T>(
    scope:Readonly<ServerBoundArtifactCleanup>,
    apply:(witness:Readonly<IndependentFencedDeletionWitness>)=>Promise<T>,
  ):Promise<T>;
  /** Read-through authority under the same held lease, never cached ACK. */
  readbackCurrent(
    scope:Readonly<ServerBoundArtifactCleanup>,
    witness:Readonly<IndependentFencedDeletionWitness>,
  ):Promise<Readonly<CurrentFencedDeletionReadback>>;
}
const validId=(x:string)=>typeof x==='string'&&
  /^[A-Za-z0-9_.:@-]{8,128}$/.test(x);
const epoch=(x:number)=>Number.isSafeInteger(x)&&x>0;
const chunkSha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const dispatchedIdentity=(x:{
  pendingDispatchState:'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN';
  lastDispatchedRequestId:string|null;lastDispatchedChunkSha256:string|null;
})=>x.pendingDispatchState==='NEVER_DISPATCHED'
  ? x.lastDispatchedRequestId===null&&x.lastDispatchedChunkSha256===null
  : validId(x.lastDispatchedRequestId as string)&&chunkSha(x.lastDispatchedChunkSha256);
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
    dispatchedIdentity(proof)&&
    proof.lastDispatchedRequestId===scope.lastDispatchedRequestId&&
    proof.lastDispatchedChunkSha256===scope.lastDispatchedChunkSha256&&
    Number.isSafeInteger(proof.writerStoppedThroughEpoch)&&
    proof.writerStoppedThroughEpoch>=0&&
    epoch(proof.deletionEpoch)&&epoch(proof.fencingEpoch)&&
    proof.writerStoppedThroughEpoch>=scope.dispatchedWriterEpoch&&
    proof.deletionEpoch>=proof.writerStoppedThroughEpoch&&
    proof.fencingEpoch>=proof.deletionEpoch&&
    validId(proof.receiptId);
}
/** A first disk release is distinct from a replay. Neither refunds
 * already-admitted minute traffic. Not an actual billing refund. */
export class StagingArtifactFencedCleanupAdmission {
  constructor(
    private readonly budget:Pick<StagingArtifactByteBudget,'acknowledgeDeletionOnce'>,
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
      !epoch(scope.deviceEpoch)||
      !Number.isSafeInteger(scope.dispatchedWriterEpoch)||
      scope.dispatchedWriterEpoch<0||
      !dispatchedIdentity(scope)||
      (scope.dispatchedWriterEpoch===0&&
       scope.pendingDispatchState!=='NEVER_DISPATCHED')||
      (scope.dispatchedWriterEpoch>0&&
       scope.pendingDispatchState!=='DISPATCHED_OR_UNKNOWN')){
      throw Error('CLEANUP_SERVER_BINDING_INVALID');
    }
    // Outer external CAS authority MUST hold a fencing lock while the inner
    // signed/current CORE grant and local budget transaction both run.
    return this.durable.withVerifiedFencedDeletion(scope, async witness=>{
      if(!validWitness(witness,scope)){
        throw Error('CLEANUP_INDEPENDENT_WITNESS_INVALID');
      }
      // Re-read the persisted cross-Hub CAS under the same exclusive fence.
      // A cached, signed-looking deletion witness is insufficient on revoke.
      if(typeof this.durable?.readbackCurrent!=='function')
        throw Error('CLEANUP_MONOTONIC_READBACK_REQUIRED');
      const current=await this.durable.readbackCurrent(scope,witness);
      if(!current||current.ownerId!==scope.ownerId||
        current.deviceId!==scope.deviceId||
        current.projectId!==scope.projectId||
        current.sessionId!==scope.sessionId||
        current.rootInvocationId!==scope.rootInvocationId||
        current.ownerEpoch!==scope.ownerEpoch||
        current.deviceEpoch!==scope.deviceEpoch||
        !epoch(current.writerRevokeEpoch)||
        current.writerRevokeEpoch<=scope.dispatchedWriterEpoch||
        !Number.isSafeInteger(current.nativeDispatchHighWaterEpoch)||
        current.nativeDispatchHighWaterEpoch!==scope.dispatchedWriterEpoch||
        current.pendingDispatchState!==scope.pendingDispatchState||
        !dispatchedIdentity(current)||
        current.lastDispatchedRequestId!==scope.lastDispatchedRequestId||
        current.lastDispatchedChunkSha256!==scope.lastDispatchedChunkSha256||
        current.lastDispatchedRequestId!==witness.lastDispatchedRequestId||
        current.lastDispatchedChunkSha256!==witness.lastDispatchedChunkSha256||
        (scope.dispatchedWriterEpoch===0&&
          (current.nativeDispatchHighWaterEpoch!==0||
           current.pendingDispatchState!=='NEVER_DISPATCHED'))||
        (scope.dispatchedWriterEpoch>0&&
          current.pendingDispatchState!=='DISPATCHED_OR_UNKNOWN')||
        current.writerStoppedThroughEpoch<scope.dispatchedWriterEpoch||
        current.writerStoppedThroughEpoch!==witness.writerStoppedThroughEpoch||
        current.deletionEpoch!==witness.deletionEpoch||
        current.fencingEpoch!==witness.fencingEpoch||
        current.receiptId!==witness.receiptId||
        current.fencingEpoch<current.writerRevokeEpoch||
        current.deletionEpoch<current.writerRevokeEpoch||
        current.inFlightNativeWriters!==0||
        current.deletionState!=='VERIFIED_ABSENT'){
        throw Error('CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED');
      }
      return this.core!.withVerifiedCoreLease(scope,lease=>{
        if(!validCore(lease,scope)){
          throw Error('CLEANUP_CORE_GRANT_INVALID');
        }
        // Internal flags are synthesized ONLY after both protected external
        // authorities verified cleanup. Existing #610 ledger independently
        // checks its injected durable proof verifier yet again.
        const result=this.budget.acknowledgeDeletionOnce({
          ownerId:scope.ownerId,deviceId:scope.deviceId,
          projectId:scope.projectId,sessionId:scope.sessionId,
          durableDeletionVerified:true,writersStoppedVerified:true,
        });
        if(result!=='RELEASED_FIRST'&&result!=='RELEASED_ALREADY'){
          throw Error('CLEANUP_LEDGER_FAIL_CLOSED_'+result);
        }
        return result;
      });
    });
  }
}
