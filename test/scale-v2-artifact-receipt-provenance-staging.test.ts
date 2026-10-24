import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {
  ARTIFACT_CHUNK_BYTES,initArtifactBudgetFixture,StagingArtifactByteBudget,
  type ArtifactDurableProofVerifier,
  type TrustedDurableChunkReceipt,
  type TrustedDurableFinalReceipt,
  type TrustedRemovedReceipt,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

/**
 * Independent #596/#605 quota-only fault model. All packets and receipts
 * are synthetic. No live Agent, actual Artifact Bridge Store or remote D1.
 * The verifier reads independently granted local facts, not caller fields.
 */
const alpha={ownerId:'owner-alpha',deviceId:'device-alpha',projectId:'project-alpha'};
const bravo={ownerId:'owner-bravo',deviceId:'device-bravo',projectId:'project-bravo'};
const started=new Date('2026-10-20T23:59:59.900Z');
const nextEpoch=new Date('2026-10-21T00:00:00.100Z');
const afterWindow=new Date('2026-10-21T00:01:00.001Z');
const fileSha='a'.repeat(64);
const chunkSha=createHash('sha256').update('synthetic chunk A').digest('hex');
const chunkB=createHash('sha256').update('synthetic chunk B').digest('hex');
const chunkSize=ARTIFACT_CHUNK_BYTES;
const bytes2=chunkSize*2;
type Principal=typeof alpha;
const key=(...v:(string|number)[])=>v.join('|');
function fixture(){
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-quota-proof-'));
  const file=path.join(folder,'quota.db');
  const db1=new DatabaseSync(file),db2=new DatabaseSync(file);
  db1.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000');
  db2.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000');
  initArtifactBudgetFixture(db1);

  // Simulated independently verified durable-store facts. In production
  // #08 alone would attest these, and #605 would fence write generations.
  const committed=new Set<string>();
  const published=new Set<string>();
  const deleted=new Set<string>();
  const fenced=new Set<string>();
  const cKey=(r:TrustedDurableChunkReceipt)=>key(r.ownerId,r.deviceId,r.projectId,
    r.sessionId,r.requestId,r.offsetBytes,r.byteCount,r.storedSha256);
  const sKey=(r:TrustedRemovedReceipt)=>key(r.ownerId,r.deviceId,r.projectId,r.sessionId);
  const fKey=(r:TrustedDurableFinalReceipt)=>key(r.ownerId,r.deviceId,r.projectId,
    r.sessionId,r.storedSizeBytes,r.storedSha256);
  const proofs:ArtifactDurableProofVerifier={
    verifyChunk:r=>committed.has(cKey(r)),
    verifyFinal:r=>published.has(fKey(r)),
    verifyDeletion:r=>deleted.has(sKey(r)),
    verifyWriterFence:r=>fenced.has(sKey(r)),
  };
  const n=(sql:string)=>Number((db1.prepare(sql).get() as {n:number}|undefined)?.n??0);
  return {first:new StagingArtifactByteBudget(db1,undefined,proofs),
    second:new StagingArtifactByteBudget(db2,undefined,proofs),
    untrusted:new StagingArtifactByteBudget(db2),
    committed,published,deleted,fenced,cKey,sKey,fKey,n,
    close(){db2.close();db1.close();rmSync(folder,{recursive:true,force:true})},
  };
}
const open=(owner:Principal=alpha,sessionId='session-alpha-01',
  rootInvocationId='root-alpha-01',now=started)=>({
  ...owner,sessionId,rootInvocationId,sizeBytes:bytes2,sourceSha256:fileSha,
  physicalFreeBytes:16*1024**3,now,
});
const chunk=(owner:Principal=alpha,requestId='request-alpha-01',
 offsetBytes=0,now=started,chunkSha256=chunkSha)=>({
  ...owner,sessionId:'session-alpha-01',requestId,offsetBytes,
  byteCount:chunkSize,chunkSha256,now,
});
const receipt=(c:ReturnType<typeof chunk>)=>({
  ...c,storedSha256:c.chunkSha256,durableStorageVerified:true as const,
});
const deletedReceipt=(owner:Principal=alpha)=>({
  ...owner,sessionId:'session-alpha-01',durableDeletionVerified:true as const,
  writersStoppedVerified:true as const,
});
const summed=(f:ReturnType<typeof fixture>)=>({
  bytes:f.n('SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks'),
  sessions:f.n('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),
  active:f.n("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"),
});

test('forged client boolean flags cannot attest durable chunk, publish, deletion or writer fence',()=>{
  const f=fixture();try{
    assert.equal(f.untrusted.begin(open()),'RESERVED');
    const c=chunk(),r=receipt(c);
    assert.equal(f.untrusted.stageChunk(c),'CHUNK_PENDING');
    assert.throws(()=>f.untrusted.commitChunk(r),/TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
    assert.throws(()=>f.untrusted.finalize({...alpha,sessionId:c.sessionId,
      storedSizeBytes:bytes2,storedSha256:fileSha,durableStorageVerified:true}),
      /TRUSTED_FINAL_EVIDENCE_REQUIRED/);
    assert.equal(f.untrusted.requestCancel({...alpha,sessionId:c.sessionId,
      expectedOffsetBytes:0}),'CANCEL_PENDING');
    assert.throws(()=>f.untrusted.acknowledgeDeletion(deletedReceipt()),
      /TRUSTED_DELETION_EVIDENCE_REQUIRED/);
    assert.deepEqual(summed(f),{bytes:chunkSize,sessions:1,active:1});
    // A trusted verifier still refuses a boolean with NO independent fact.
    assert.throws(()=>f.second.commitChunk(r),/TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
    assert.throws(()=>f.second.acknowledgeDeletion(deletedReceipt()),
      /TRUSTED_DELETION_EVIDENCE_REQUIRED/);
  }finally{f.close()}
});
test('authenticated #596-like stream scopes cannot borrow another owner/device/project after reconnect',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const good=chunk();
    for(const principal of [
      {...alpha,ownerId:bravo.ownerId},
      {...alpha,deviceId:bravo.deviceId},
      {...alpha,projectId:bravo.projectId},
    ]){
      const forged={...good,...principal};
      assert.equal(f.second.stageChunk(forged),'DENIED_OWNER');
    }
    assert.equal(f.first.stageChunk(good),'CHUNK_PENDING');
    const proof=receipt(good);
    f.committed.add(f.cKey(proof));
    assert.equal(f.second.commitChunk(proof),'CHUNK_COMMITTED');
    assert.throws(()=>f.second.commitChunk({...proof,deviceId:bravo.deviceId}),
      /TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
    assert.deepEqual(summed(f),{bytes:chunkSize,sessions:1,active:1});
  }finally{f.close()}
});
test('#605 disconnected ACK: durable commit survives new writer object with no extra admitted bytes',()=>{
 const f=fixture();try{
   assert.equal(f.first.begin(open()),'RESERVED');
   const c=chunk();
   assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
   const proof=receipt(c);
   f.committed.add(f.cKey(proof));
   assert.equal(f.first.commitChunk(proof),'CHUNK_COMMITTED');
   // Simulated ACK disappears after storage commit, not before it.
   assert.equal(f.second.stageChunk({...c,now:nextEpoch}),
     'CHUNK_ALREADY_COMMITTED');
   assert.equal(f.second.commitChunk(proof),'CHUNK_ALREADY_COMMITTED');
   assert.equal(f.second.stageChunk({...c,now:nextEpoch,
     chunkSha256:chunkB}),'DENIED_REPLAY');
   const next=chunk(alpha,'request-alpha-02',chunkSize,nextEpoch,chunkB);
   assert.equal(f.second.stageChunk(next),'CHUNK_PENDING');
   // Without the independently verified durable second write, do NOT advance.
   assert.throws(()=>f.first.commitChunk(receipt(next)),
     /TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
   assert.deepEqual(summed(f),{bytes:bytes2,sessions:1,active:1});
 }finally{f.close()}
});
test('new transport epoch after cancelled stream cannot refund prior window nor replay old root',()=>{
 const f=fixture();try{
   assert.equal(f.first.begin(open()),'RESERVED');
   const c=chunk();
   assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
   assert.equal(f.second.requestCancel({...alpha,sessionId:'session-alpha-01',
     expectedOffsetBytes:0}),'CANCEL_PENDING');
   assert.equal(f.first.stageChunk({...c,now:nextEpoch}),'DENIED_STATE');
   assert.equal(f.second.stageChunk(chunk(alpha,'request-alpha-02',0,nextEpoch)),
     'DENIED_STATE');
   assert.equal(f.first.begin(open(alpha,'session-alpha-01','root-alpha-01',nextEpoch)),
     'DENIED_STATE');
   const del=deletedReceipt();
   f.deleted.add(f.sKey(del));
   assert.throws(()=>f.second.acknowledgeDeletion(del),
     /TRUSTED_WRITER_FENCE_REQUIRED/);
   assert.deepEqual(summed(f),{bytes:chunkSize,sessions:1,active:1});
   // Old process independently fenced, then durable deletion verified.
   f.fenced.add(f.sKey(del));
   assert.equal(f.second.acknowledgeDeletion(del),'RELEASED');
   assert.equal(f.first.acknowledgeDeletion(del),'RELEASED');
   assert.deepEqual(summed(f),{bytes:chunkSize,sessions:1,active:0});
   assert.equal(f.second.begin(open(alpha,'session-alpha-01','root-alpha-01',
     afterWindow)),'DENIED_STATE');
   assert.equal(f.second.begin(open(bravo,'session-bravo-01','root-bravo-01',
     afterWindow)),'RESERVED');
   assert.deepEqual(summed(f),{bytes:chunkSize,sessions:2,active:1});
 }finally{f.close()}
});
test('independent completed-file and cancelled-file attestation must match stored scope and SHA',()=>{
 const f=fixture();try{
   assert.equal(f.first.begin(open()),'RESERVED');
   for(const c of [chunk(),chunk(alpha,'request-alpha-02',chunkSize,nextEpoch,chunkB)]){
     const r=receipt(c);
     assert.equal(f.second.stageChunk(c),'CHUNK_PENDING');
     assert.throws(()=>f.second.commitChunk(r),
       /TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
     f.committed.add(f.cKey(r));
     assert.equal(f.second.commitChunk(r),'CHUNK_COMMITTED');
   }
   const final={...alpha,sessionId:'session-alpha-01',
     storedSizeBytes:bytes2,storedSha256:fileSha,
     durableStorageVerified:true as const};
   assert.throws(()=>f.first.finalize(final),/TRUSTED_FINAL_EVIDENCE_REQUIRED/);
   f.published.add(f.fKey(final));
   assert.equal(f.first.finalize(final),'COMPLETE');
   assert.equal(f.second.finalize(final),'ALREADY_COMPLETE');
   assert.throws(()=>f.second.acknowledgeDeletion(deletedReceipt()),
     /TRUSTED_DELETION_EVIDENCE_REQUIRED/);
   const dr=deletedReceipt();
   f.deleted.add(f.sKey(dr));
   // Durable final bytes + physical deletion are not an independent
   // writer-stop/fence receipt. No capacity can be reclaimed yet.
   assert.throws(()=>f.second.acknowledgeDeletion(dr),
     /TRUSTED_WRITER_FENCE_REQUIRED/);
   assert.deepEqual(summed(f),{bytes:bytes2,sessions:1,active:1});
   f.fenced.add(f.sKey(dr));
   assert.equal(f.second.acknowledgeDeletion(dr),'RELEASED');
   assert.deepEqual(summed(f),{bytes:bytes2,sessions:1,active:0});
 }finally{f.close()}
});
