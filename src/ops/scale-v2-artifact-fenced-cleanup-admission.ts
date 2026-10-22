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
  /** Server-loaded immutable complete artifact identity, never Native ACK. */
  readonly expectedSourceSha256:string;
  readonly expectedSizeBytes:number;
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
/** Protected external journal outcome. A Hub CANCELLED status or a client
 * boolean must NEVER mint these values. Pending Native effects and forged
 * receipts require independent reconciliation before quota disk release.
 */
export type FencedNativeResolution=
  'NEVER_DISPATCHED_CLEANUP_VERIFIED'|
  'DISPATCHED_CLEANUP_VERIFIED'|
  'MUTATION_UNKNOWN_PENDING'|
  'FORGED_ACK_PENDING'|
  'OWNER_REPAIR_PENDING';
/** Protected #08 publication journal, not a Hub status / user boolean.
 * UNKNOWN and forged final receipts deny quota cleanup even if staged bytes
 * appear deleted. A production provider MUST independently authenticate the
 * final receipt AND read back target size/digest before VERIFIED is returned.
 */
export type FencedPublicationDisposition=
  'NOT_ATTEMPTED_VERIFIED'|
  'AUTHENTICATED_FINAL_VERIFIED'|
  'PUBLICATION_UNKNOWN_PENDING'|
  'FORGED_FINAL_RECEIPT_PENDING'|
  'OWNER_REPAIR_PENDING';
export interface TrustedPublicationFacts {
  readonly publicationDisposition:FencedPublicationDisposition;
  readonly publicationRequestId:string|null;
  readonly publicationEpoch:number|null;
  readonly publicationReceiptId:string|null;
  readonly publishedSizeBytes:number|null;
  readonly publishedSha256:string|null;
  readonly finalTargetReadbackSha256:string|null;
}
export interface IndependentFencedDeletionWitness extends TrustedPublicationFacts {
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
  /** Trusted durable reconciliation event AFTER cross-Hub writer revoke.
   * Must be independently witnessed, not derived from user/job.status.
   */
  readonly reconciliationEpoch:number;
  readonly nativeResolution:FencedNativeResolution;
  readonly receiptId:string;
}
/** Readback is from a rollback-independent external CAS + protected disk
 * authority, not a claimed receipt in client JSON or a local SQLite mirror.
 * Values MUST be read under the same exclusive writer-fence lease.
 */
export interface CurrentFencedDeletionReadback extends TrustedPublicationFacts {
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
  readonly reconciliationEpoch:number;
  readonly nativeResolution:FencedNativeResolution;
  readonly unresolvedNativeMutations:number;
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
const validPublication=(p:TrustedPublicationFacts,scope:ServerBoundArtifactCleanup)=>{
  if(p?.publicationDisposition==='NOT_ATTEMPTED_VERIFIED')
    return p.publicationRequestId===null&&
      p.publicationEpoch===null&&p.publicationReceiptId===null&&
      p.publishedSizeBytes===null&&p.publishedSha256===null&&
      p.finalTargetReadbackSha256===null;
  return p?.publicationDisposition==='AUTHENTICATED_FINAL_VERIFIED'&&
    validId(p.publicationRequestId as string)&&
    epoch(p.publicationEpoch as number)&&
    validId(p.publicationReceiptId as string)&&
    p.publishedSizeBytes===scope.expectedSizeBytes&&
    p.publishedSha256===scope.expectedSourceSha256&&
    p.finalTargetReadbackSha256===scope.expectedSourceSha256;
};
const samePublication=(a:TrustedPublicationFacts,b:TrustedPublicationFacts)=>
  a.publicationDisposition===b.publicationDisposition&&
  a.publicationRequestId===b.publicationRequestId&&
  a.publicationEpoch===b.publicationEpoch&&
  a.publicationReceiptId===b.publicationReceiptId&&
  a.publishedSizeBytes===b.publishedSizeBytes&&
  a.publishedSha256===b.publishedSha256&&
  a.finalTargetReadbackSha256===b.finalTargetReadbackSha256;
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
    validPublication(proof,scope)&&
    dispatchedIdentity(proof)&&
    proof.lastDispatchedRequestId===scope.lastDispatchedRequestId&&
    proof.lastDispatchedChunkSha256===scope.lastDispatchedChunkSha256&&
    Number.isSafeInteger(proof.writerStoppedThroughEpoch)&&
    proof.writerStoppedThroughEpoch>=0&&
    epoch(proof.deletionEpoch)&&epoch(proof.fencingEpoch)&&
    epoch(proof.reconciliationEpoch)&&
    proof.reconciliationEpoch<=proof.deletionEpoch&&
    (scope.dispatchedWriterEpoch===0
      ?proof.nativeResolution==='NEVER_DISPATCHED_CLEANUP_VERIFIED'
      :proof.nativeResolution==='DISPATCHED_CLEANUP_VERIFIED')&&
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
      !chunkSha(scope.expectedSourceSha256)||
      !Number.isSafeInteger(scope.expectedSizeBytes)||
      scope.expectedSizeBytes<=0||
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
        !validPublication(current,scope)||
        !samePublication(current,witness)||
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
        !epoch(current.reconciliationEpoch)||
        current.reconciliationEpoch<=current.writerRevokeEpoch||
        current.reconciliationEpoch>current.deletionEpoch||
        current.reconciliationEpoch!==witness.reconciliationEpoch||
        current.nativeResolution!==witness.nativeResolution||
        current.unresolvedNativeMutations!==0||
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
