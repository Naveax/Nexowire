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
