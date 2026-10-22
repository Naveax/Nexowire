import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_CHUNK_BYTES,StagingArtifactByteBudget,initArtifactBudgetFixture,
  type TrustedLogicalOpenArtifact,type TrustedLogicalReservationAuthority,
  type ArtifactBudgetPolicy,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

/** #791 source-only local SQLite negative; no real OS, signer, CAS or D1. */
const CHUNK=ARTIFACT_CHUNK_BYTES;
const policy:ArtifactBudgetPolicy={
  globalMinuteBytes:8*CHUNK,ownerMinuteBytes:2*CHUNK,
  globalStorageBytes:8*CHUNK,ownerStorageBytes:2*CHUNK,
  minFreeDiskBytes:CHUNK,maxConcurrentGlobal:8,maxConcurrentPerOwner:2,
};
const start=new Date('2026-10-22T19:15:00.000Z');
const logical:TrustedLogicalOpenArtifact={
  ownerId:'noisy-owner-791',deviceId:'device-791',projectId:'project-791',
  sessionId:'session-original-791',rootInvocationId:'original-root-791',
  originRunbookId:'original-runbook-791',
  logicalOperationId:'immutable-effect-791',logicalMutationSha256:'a'.repeat(64),
  ownerEpoch:7,grantGeneration:9,
  sizeBytes:CHUNK,sourceSha256:'b'.repeat(64),
  physicalFreeBytes:16*CHUNK,now:start,
};
const oracle=(mode:'NEVER_DISPATCHED'|'MUTATION_UNKNOWN'|'DISPATCHED'='NEVER_DISPATCHED',
  change:Record<string,unknown>={}):TrustedLogicalReservationAuthority=>({
  async withCurrentLogicalAdmission(x,apply){
    // TEST ONLY synthetic witness, not an off-host protected service.
    return apply({
      ownerId:x.ownerId,deviceId:x.deviceId,projectId:x.projectId,
      sessionId:x.sessionId,rootInvocationId:x.rootInvocationId,
      originRunbookId:x.originRunbookId,
      logicalOperationId:x.logicalOperationId,
      logicalMutationSha256:x.logicalMutationSha256,
      ownerEpoch:x.ownerEpoch,grantGeneration:x.grantGeneration,
      mutationState:mode,...change,
    });
  },
});
function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-14-logical-'));
  const filepath=path.join(dir,'ledger.sqlite');
  const one=new DatabaseSync(filepath),two=new DatabaseSync(filepath);
  one.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000');
  two.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000');
  initArtifactBudgetFixture(one);
  // Production P1 callers must use strict mode; old staging source remains
  // for existing source-only legacy tests and is not a physical grant.
  const first=new StagingArtifactByteBudget(one,policy,undefined,true);
  const second=new StagingArtifactByteBudget(two,policy,undefined,true);
  const get=(sql:string)=>
    Number((one.prepare(sql).get() as {n:number}).n);
  return {first,second,one,two,get,close(){
    two.close();one.close();rmSync(dir,{recursive:true,force:true});
  }};
}
test('#791 strict staging admission rejects legacy begin and missing external CAS without any storage reservation',async()=>{
 const f=fixture();try{
   assert.throws(()=>f.first.begin(logical),/LOGICAL_ADMISSION_REQUIRED/);
   await assert.rejects(()=>f.first.beginForLogicalMutation(logical),
     /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),0);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),0);
 }finally{f.close()}
});

test('#791 immutable semantic logical identity denies cloned runbook new session/root while first remains PENDING',async()=>{
 const f=fixture();try{
   assert.equal(await f.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   assert.equal(f.first.stageChunk({
     ownerId:logical.ownerId,deviceId:logical.deviceId,
     projectId:logical.projectId,sessionId:logical.sessionId,
     requestId:'pending-original-791',offsetBytes:0,byteCount:CHUNK,
     chunkSha256:'c'.repeat(64),now:start,
   }),'CHUNK_PENDING');
   assert.equal(f.first.requestCancel({
     ownerId:logical.ownerId,deviceId:logical.deviceId,
     projectId:logical.projectId,sessionId:logical.sessionId,
     expectedOffsetBytes:0,
   }),'CANCEL_PENDING');
   for(const clone of [
     {...logical,sessionId:'session-clone-791',rootInvocationId:'root-clone-791'},
     {...logical,logicalOperationId:'new-id-same-semantic-791',
       sessionId:'session-clone-791',rootInvocationId:'root-clone-791'},
     {...logical,originRunbookId:'forged-runbook-791',
       sessionId:'session-clone-791',rootInvocationId:'root-clone-791'},
     {...logical,ownerEpoch:8,sessionId:'session-clone-791',
       rootInvocationId:'root-clone-791'},
   ]){
     assert.equal(await f.second.beginForLogicalMutation(clone,oracle()),
       'DENIED_REPLAY');
   }
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
   assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"),1);
   assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='CANCEL_PENDING'"),1);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),1);
 }finally{f.close()}
});

test('#791 stale/foreign external witness, owner epoch mismatch and unresolved Native stop all fail before reserve',async()=>{
 const f=fixture();try{
   for(const proof of [
     oracle('MUTATION_UNKNOWN'),oracle('DISPATCHED'),
     oracle('NEVER_DISPATCHED',{ownerEpoch:6}),
     oracle('NEVER_DISPATCHED',{logicalMutationSha256:'0'.repeat(64)}),
     oracle('NEVER_DISPATCHED',{deviceId:'foreign-device-791'}),
     oracle('NEVER_DISPATCHED',{sessionId:'forged-session-791'}),
     oracle('NEVER_DISPATCHED',{rootInvocationId:'forged-root-791'}),
     oracle('NEVER_DISPATCHED',{grantGeneration:10}),
   ]){
     await assert.rejects(
       ()=>f.first.beginForLogicalMutation(logical,proof),
       /LOGICAL_ADMISSION_RECONCILE_REQUIRED/);
   }
   for(const bad of [
     {...logical,logicalOperationId:''},
     {...logical,logicalMutationSha256:'forged'},
   ]){
     await assert.rejects(
       ()=>f.first.beginForLogicalMutation(bad,oracle()),
       /INVALID_LOGICAL_OPERATION|INVALID_SHA256/);
   }
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),0);
 }finally{f.close()}
});

test('#791 same immutable logical task retries are idempotent; after CANCEL_PENDING never reopens',async()=>{
 const f=fixture();try{
   assert.equal(await f.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   assert.equal(await f.second.beginForLogicalMutation(logical,oracle()),'ALREADY_RESERVED');
   assert.equal(f.first.requestCancel({
     ownerId:logical.ownerId,deviceId:logical.deviceId,projectId:logical.projectId,
     sessionId:logical.sessionId,expectedOffsetBytes:0,
   }),'CANCEL_PENDING');
   assert.equal(await f.second.beginForLogicalMutation(logical,oracle()),'DENIED_STATE');
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
 }finally{f.close()}
});

test('#791 concurrent Hub-like DB handles enforce unique canonical semantic reservation locally',async()=>{
 const f=fixture();try{
   const clone={...logical,logicalOperationId:'clone-791-concurrent',
     sessionId:'session-concurrent-791',rootInvocationId:'root-concurrent-791'};
   const pair=await Promise.all([
     f.first.beginForLogicalMutation(logical,oracle()),
     f.second.beginForLogicalMutation(clone,oracle()),
   ]);
   assert.deepEqual([...pair].sort(),['DENIED_REPLAY','RESERVED']);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),1);
 }finally{f.close()}
});

test('#791 distinct semantic task and quiet tenant retain local capacity under held cloned UNKNOWN',async()=>{
 const f=fixture();try{
   assert.equal(await f.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   assert.equal(f.first.requestCancel({
     ownerId:logical.ownerId,deviceId:logical.deviceId,projectId:logical.projectId,
     sessionId:logical.sessionId,expectedOffsetBytes:0,
   }),'CANCEL_PENDING');
   const another={...logical,sessionId:'session-different-791',
     rootInvocationId:'root-different-791',originRunbookId:'different-runbook-791',
     logicalOperationId:'different-effect-791',logicalMutationSha256:'d'.repeat(64)};
   assert.equal(await f.second.beginForLogicalMutation(another,oracle()),'RESERVED');
   const denied={...another,sessionId:'session-third-791',
     rootInvocationId:'root-third-791',logicalOperationId:'third-effect-791',
     logicalMutationSha256:'e'.repeat(64)};
   assert.equal(await f.first.beginForLogicalMutation(denied,oracle()),'DENIED_CAPACITY');
   const quiet={...logical,ownerId:'quiet-owner-791',sessionId:'session-quiet-791',
     originRunbookId:'quiet-runbook-791',rootInvocationId:'root-quiet-791',
     logicalOperationId:'quiet-task-791',logicalMutationSha256:'f'.repeat(64)};
   assert.equal(await f.second.beginForLogicalMutation(quiet,oracle()),'RESERVED');
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),3);
 }finally{f.close()}
});

test('#791 separate local ledgers are NOT a global CAS, production requires shared protected authority',async()=>{
 const a=fixture(),b=fixture();try{
   // Two disconnected local ledgers with synthetic forged UNSEEN answers
   // can each reserve. This test demonstrates why the real #01/#587
   // off-host anti-alias CAS and shared quota store are mandatory.
   assert.equal(await a.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   assert.equal(await b.first.beginForLogicalMutation({
     ...logical,sessionId:'session-disconnected-791',
     rootInvocationId:'root-disconnected-791',
   },oracle()),'RESERVED');
   assert.equal(a.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
   assert.equal(b.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
 }finally{a.close();b.close()}
});

test('#806 exact idempotent session cannot use a new origin runbook or changed owner grant after re-pair',async()=>{
 const f=fixture();try{
   assert.equal(await f.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   for(const changed of [
     {...logical,originRunbookId:'forged-new-origin-806'},
     {...logical,ownerEpoch:logical.ownerEpoch+1},
     {...logical,grantGeneration:logical.grantGeneration+1},
     {...logical,deviceId:'different-device-806'},
   ]){
     assert.equal(await f.second.beginForLogicalMutation(changed,oracle()),
       'DENIED_REPLAY','immutable stored provenance cannot be replaced on retry');
   }
   assert.equal(await f.second.beginForLogicalMutation(logical,oracle()),
     'ALREADY_RESERVED');
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
   assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),1);
 }finally{f.close()}
});

test('#806 disconnected strict SQLite ledgers with no shared authority both fail closed BEFORE reservation',async()=>{
 const a=fixture(),b=fixture();try{
   for(const [ledger,binding] of [
     [a.first,logical] as const,
     [b.second,{...logical,sessionId:'clone-in-new-ledger-806',
       rootInvocationId:'root-clone-in-new-ledger-806'}] as const,
   ]){
     await assert.rejects(
       ()=>ledger.beginForLogicalMutation(binding),
       /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
   }
   for(const f of [a,b]){
     assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),0);
     assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),0);
     assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_chunks'),0);
   }
 }finally{a.close();b.close()}
});

test('#806 two disconnected ledgers with fake UNSEEN witness are unsafe but PENDING never refunds without stop+deletion',async()=>{
 const a=fixture(),b=fixture();try{
   const clone={...logical,sessionId:'different-remote-session-806',
     rootInvocationId:'different-remote-root-806'};
   // This is intentionally not a real off-host CAS: two distinct SQLite
   // stores each accept the same canonical operation under forged UNSEEN.
   assert.equal(await a.first.beginForLogicalMutation(logical,oracle()),'RESERVED');
   assert.equal(await b.second.beginForLogicalMutation(clone,oracle()),'RESERVED');
   for(const [f,x,request] of [
     [a,logical,'first-pending-request-806'] as const,
     [b,clone,'clone-pending-request-806'] as const,
   ]){
     assert.equal(f.first.stageChunk({
       ownerId:x.ownerId,deviceId:x.deviceId,projectId:x.projectId,
       sessionId:x.sessionId,requestId:request,offsetBytes:0,
       byteCount:CHUNK,chunkSha256:'c'.repeat(64),now:start,
     }),'CHUNK_PENDING');
     assert.equal(f.first.requestCancel({
       ownerId:x.ownerId,deviceId:x.deviceId,projectId:x.projectId,
       sessionId:x.sessionId,expectedOffsetBytes:0,
     }),'CANCEL_PENDING');
     const forged={
       ownerId:x.ownerId,deviceId:x.deviceId,projectId:x.projectId,
       sessionId:x.sessionId,durableDeletionVerified:true as const,
       writersStoppedVerified:true as const,
     };
     // Without ANY independent physical verifier, both claimed proofs fail.
     assert.throws(()=>f.first.acknowledgeDeletionOnce(forged),
       /TRUSTED_DELETION_EVIDENCE_REQUIRED/);
     // Even granting a synthetic deletion check, a separate authoritative
     // writer-stop is still mandatory before refunding CANCEL_PENDING.
     const onlyDeletion=new StagingArtifactByteBudget(f.one,policy,{
       verifyChunk:()=>false,verifyFinal:()=>false,
       verifyDeletion:()=>true,verifyWriterFence:()=>false,
     },true);
     assert.throws(()=>onlyDeletion.acknowledgeDeletionOnce(forged),
       /TRUSTED_WRITER_FENCE_REQUIRED/);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"),1);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='CANCEL_PENDING'"),1);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='RELEASED'"),0);
     assert.equal(f.get('SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions'),CHUNK);
   }
   // This is NOT evidence of global admission safety. Only no early release.
 }finally{a.close();b.close()}
});

test('#835/#806 no external CAS: disconnected strict ledgers deny, legacy PENDING cannot refund on unsigned deletion',async()=>{
 const a=fixture(),b=fixture();
 try{
   const cloned={...logical,
     sessionId:'session-cloned-no-cas-835',
     rootInvocationId:'root-cloned-no-cas-835',
     originRunbookId:'runbook-cloned-no-cas-835',
   };
   // No NEVER_DISPATCHED oracle is injected here. An off-host protected
   // authority does not exist, so strict admission MUST reject both ledgers.
   await assert.rejects(()=>a.first.beginForLogicalMutation(logical),
     /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
   await assert.rejects(()=>b.first.beginForLogicalMutation(cloned),
     /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
   for(const f of [a,b]){
     assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),0);
     assert.equal(f.get('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),0);
   }
   // The old staging-only API is intentionally not a production safeguard.
   // Independent local ledgers cannot discover each other's existing session.
   const oldA=new StagingArtifactByteBudget(a.one,policy);
   const oldB=new StagingArtifactByteBudget(b.one,policy);
   assert.equal(oldA.begin(logical),'RESERVED');
   assert.equal(oldB.begin(cloned),'RESERVED');
   for(const [f,budget,subject,request] of [
     [a,oldA,logical,'no-cas-original-pending-835'] as const,
     [b,oldB,cloned,'no-cas-cloned-pending-835'] as const,
   ]){
     assert.equal(budget.stageChunk({
       ownerId:subject.ownerId,deviceId:subject.deviceId,
       projectId:subject.projectId,sessionId:subject.sessionId,
       requestId:request,offsetBytes:0,byteCount:CHUNK,
       chunkSha256:'d'.repeat(64),now:start,
     }),'CHUNK_PENDING');
     assert.equal(budget.requestCancel({
       ownerId:subject.ownerId,deviceId:subject.deviceId,
       projectId:subject.projectId,sessionId:subject.sessionId,
       expectedOffsetBytes:0,
     }),'CANCEL_PENDING');
     // #806 original expects writer-stop error but source first demands a
     // genuinely authenticated deletion verifier. A forged caller boolean
     // cannot serve as either receipt or permission for a storage refund.
     assert.throws(()=>budget.acknowledgeDeletionOnce({
       ownerId:subject.ownerId,deviceId:subject.deviceId,
       projectId:subject.projectId,sessionId:subject.sessionId,
       durableDeletionVerified:true,writersStoppedVerified:true,
     }),/TRUSTED_DELETION_EVIDENCE_REQUIRED/);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='RELEASED'"),0);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='CANCEL_PENDING'"),1);
     assert.equal(f.get("SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"),1);
     assert.equal(f.get('SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions'),CHUNK);
     assert.equal(f.get('SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks'),CHUNK);
   }
   // This test is a SOURCE UNSAFE-LEGACY negative, NOT a global-CAS green.
 }finally{a.close();b.close()}
});
