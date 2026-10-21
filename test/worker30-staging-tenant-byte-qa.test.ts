/**
 * Worker #30: independent staging-only tenant/byte-budget adversarial QA.
 * Uses actual source classes, an in-memory SQLite DB, no physical transfers.
 * The #598 parent does NOT yet contain main's later cancellation fencing;
 * a pending write is intentionally treated as UNKNOWN, not successfully cancelled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';
import {ARTIFACT_CHUNK_BYTES,StagingArtifactByteBudget,initArtifactBudgetFixture}
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const A={ownerId:'owner30-noisy',deviceId:'device30-noisy',projectId:'project30-staging'};
const B={ownerId:'owner30-quiet',deviceId:'device30-quiet',projectId:'project30-staging'};
const SHA=createHash('sha256').update('qa30-synthetic-fixture').digest('hex');
const OTHER_SHA=createHash('sha256').update('qa30-altered-fixture').digest('hex');
const NOW=new Date('2026-10-21T15:30:00.000Z');
const BYTES=2*ARTIFACT_CHUNK_BYTES;
const FREE=8*1024*1024*1024;
const open=(who:typeof A,serial:string)=>({
  ...who,sessionId:'session30-'+serial,rootInvocationId:'root30-'+serial,
  sizeBytes:BYTES,sourceSha256:SHA,physicalFreeBytes:FREE,now:NOW,
});
const chunk=(who:typeof A,serial:string,requestId:string,offset=0)=>({
  ...who,sessionId:'session30-'+serial,requestId,offsetBytes:offset,
  byteCount:ARTIFACT_CHUNK_BYTES,chunkSha256:SHA,now:NOW,
});

test('worker30 protected logical admission keeps quiet tenant throughput under noisy flood',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const share=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'worker30-staging-only',globalRollingMinuteLimit:40,
      tenants:[{tenantId:A.ownerId,weight:1},{tenantId:B.ownerId,weight:1}],
    });
    const events=['quiet-0',...Array.from({length:40},(_,i)=>'noisy-'+i),
      ...Array.from({length:19},(_,i)=>'quiet-'+(i+1))];
    let noisyPass=0,noisyDenied=0,quietPass=0;
    for(const id of events){
      const quiet=id.startsWith('quiet');
      const result=share.observe(quiet?B.ownerId:A.ownerId,
        'invocation30-'+id,SHA,NOW);
      assert.equal(result.authorizesToolExecution,false);
      if(quiet){
        assert.equal(result.status,'reserved');
        quietPass++;
      }else if(result.status==='reserved')noisyPass++;
      else {
        assert.equal(result.status,'tenant-exhausted');
        noisyDenied++;
      }
    }
    assert.deepEqual({quietPass,noisyPass,noisyDenied},{quietPass:20,noisyPass:20,noisyDenied:20});
    assert.equal(share.observe(B.ownerId,'invocation30-quiet-0',SHA,NOW).status,
      'duplicate');
    assert.equal(share.observe(B.ownerId,'invocation30-quiet-0',OTHER_SHA,NOW).status,
      'collision');
    assert.equal(share.observe('forged-other-tenant','invocation30-evil-01',SHA,NOW).status,
      'unknown-tenant');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM s5_fair_window').get() as {n:number}).n,
      40);
  }finally{db.close()}
});

test('worker30 byte reservation isolates quiet owner while noisy owner exhausts concurrency',()=>{
  const db=new DatabaseSync(':memory:');
  initArtifactBudgetFixture(db);
  const budget=new StagingArtifactByteBudget(db);
  try{
    assert.equal(budget.begin(open(A,'noisy-a')),'RESERVED');
    assert.equal(budget.begin(open(A,'noisy-b')),'RESERVED');
    assert.equal(budget.begin(open(A,'noisy-c')),'DENIED_CONCURRENCY');
    assert.equal(budget.begin(open(B,'quiet-a')),'RESERVED');
    assert.equal(budget.begin(open(B,'quiet-a')),'ALREADY_RESERVED');
    assert.equal(budget.begin({...open(B,'quiet-a'),sourceSha256:OTHER_SHA}),
      'DENIED_REPLAY');
    assert.equal(budget.stageChunk(chunk(B,'quiet-a','req30-quiet-1')),
      'CHUNK_PENDING');
    assert.equal(budget.stageChunk(chunk(B,'quiet-a','req30-quiet-2')),
      'DENIED_PENDING');
    assert.throws(()=>budget.stageChunk({
      ...chunk(B,'quiet-a','req30-too-large'),byteCount:ARTIFACT_CHUNK_BYTES+1,
    }),/CHUNK_SIZE_INVALID/);
    assert.equal(budget.stageChunk({
      ...chunk(A,'noisy-a','req30-noisy-1'),offsetBytes:1,
    }),'DENIED_OFFSET');
    assert.equal(budget.stageChunk(chunk(A,'noisy-a','req30-noisy-1')),
      'CHUNK_PENDING');
    assert.equal(budget.stageChunk(chunk(A,'noisy-a','req30-noisy-1')),
      'CHUNK_PENDING','pending duplicate never executes/charges again');
    const receipts=db.prepare(
      'SELECT owner_id,COUNT(*) AS n,SUM(byte_count) AS bytes FROM budget_artifact_chunks GROUP BY owner_id ORDER BY owner_id'
    ).all() as Array<{owner_id:string;n:number;bytes:number}>;
    assert.equal(receipts.length,2);
    assert.ok(receipts.every(r=>r.n===1&&r.bytes===ARTIFACT_CHUNK_BYTES));
    // No deletion/refund is implied by cancellation or an unknown external ACK.
  }finally{db.close()}
});

test('worker30 unknown/cancelled-in-flight chunk must keep charge until authoritative reconciliation',()=>{
  const db=new DatabaseSync(':memory:');
  initArtifactBudgetFixture(db);
  const budget=new StagingArtifactByteBudget(db);
  try{
    assert.equal(budget.begin(open(A,'cancelled')),'RESERVED');
    const c=chunk(A,'cancelled','req30-pending-write');
    assert.equal(budget.stageChunk(c),'CHUNK_PENDING');
    // Simulate transport disconnect/cancellation BEFORE durable ACK.
    // Parent source has no trusted writer fence: don't invent an ACK or release.
    assert.equal(budget.stageChunk(c),'CHUNK_PENDING');
    assert.equal(budget.stageChunk(chunk(A,'cancelled','req30-replay-second')),
      'DENIED_PENDING');
    assert.equal(budget.stageChunk({...c,chunkSha256:OTHER_SHA}),'DENIED_REPLAY');
    assert.equal(budget.commitChunk({
      ...c,storedSha256:OTHER_SHA,durableStorageVerified:true,
    }),'DENIED_REPLAY','forged hash must never advance offset');
    assert.equal(budget.begin(open(B,'unrelated')),'RESERVED');
    assert.equal(budget.stageChunk(chunk(B,'unrelated','req30-quiet-progress')),
      'CHUNK_PENDING','quiet owner can continue without recycling unknown reservation');
    const row=db.prepare(
      'SELECT offset_bytes,state FROM budget_artifact_sessions WHERE session_id=?'
    ).get(c.sessionId) as {offset_bytes:number;state:string};
    assert.deepEqual(row,{offset_bytes:0,state:'OPEN'});
    const count=(db.prepare(
      'SELECT SUM(byte_count) AS n FROM budget_artifact_chunks'
    ).get() as {n:number}).n;
    assert.equal(count,2*ARTIFACT_CHUNK_BYTES,
      'pending/cancel-unknown debit remains; no blind replay/refund');
  }finally{db.close()}
});

test('worker30 synthetic 64KiB metadata safely crosses 256MiB without allocating file bytes',()=>{
  const step=BigInt(ARTIFACT_CHUNK_BYTES);
  const logicalSize=BigInt(256*1024*1024+ARTIFACT_CHUNK_BYTES);
  let offset=0n;
  let count=0;
  let lastDigest='';
  while(offset<logicalSize){
    const next=offset+step;
    assert.ok(next<=logicalSize);
    lastDigest=createHash('sha256').update('receipt30:'+String(offset)).digest('hex');
    offset=next;count++;
  }
  assert.equal(count,4097);
  assert.equal(offset,logicalSize);
  assert.match(lastDigest,/^[0-9a-f]{64}$/);
  assert.equal(ARTIFACT_CHUNK_BYTES,65536);
  // Metadata arithmetic only: 0 file bytes written, 0 native completions.
});
