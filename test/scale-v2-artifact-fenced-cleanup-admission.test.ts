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
    stoppedThrough:0,deletedAt:0,fencingEpoch:0,
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
      evidence.stoppedThrough>=scope.dispatchedWriterEpoch&&
      r.ownerId===scope.ownerId&&r.deviceId===scope.deviceId&&
      r.sessionId===scope.sessionId,
  };
  const trusted:TrustedFencedDeletionAuthority={
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
          receiptId:'authoritative-receipt-001',
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
      evidence.deletedAt=73;evidence.fencingEpoch=74;
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
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),'RELEASED');
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
   assert.equal(await f.cleanup.releaseReservedDiskAfterVerifiedCleanup(scope),'RELEASED');
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
   assert.deepEqual(results,['RELEASED','RELEASED']);
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
