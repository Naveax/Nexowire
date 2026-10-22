import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  initArtifactBudgetFixture,StagingArtifactByteBudget,
  type ArtifactDurableProofVerifier,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {
  StagingCoreArtifactCancellationGate,
  type TrustedCoreArtifactAuthority,
  type VerifiedCoreArtifactLease,
} from '../src/ops/scale-v2-core-artifact-cancel-staging.js';
import {
  StagingArtifactFencedCleanupAdmission,
  type ServerBoundArtifactCleanup,
  type IndependentFencedDeletionWitness,
  type TrustedFencedDeletionAuthority,
} from '../src/ops/scale-v2-artifact-fenced-cleanup-admission.js';

/**
 * QA-only independent synthetic durable CAS and file evidence.
 * No actual Agent, #08 physical store, #616/640 worker or remote D1.
 */
const scope:ServerBoundArtifactCleanup={
  ownerId:'owner-signed-high',deviceId:'device-signed-high',
  projectId:'project-alpha',sessionId:'session-alpha-01',
  rootInvocationId:'root-alpha-01',ownerEpoch:31,deviceEpoch:19,
  dispatchedWriterEpoch:71,
  pendingDispatchState:'DISPATCHED_OR_UNKNOWN',
  lastDispatchedRequestId:'native-request-0001',
  lastDispatchedChunkSha256:'b'.repeat(64),
};
const started=new Date('2026-10-21T15:59:59.900Z');
const advanced=new Date('2026-10-21T16:00:00.100Z');
const SIZE=2*65536,CHUNK=65536;
const hash='a'.repeat(64),sha='b'.repeat(64);
const baseChunk=(requestId='chunk-alpha-001',now=started)=>({
  ownerId:scope.ownerId,deviceId:scope.deviceId,
  projectId:scope.projectId,sessionId:scope.sessionId,
  requestId,offsetBytes:0,byteCount:CHUNK,chunkSha256:sha,now,
});
function fixture(){
  const folder=mkdtempSync(path.join(tmpdir(),'nw14-quota-cleanup-'));
  const filename=path.join(folder,'quota.sqlite');
  const db=new DatabaseSync(filename),other=new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000;');
  other.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000;');
  initArtifactBudgetFixture(db);
  // The source and monotonic writer state are NOT stored in the quota DB.
  const evidence={
    ownerEpoch:scope.ownerEpoch,deviceEpoch:scope.deviceEpoch,
    revoked:false,unknown:false,coreHigh:true,signatureValid:true,
    protectedImage:true,source:'NOT_DISPATCHED' as
      'NOT_DISPATCHED'|'WRITE_UNKNOWN'|'WRITERS_QUIESCENT'|'DELETED',
    stoppedThrough:0,deletedAt:0,fencingEpoch:0,revokeEpoch:0,
    nativeDispatchHighWaterEpoch:scope.dispatchedWriterEpoch,
    nativeDispatchState:'DISPATCHED_OR_UNKNOWN' as
      'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN',
    lastDispatchedRequestId:scope.lastDispatchedRequestId,
    lastDispatchedChunkSha256:scope.lastDispatchedChunkSha256,
    immutableReceiptId:'authoritative-receipt-001',
    forgedReceiptId:false,
    activeWriters:0,staleReadback:false,readbackUnavailable:false,
    actualDeletion:false,writerStopped:false,
    corruptProof:false,
  };
  let proofHolds=0,releaseCount=0;
  const leaseProof:VerifiedCoreArtifactLease={
    ownerId:scope.ownerId,deviceId:scope.deviceId,
    projectId:scope.projectId,sessionId:scope.sessionId,
    ownerEpoch:scope.ownerEpoch,deviceEpoch:scope.deviceEpoch,
    mode:'CORE',brokerTokenIntegrity:'high',
    signedBrokerVerified:true,protectedBrokerVerified:true,
    delegationCurrent:true,grantRevoked:false,
  };
  const core:TrustedCoreArtifactAuthority={
    async withVerifiedCoreLease(binding,apply){
      if(evidence.unknown||evidence.revoked||
         evidence.ownerEpoch!==binding.ownerEpoch||
         evidence.deviceEpoch!==binding.deviceEpoch)throw Error('AUTHORITY_STALE_REVOKED_UNKNOWN');
      return apply({
        ...leaseProof,
        brokerTokenIntegrity:(evidence.coreHigh?'high':'medium') as 'high',
        signedBrokerVerified:evidence.signatureValid as true,
        protectedBrokerVerified:evidence.protectedImage as true,
        ownerEpoch:evidence.ownerEpoch,deviceEpoch:evidence.deviceEpoch,
      });
    },
  };
  const proofs:ArtifactDurableProofVerifier={
    verifyChunk:()=>false,
    verifyFinal:()=>false,
    verifyDeletion:r=>evidence.actualDeletion&&
      r.ownerId===scope.ownerId&&r.deviceId===scope.deviceId&&
      r.projectId===scope.projectId&&r.sessionId===scope.sessionId,
    verifyWriterFence:r=>evidence.writerStopped&&
      evidence.stoppedThrough>=evidence.nativeDispatchHighWaterEpoch&&
      r.ownerId===scope.ownerId&&r.deviceId===scope.deviceId&&
      r.sessionId===scope.sessionId,
  };
  const trusted:TrustedFencedDeletionAuthority={
    async readbackCurrent(binding,witness){
      if(evidence.readbackUnavailable)throw Error('INDEPENDENT_READBACK_UNAVAILABLE');
      return {
        ownerId:binding.ownerId,deviceId:binding.deviceId,
        projectId:binding.projectId,sessionId:binding.sessionId,
        rootInvocationId:binding.rootInvocationId,
        ownerEpoch:evidence.ownerEpoch,deviceEpoch:evidence.deviceEpoch,
        writerRevokeEpoch:evidence.revokeEpoch,
        nativeDispatchHighWaterEpoch:evidence.nativeDispatchHighWaterEpoch,
        pendingDispatchState:evidence.nativeDispatchState,
        lastDispatchedRequestId:evidence.lastDispatchedRequestId,
        lastDispatchedChunkSha256:evidence.lastDispatchedChunkSha256,
        writerStoppedThroughEpoch:evidence.stoppedThrough,
        deletionEpoch:evidence.deletedAt,
        fencingEpoch:evidence.staleReadback
          ? witness.fencingEpoch+1 : evidence.fencingEpoch,
        // Independent protected store readback, not a reflected ACK.
        receiptId:evidence.immutableReceiptId,
        inFlightNativeWriters:evidence.activeWriters,
        deletionState:'VERIFIED_ABSENT' as const,
      };
    },
    async withVerifiedFencedDeletion(binding,apply){
      if(evidence.source!=='DELETED'||!evidence.actualDeletion||
         !evidence.writerStopped||evidence.unknown||
         evidence.stoppedThrough<binding.dispatchedWriterEpoch){
        throw Error('INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE');
      }
      proofHolds++;
      try {
        const witness:IndependentFencedDeletionWitness={
          ...binding,
          ownerEpoch:evidence.ownerEpoch,deviceEpoch:evidence.deviceEpoch,
          writerStoppedThroughEpoch:evidence.stoppedThrough,
          deletionEpoch:evidence.deletedAt,fencingEpoch:evidence.fencingEpoch,
          receiptId:evidence.forgedReceiptId
            ?'client-forged-receipt-9999':evidence.immutableReceiptId,
        };
        return await apply(evidence.corruptProof
          ? {...witness,projectId:'forged-project'} : witness);
      }finally { proofHolds-- }
    },
  };
  const first=new StagingArtifactByteBudget(db,undefined,proofs);
  const second=new StagingArtifactByteBudget(other,undefined,proofs);
  const cleanup=new StagingArtifactFencedCleanupAdmission(first,core,trusted);
  const cleanup2=new StagingArtifactFencedCleanupAdmission(second,core,trusted);
  const cancel=new StagingCoreArtifactCancellationGate(first,core);
  const stats=()=>{
    const q=(sql:string)=>Number((db.prepare(sql).get() as {n:number}|undefined)?.n??0);
    return {admittedBytes:q('SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks'),
      occupiedBytes:q("SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"),
      totalSessions:q('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),
      releasedSessions:q("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='RELEASED'")};
  };
  return {
    first,second,cancel,cleanup,cleanup2,trusted,core,evidence,stats,
    get holds(){return proofHolds},get releases(){return releaseCount},
    noteRelease(){releaseCount++},
    verifiedDelete(){
      evidence.source='DELETED';evidence.writerStopped=true;
      evidence.actualDeletion=true;evidence.stoppedThrough=71;
      evidence.revokeEpoch=72;evidence.deletedAt=73;evidence.fencingEpoch=74;
    },
    close(){other.close();db.close();rmSync(folder,{recursive:true,force:true})},
  };
}
function reserve(f:ReturnType<typeof fixture>){
  assert.equal(f.first.begin({...scope,rootInvocationId:scope.rootInvocationId,
    sizeBytes:SIZE,sourceSha256:hash,
    physicalFreeBytes:8*1024**3,now:started}),'RESERVED');
}
function pending(f:ReturnType<typeof fixture>){
  assert.equal(f.first.stageChunk(baseChunk()),'CHUNK_PENDING');
}
async function cancel(f:ReturnType<typeof fixture>,offset=0){
  assert.equal(await f.cancel.cancel(scope,offset),'CANCEL_PENDING');
}

test('missing trusted source or CORE: forged client booleans cannot free disk',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);
   const forged={...scope,writersStoppedVerified:true,
     durableDeletionVerified:true,brokerTokenIntegrity:'high'};
   const untrusted=new StagingArtifactFencedCleanupAdmission(f.first,undefined,f.trusted);
   await assert.rejects(()=>untrusted.releaseReservedDiskAfterVerifiedCleanup(forged),
     /CLEANUP_AUTHORITY_UNAVAILABLE/);
   const noPhysical=new StagingArtifactFencedCleanupAdmission(f.first,f.core,undefined);
   await assert.rejects(()=>noPhysical.releaseReservedDiskAfterVerifiedCleanup(forged),
     /CLEANUP_AUTHORITY_UNAVAILABLE/);
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(forged),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
      totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});
test('#640 cancellation before native write: no artificial UNKNOWN and cleanup requires fenced deletion',async()=>{
 const f=fixture();try{
   reserve(f);
   // Source read alone never called stageChunk, so there is NO dispatched write.
   await cancel(f);
   assert.equal(f.stats().admittedBytes,0);
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.verifiedDelete();
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),'RELEASED_FIRST');
   assert.deepEqual(f.stats(),{admittedBytes:0,occupiedBytes:0,
     totalSessions:1,releasedSessions:1});
 }finally{f.close()}
});
test('#640 post-write lost ACK: cannot release UNKNOWN or refund admitted bytes',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);
   f.evidence.source='WRITE_UNKNOWN';
   await cancel(f);
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   assert.equal(f.second.stageChunk({...baseChunk(),now:advanced}),'DENIED_STATE');
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
      totalSessions:1,releasedSessions:0});
   f.evidence.source='WRITERS_QUIESCENT';
   f.evidence.writerStopped=true;
   f.evidence.stoppedThrough=71;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.verifiedDelete();
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),'RELEASED_FIRST');
   assert.equal(f.stats().admittedBytes,CHUNK);
 }finally{f.close()}
});
test('stale external writer epoch, dishonest tenant or deletion receipt cannot release',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.stoppedThrough=70;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.evidence.stoppedThrough=71;f.evidence.corruptProof=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   f.evidence.corruptProof=false;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup({
     ...scope,ownerId:'foreign-owner'}),
     /CLEANUP_CORE_GRANT_INVALID/);
   assert.equal(f.stats().occupiedBytes,SIZE);
 }finally{f.close()}
});
test('CORE revoke / owner re-pair / unknown never bypass trusted deletion despite valid disk receipt',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.revoked=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /AUTHORITY_STALE_REVOKED_UNKNOWN/);
   f.evidence.revoked=false;f.evidence.unknown=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.evidence.unknown=false;f.evidence.ownerEpoch=32;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   f.evidence.ownerEpoch=scope.ownerEpoch;f.evidence.deviceEpoch=20;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   f.evidence.deviceEpoch=scope.deviceEpoch;f.evidence.coreHigh=false;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_CORE_GRANT_INVALID/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
      totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});
test('two Hub-like handles retry same trusted cancellation cleanup without double quota credit',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   const results=await Promise.all([
     f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
   ]);
   assert.deepEqual(results,['RELEASED_FIRST','RELEASED_ALREADY']);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:0,
      totalSessions:1,releasedSessions:1});
   f.evidence.revoked=true;
   await assert.rejects(()=>f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
     /AUTHORITY_STALE_REVOKED_UNKNOWN/);
   // Revocation cannot create a second release or retroactively refund traffic.
   assert.equal(f.stats().admittedBytes,CHUNK);
 }finally{f.close()}
});
test('deletion proof absent in #610 budget verifier refuses even an otherwise valid external witness',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.actualDeletion=false; // external authority also sees no physical deletion
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   assert.equal(f.stats().occupiedBytes,SIZE);
   // Both independent authorities must agree. No client supplied flag can substitute.
 }finally{f.close()}
});

test('missing external monotonic CAS readback never releases a signed-looking cleanup receipt',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   const noReadback=new StagingArtifactFencedCleanupAdmission(
     f.first,f.core,{
       withVerifiedFencedDeletion:f.trusted.withVerifiedFencedDeletion,
     } as TrustedFencedDeletionAuthority);
   await assert.rejects(()=>noReadback.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_REQUIRED/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});
test('cross-Hub revoke epoch MUST exceed highest dispatched writer epoch',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.revokeEpoch=scope.dispatchedWriterEpoch;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
   f.evidence.revokeEpoch=72;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
 }finally{f.close()}
});
test('new Hub fencing epoch invalidates old deleted receipt at independent CAS readback',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.staleReadback=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
   f.evidence.staleReadback=false;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
 }finally{f.close()}
});
test('active writer or unreachable external readback: no cleanup refund',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.activeWriters=1;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   f.evidence.activeWriters=0;f.evidence.readbackUnavailable=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_READBACK_UNAVAILABLE/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});
test('UNKNOWN, revoke, repeated Hub receipts: exactly one disk release and zero minute refunds',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);
   f.evidence.source='WRITE_UNKNOWN';
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.verifiedDelete();
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
   assert.equal(await f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_ALREADY');
   f.evidence.revoked=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /AUTHORITY_STALE_REVOKED_UNKNOWN/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:0,
     totalSessions:1,releasedSessions:1});
   assert.equal(f.second.stageChunk({...baseChunk(),now:advanced}),
     'DENIED_STATE');
 }finally{f.close()}
});
test('persisted revoke epoch newer than physical deletion: deny old receipt',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.revokeEpoch=f.evidence.fencingEpoch+1;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
 }finally{f.close()}
});

/**
 * #691 / #682 compatibility fixtures. These are independently persisted
 * quota-CAS readback state models, NOT real #08 worker integration.
 */
test('#691 reserved native intent with dispatched=false can clean zero-byte reservation ONLY after verified absence',async()=>{
 const f=fixture();try{
   reserve(f);
   const pre={...scope,dispatchedWriterEpoch:0,
     pendingDispatchState:'NEVER_DISPATCHED' as const,
     lastDispatchedRequestId:null,lastDispatchedChunkSha256:null};
   // No native write or quota byte admission occurred.
   assert.equal(f.stats().admittedBytes,0);
   assert.equal(await f.cancel.cancel(pre,0),'CANCEL_PENDING');
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(pre),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.verifiedDelete();
   // External independent CAS attests no write was ever dispatched.
   f.evidence.nativeDispatchHighWaterEpoch=0;
   f.evidence.nativeDispatchState='NEVER_DISPATCHED';
   f.evidence.lastDispatchedRequestId=null;
   f.evidence.lastDispatchedChunkSha256=null;
   f.evidence.stoppedThrough=0;
   f.evidence.revokeEpoch=1;
   f.evidence.deletedAt=2;
   f.evidence.fencingEpoch=3;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(pre),
     'RELEASED_FIRST');
   assert.deepEqual(f.stats(),{admittedBytes:0,occupiedBytes:0,
     totalSessions:1,releasedSessions:1});
   assert.equal(await f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(pre),
     'RELEASED_ALREADY');
 }finally{f.close()}
});

test('#691 false dispatched=false claim cannot hide actual persisted dispatch high-water',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   const forgedPre={...scope,dispatchedWriterEpoch:0,
     pendingDispatchState:'NEVER_DISPATCHED' as const,
     lastDispatchedRequestId:null,lastDispatchedChunkSha256:null};
   // External CAS *independently* remembers Native may already have written.
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(forgedPre),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
      totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});

test('#682 UNKNOWN has zero ACKed bytes but nonzero DISPATCHED high-water: deny early refund or replay',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);
   // Native dispatched first chunk, ACK lost. Hub has zero confirmed bytes.
   const unconfirmed=baseChunk();
   assert.equal(await f.cancel.cancel(scope,0),'CANCEL_PENDING');
   f.evidence.source='WRITE_UNKNOWN';
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   assert.equal(f.second.stageChunk({...unconfirmed,now:advanced}),'DENIED_STATE');
   // Forged worker status changes without authoritative writer quiescence.
   f.evidence.nativeDispatchState='NEVER_DISPATCHED';
   f.verifiedDelete();
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   f.evidence.nativeDispatchState='DISPATCHED_OR_UNKNOWN';
   f.evidence.activeWriters=1;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   f.evidence.activeWriters=0;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
   assert.equal(await f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_ALREADY');
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:0,
     totalSessions:1,releasedSessions:1});
 }finally{f.close()}
});

test('#682 late UNKNOWN receipt under stale/revoked CORE owner or old CAS cannot get first release',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.ownerEpoch=scope.ownerEpoch+1;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   f.evidence.ownerEpoch=scope.ownerEpoch;f.evidence.revoked=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /AUTHORITY_STALE_REVOKED_UNKNOWN/);
   f.evidence.revoked=false;f.evidence.staleReadback=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});

test('journal absent dispatched flag is UNKNOWN, not the no-dispatch fast path',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   const missingMark={...scope,pendingDispatchState:undefined as unknown as
     'NEVER_DISPATCHED'|'DISPATCHED_OR_UNKNOWN'};
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(missingMark),
     /CLEANUP_SERVER_BINDING_INVALID/);
   // Legacy pending with no proof is never assumed not-dispatched.
   f.evidence.nativeDispatchHighWaterEpoch=0;
   f.evidence.nativeDispatchState='NEVER_DISPATCHED';
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
 }finally{f.close()}
});


test('#725 forged Native ACK requestId cannot become immutable deletion proof or disk refund',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   // Original write request belongs to protected dispatch journal. A forged
   // ACK with a different ID cannot replace it, even if flags are true.
   f.evidence.lastDispatchedRequestId='forged-native-ack-request-999';
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
   f.evidence.lastDispatchedRequestId=scope.lastDispatchedRequestId;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
 }finally{f.close()}
});

test('#708 newer Hub writer SHA from forged second-chunk receipt invalidates old cleanup witness',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   // Hub B's disputed Native write must be authenticated against persisted
   // request ID and chunk SHA, not against an arbitrary client ACK.
   f.evidence.lastDispatchedChunkSha256='0'.repeat(64);
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
   f.evidence.lastDispatchedChunkSha256=scope.lastDispatchedChunkSha256;
   f.evidence.staleReadback=true; // newer Hub owns a different CAS generation
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
 }finally{f.close()}
});

test('immutable deletion receipt ID must come from independent durable issuer, never echoed user ACK',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   f.evidence.forgedReceiptId=true;
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup({
     ...scope,durableDeletionVerified:true,writersStoppedVerified:true,
   } as typeof scope),/CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   assert.equal(f.stats().occupiedBytes,SIZE);
   f.evidence.forgedReceiptId=false;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
 }finally{f.close()}
});

test('#708 old Hub leased cleanup after CORE re-pair stays DENIED; only one disk release',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);
   f.evidence.source='WRITE_UNKNOWN';
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /INDEPENDENT_PHYSICAL_PROOF_UNAVAILABLE/);
   f.verifiedDelete();
   f.evidence.deviceEpoch=scope.deviceEpoch+1; // re-pair after pending write
   await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
   f.evidence.deviceEpoch=scope.deviceEpoch;
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_FIRST');
   // Hub B duplicates a previously acknowledged disposal; cannot turn
   // RELEASED_ALREADY into a second release or refund admitted traffic.
   assert.equal(await f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
     'RELEASED_ALREADY');
   f.evidence.ownerEpoch=scope.ownerEpoch+1;
   await assert.rejects(()=>f.cleanup2.releaseReservedDiskAfterVerifiedCleanup(scope),
     /CLEANUP_INDEPENDENT_WITNESS_INVALID/);
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:0,
     totalSessions:1,releasedSessions:1});
 }finally{f.close()}
});

test('missing pending Native request ID/hash and fabricated predispatch flags must fail closed',async()=>{
 const f=fixture();try{
   reserve(f);pending(f);await cancel(f);f.verifiedDelete();
   for(const forged of [
     {...scope,lastDispatchedRequestId:null},
     {...scope,lastDispatchedChunkSha256:null},
     {...scope,lastDispatchedChunkSha256:'F'.repeat(64)},
     {...scope,pendingDispatchState:'NEVER_DISPATCHED' as const},
     {...scope,lastDispatchedRequestId:'client-new-request-123'},
   ]){
     await assert.rejects(()=>f.cleanup.releaseReservedDiskAfterVerifiedCleanup(forged),
       /CLEANUP_SERVER_BINDING_INVALID|CLEANUP_INDEPENDENT_WITNESS_INVALID|CLEANUP_MONOTONIC_READBACK_STALE_OR_FORGED/);
   }
   assert.deepEqual(f.stats(),{admittedBytes:CHUNK,occupiedBytes:SIZE,
     totalSessions:1,releasedSessions:0});
 }finally{f.close()}
});
