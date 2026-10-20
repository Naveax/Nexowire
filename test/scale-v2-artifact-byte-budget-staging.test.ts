import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_CHUNK_BYTES,StagingArtifactByteBudget,
  STAGING_ARTIFACT_BUDGET,initArtifactBudgetFixture,
  type ArtifactBudgetPolicy,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const t=new Date('2026-10-20T23:59:59.900Z');
const later=new Date('2026-10-21T00:01:00.001Z');
const a={ownerId:'owner-alpha',deviceId:'device-alpha',projectId:'project-alpha'};
const b={ownerId:'owner-bravo',deviceId:'device-bravo',projectId:'project-bravo'};
const digest='a'.repeat(64);
const hash='b'.repeat(64);
const free=16*1024*1024*1024;
const size=ARTIFACT_CHUNK_BYTES*2;

function fixture(policy?:ArtifactBudgetPolicy){
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-byte-budget-'));
  const file=path.join(dir,'budget.db');
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
  initArtifactBudgetFixture(db);
  const db2=new DatabaseSync(file);
  db2.exec('PRAGMA busy_timeout=10000');
  const first=new StagingArtifactByteBudget(db,policy);
  const second=new StagingArtifactByteBudget(db2,policy);
  const n=(sql:string,...params:(number|string)[])=>Number(
    (db.prepare(sql).get(...params) as {n:number}|undefined)?.n??0
  );
  return {
    db,db2,first,second,n,
    close(){db2.close();db.close();rmSync(dir,{recursive:true,force:true})},
  };
}
function open(owner=a,sessionId='session-alpha-01',rootInvocationId='logical-root-01',sizeBytes=size,now=t){
  return {...owner,sessionId,rootInvocationId,sizeBytes,sourceSha256:digest,
    physicalFreeBytes:free,now};
}
function chunk(owner=a,sessionId='session-alpha-01',requestId='chunk-id-0001',
  offsetBytes=0,byteCount=ARTIFACT_CHUNK_BYTES,now=t){
  return {...owner,sessionId,requestId,offsetBytes,byteCount,chunkSha256:hash,now};
}
function durable(c:ReturnType<typeof chunk>){
  return {...c,storedSha256:c.chunkSha256,durableStorageVerified:true as const};
}
const baseReceipt={...a,sessionId:'session-alpha-01',storedSizeBytes:size,
  storedSha256:digest,durableStorageVerified:true as const};

test('bounded 64KiB atomic reservation, durable commit, full hash and storage stay charged until deletion',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    assert.equal(f.second.begin(open()),'ALREADY_RESERVED');
    const c1=chunk();
    assert.equal(f.first.stageChunk(c1),'CHUNK_PENDING');
    assert.equal(f.second.stageChunk(c1),'CHUNK_PENDING');
    assert.equal(f.first.stageChunk(chunk(a,'session-alpha-01','chunk-id-0002',65536)),
      'DENIED_OFFSET');
    assert.equal(f.second.commitChunk(durable(c1)),'CHUNK_COMMITTED');
    assert.equal(f.first.commitChunk(durable(c1)),'CHUNK_ALREADY_COMMITTED');
    const c2=chunk(a,'session-alpha-01','chunk-id-0002',65536);
    assert.equal(f.second.stageChunk(c2),'CHUNK_PENDING');
    assert.equal(f.first.commitChunk(durable(c2)),'CHUNK_COMMITTED');
    assert.equal(f.first.finalize({...baseReceipt,storedSha256:hash}),
      'DENIED_REPLAY');
    assert.equal(f.second.finalize(baseReceipt),'COMPLETE');
    assert.equal(f.first.finalize(baseReceipt),'ALREADY_COMPLETE');
    assert.equal(f.n('SELECT SUM(size_bytes) AS n FROM budget_artifact_sessions WHERE state<>?', 'RELEASED'),size);
    assert.equal(f.first.acknowledgeDeletion({
      ...a,sessionId:'session-alpha-01',durableDeletionVerified:true,
    }),'RELEASED');
    assert.equal(f.n('SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>?', 'RELEASED'),0);
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks'),2);
    assert.equal(f.n('SELECT SUM(byte_count) AS n FROM budget_artifact_chunks'),size);
  }finally{f.close()}
});
test('different SHA, size, device, owner, project or root ID never reuses a session/billed logical root',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    assert.equal(f.second.begin({...open(),sourceSha256:hash}),'DENIED_REPLAY');
    assert.equal(f.second.begin({...open(),sizeBytes:100}),'DENIED_REPLAY');
    assert.equal(f.second.begin({...open(),deviceId:'device-rogue'}),'DENIED_REPLAY');
    assert.equal(f.second.begin({...open(),projectId:'project-rogue'}),'DENIED_REPLAY');
    assert.equal(f.second.begin({...open(),ownerId:'owner-rogue'}),'DENIED_REPLAY');
    assert.equal(f.second.begin({...open(),rootInvocationId:'logical-root-02'}),'DENIED_REPLAY');
    assert.equal(f.second.begin(open(a,'session-alpha-02','logical-root-01')),'DENIED_REPLAY');
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
  }finally{f.close()}
});
test('same chunk request ID different bytes, owner or hash conflicts; ambiguous pending never auto-replays',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const c=chunk();
    assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.second.stageChunk({...c,chunkSha256:digest}),'DENIED_REPLAY');
    assert.equal(f.second.stageChunk({...c,byteCount:1024}),'DENIED_REPLAY');
    assert.equal(f.second.stageChunk({...c,ownerId:'owner-rogue'}),'DENIED_REPLAY');
    assert.equal(f.second.stageChunk({...c,deviceId:'device-rogue'}),'DENIED_REPLAY');
    assert.equal(f.second.commitChunk({...durable(c),storedSha256:digest}),'DENIED_REPLAY');
    assert.equal(f.second.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.first.finalize(baseReceipt),'DENIED_STATE');
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks'),1);
    assert.equal(f.n('SELECT SUM(byte_count) AS n FROM budget_artifact_chunks'),65536);
  }finally{f.close()}
});
test('owner minute cap and another owner cannot be starved by one large transfer',()=>{
  const p={...STAGING_ARTIFACT_BUDGET,ownerMinuteBytes:2*ARTIFACT_CHUNK_BYTES,
    globalMinuteBytes:16*ARTIFACT_CHUNK_BYTES};
  const f=fixture(p);try{
    assert.equal(f.first.begin(open(a,'session-owner-alpha','root-owner-alpha',4*ARTIFACT_CHUNK_BYTES)),'RESERVED');
    assert.equal(f.second.begin(open(b,'session-owner-bravo','root-owner-bravo',4*ARTIFACT_CHUNK_BYTES)),'RESERVED');
    let c=chunk(a,'session-owner-alpha','request-alpha-001');
    assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.first.commitChunk(durable(c)),'CHUNK_COMMITTED');
    c=chunk(a,'session-owner-alpha','request-alpha-002',65536);
    assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.first.commitChunk(durable(c)),'CHUNK_COMMITTED');
    c=chunk(a,'session-owner-alpha','request-alpha-003',131072);
    assert.equal(f.first.stageChunk(c),'DENIED_RATE');
    c=chunk(b,'session-owner-bravo','request-bravo-001');
    assert.equal(f.second.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.second.commitChunk(durable(c)),'CHUNK_COMMITTED');
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE owner_id=?',a.ownerId),2);
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE owner_id=?',b.ownerId),1);
    assert.equal(f.first.stageChunk(chunk(a,'session-owner-alpha','request-alpha-004',131072,65536,later)),'CHUNK_PENDING');
  }finally{f.close()}
});
test('1GiB logical size permitted with bounded chunks; sparse/unlimited single MCP payload forbidden',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin(open(a,'session-large-gigabyte','root-large-gigabyte',1024**3)),'RESERVED');
    assert.throws(()=>f.first.stageChunk(chunk(a,'session-large-gigabyte','huge-request-01',0,1024**3)),/CHUNK_SIZE_INVALID/);
    assert.equal(f.first.stageChunk(chunk(a,'session-large-gigabyte','huge-request-02',0,65536)),'CHUNK_PENDING');
    assert.equal(f.first.begin(open(a,'session-too-large','root-too-large',5*1024**3)),'DENIED_CAPACITY');
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),1);
  }finally{f.close()}
});
test('physical free space, storage reservation, and per-owner active-session caps fail closed',()=>{
  const f=fixture();try{
    assert.equal(f.first.begin({...open(),physicalFreeBytes:1024}),'DENIED_CAPACITY');
    assert.equal(f.first.begin({...open(a,'session-alpha-01','logical-root-01',1024**3),physicalFreeBytes:1024**3+10}),'DENIED_CAPACITY');
    assert.equal(f.first.begin(open(a,'session-alpha-01','logical-root-01',1024**3)),'RESERVED');
    assert.equal(f.first.begin(open(a,'session-alpha-02','logical-root-02',1024**3-65536)),'RESERVED');
    assert.equal(f.second.begin(open(a,'session-alpha-03','logical-root-03',65536)),'DENIED_CONCURRENCY');
    assert.equal(f.second.begin(open(b,'session-bravo-01','logical-root-bravo',65536)),'RESERVED');
    assert.equal(f.first.begin(open(a,'session-alpha-03','logical-root-03',131072)),'DENIED_CAPACITY');
  }finally{f.close()}
});
test('no automatic pending refund, clock rollback, cross-user billing or impossible policy',()=>{
  assert.throws(()=>new StagingArtifactByteBudget(new DatabaseSync(':memory:'),{
    ...STAGING_ARTIFACT_BUDGET,ownerMinuteBytes:STAGING_ARTIFACT_BUDGET.globalMinuteBytes,
  }),/FAIRNESS_POLICY_INVALID/);
  const f=fixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const c=chunk();
    assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
    assert.equal(f.second.stageChunk(chunk(a,'session-alpha-01','chunk-id-0002')),
      'DENIED_PENDING');
    assert.equal(f.second.begin(open(b,'session-bravo-01','logical-bravo-01')),'RESERVED');
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks'),1);
    assert.throws(()=>f.second.stageChunk(chunk(a,'session-alpha-01','chunk-id-0003',0,65536,
      new Date('2026-10-20T23:59:59.000Z'))),/BUDGET_CLOCK_ROLLBACK/);
    assert.equal(f.n('SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE owner_id=?',b.ownerId),0);
    assert.equal(f.first.acknowledgeDeletion({
      ...a,sessionId:'session-alpha-01',durableDeletionVerified:true,
    }),'DENIED_STATE');
  }finally{f.close()}
});
