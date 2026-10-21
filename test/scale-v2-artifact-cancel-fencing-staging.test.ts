import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {
 ARTIFACT_CHUNK_BYTES,initArtifactBudgetFixture,StagingArtifactByteBudget,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

/**
 * Two independent SQLite connections against a disposable WAL DB.
 * This is not a real D1 Worker, Agent or Artifact Bridge integration.
 */
const a={ownerId:'owner-alpha',deviceId:'device-alpha',projectId:'project-alpha'};
const b={ownerId:'owner-bravo',deviceId:'device-bravo',projectId:'project-bravo'};
/* Existing fake durable-store fixture. New provenance negative tests below
 * use an independent evidence provider; NEVER use this in runtime code. */
const legacyFixtureProofs={
  verifyChunk:()=>true,verifyFinal:()=>true,
  verifyDeletion:()=>true,verifyWriterFence:()=>true,
};
const at=new Date('2026-10-20T23:59:59.900Z');
const digest='a'.repeat(64);
const chunkHash='b'.repeat(64);
const fileBytes=ARTIFACT_CHUNK_BYTES*2;
const freeBytes=8*1024**3;
function fixture(){
 const folder=mkdtempSync(path.join(tmpdir(),'nx-artifact-cancel-'));
 const name=path.join(folder,'quota.sqlite');
 const x=new DatabaseSync(name),y=new DatabaseSync(name);
 x.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
 y.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
 initArtifactBudgetFixture(x);
 const sum=(sql:string,...params:(number|string)[])=>Number(
    (x.prepare(sql).get(...params) as {n:number}|undefined)?.n??0);
 return {
   p:new StagingArtifactByteBudget(x,undefined,legacyFixtureProofs),
   q:new StagingArtifactByteBudget(y,undefined,legacyFixtureProofs),
   sum,
   close(){y.close();x.close();rmSync(folder,{recursive:true,force:true})},
 };
}
function open(owner=a,sessionId='session-alpha-01',root='root-alpha-0001'){
 return {...owner,sessionId,rootInvocationId:root,sizeBytes:fileBytes,
   sourceSha256:digest,physicalFreeBytes:freeBytes,now:at};
}
function chunk(owner=a,id='chunk-alpha-001',offset=0){
 return {...owner,sessionId:'session-alpha-01',requestId:id,
   offsetBytes:offset,byteCount:ARTIFACT_CHUNK_BYTES,
   chunkSha256:chunkHash,now:at};
}
function committedReceipt(c:ReturnType<typeof chunk>){
 return {...c,storedSha256:chunkHash,durableStorageVerified:true as const};
}
function cancelled(owner=a,offset=0){
 return {...owner,sessionId:'session-alpha-01',expectedOffsetBytes:offset};
}
function deleted(owner=a,fenced=true){
 return {...owner,sessionId:'session-alpha-01',
   durableDeletionVerified:true as const,
   ...(fenced?{writersStoppedVerified:true as const}:{}),
 };
}
const activeStorage=(f:ReturnType<typeof fixture>)=>f.sum(
 'SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>?',
 'RELEASED');
const attemptedBytes=(f:ReturnType<typeof fixture>)=>f.sum(
 'SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks');
test('cancel without verified writer barrier tombstones session but cannot release disk reservation',()=>{
 const f=fixture();try{
   assert.equal(f.p.begin(open()),'RESERVED');
   assert.equal(f.q.requestCancel(cancelled()),'CANCEL_PENDING');
   assert.equal(f.p.requestCancel(cancelled()),'ALREADY_CANCEL_PENDING');
   assert.equal(f.p.begin(open()),'DENIED_STATE');
   assert.equal(f.q.stageChunk(chunk()),'DENIED_STATE');
   assert.throws(()=>f.p.acknowledgeDeletion(deleted(a,false)),
     /TRUSTED_WRITER_FENCE_REQUIRED/);
   assert.equal(activeStorage(f),fileBytes);
 }finally{f.close()}
});
test('owner scoped cancellation and stale offsets cannot tombstone a different live session',()=>{
 const f=fixture();try{
   assert.equal(f.p.begin(open()),'RESERVED');
   assert.equal(f.q.requestCancel(cancelled(b)), 'DENIED_OWNER');
   assert.equal(f.q.requestCancel(cancelled({...a,deviceId:'device-rogue'})),
     'DENIED_OWNER');
   assert.equal(f.q.requestCancel(cancelled({...a,projectId:'project-rogue'})),
     'DENIED_OWNER');
   assert.equal(f.q.requestCancel(cancelled(a,65536)),'DENIED_OFFSET');
   assert.equal(f.p.stageChunk(chunk()),'CHUNK_PENDING');
   assert.equal(f.q.commitChunk(committedReceipt(chunk())),'CHUNK_COMMITTED');
   assert.equal(f.q.requestCancel(cancelled(a,0)),'DENIED_OFFSET');
   assert.equal(f.q.requestCancel(cancelled(a,65536)),'CANCEL_PENDING');
   assert.equal(f.q.requestCancel(cancelled(a,65536)),'ALREADY_CANCEL_PENDING');
   assert.equal(f.p.requestCancel(cancelled(a,0)),'DENIED_OFFSET');
 }finally{f.close()}
});
test('cancelling pending/unknown write is never a second charge or a replayable upload',()=>{
 const f=fixture();try{
   assert.equal(f.p.begin(open()),'RESERVED');
   const c=chunk();
   assert.equal(f.p.stageChunk(c),'CHUNK_PENDING');
   assert.equal(f.q.requestCancel(cancelled()),'CANCEL_PENDING');
   assert.equal(f.q.stageChunk(c),'DENIED_STATE');
   assert.equal(f.q.commitChunk(committedReceipt(c)),'DENIED_STATE');
   assert.equal(f.p.stageChunk(chunk(a,'chunk-alpha-002')),'DENIED_STATE');
   assert.equal(attemptedBytes(f),65536);
   assert.equal(activeStorage(f),fileBytes);
   assert.equal(f.p.finalize({...a,sessionId:'session-alpha-01',
     storedSizeBytes:fileBytes,storedSha256:digest,durableStorageVerified:true}),
     'DENIED_STATE');
   assert.equal(f.p.acknowledgeDeletion(deleted()),'RELEASED');
   assert.equal(f.q.acknowledgeDeletion(deleted()),'RELEASED');
   assert.equal(activeStorage(f),0);
   assert.equal(attemptedBytes(f),65536);
   assert.equal(f.q.begin(open()),'DENIED_STATE');
 }finally{f.close()}
});
test('different owner can reserve and progress while cancelled owner retains tombstone and minute debit',()=>{
 const f=fixture();try{
   assert.equal(f.p.begin(open()),'RESERVED');
   assert.equal(f.q.stageChunk(chunk()),'CHUNK_PENDING');
   assert.equal(f.q.requestCancel(cancelled()),'CANCEL_PENDING');
   assert.equal(f.p.begin(open(b,'session-bravo-0001','root-bravo-0001')),'RESERVED');
   assert.equal(f.p.stageChunk({...chunk(b,'chunk-bravo-0001'),
     sessionId:'session-bravo-0001'}),'CHUNK_PENDING');
   assert.equal(f.sum('SELECT SUM(byte_count) AS n FROM budget_artifact_chunks'),
      2*ARTIFACT_CHUNK_BYTES);
   assert.equal(f.p.acknowledgeDeletion(deleted()),'RELEASED');
   assert.equal(f.sum('SELECT SUM(byte_count) AS n FROM budget_artifact_chunks'),
      2*ARTIFACT_CHUNK_BYTES);
   assert.equal(activeStorage(f),fileBytes);
 }finally{f.close()}
});
test('ordinary completed-file deletion behavior stays unchanged and cannot be cancelled',()=>{
 const f=fixture();try{
   assert.equal(f.p.begin(open()),'RESERVED');
   const c1=chunk(),c2=chunk(a,'chunk-alpha-002',65536);
   for(const c of [c1,c2]){
      assert.equal(f.p.stageChunk(c),'CHUNK_PENDING');
      assert.equal(f.q.commitChunk(committedReceipt(c)),'CHUNK_COMMITTED');
   }
   assert.equal(f.p.finalize({...a,sessionId:'session-alpha-01',
     storedSizeBytes:fileBytes,storedSha256:digest,durableStorageVerified:true}),
     'COMPLETE');
   assert.equal(f.q.requestCancel(cancelled(a,fileBytes)),'DENIED_STATE');
   assert.equal(f.q.acknowledgeDeletion(deleted(a,false)),'RELEASED');
   assert.equal(activeStorage(f),0);
 }finally{f.close()}
});
