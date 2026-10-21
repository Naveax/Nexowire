/**
 * Worker30 QA-only: pending-receipt cancellation and tenant memory backpressure.
 * Uses actual staging SQLite byte ledger plus an explicitly TEST-LOCAL memory
 * witness model. #598 has no production tenant memory fence or real CAS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {
  ARTIFACT_CHUNK_BYTES,StagingArtifactByteBudget,initArtifactBudgetFixture,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const CHUNK=ARTIFACT_CHUNK_BYTES;
const MAX_OWNER_BYTES=CHUNK*2;
const SHA=createHash('sha256').update('qa30-pending-receipts-fixture').digest('hex');
const OTHER=createHash('sha256').update('qa30-forged-fixture').digest('hex');
const NOW=new Date('2026-10-21T17:00:00.000Z');
type Tenant='owner30-noisy'|'owner30-quiet';
const A:Tenant='owner30-noisy', B:Tenant='owner30-quiet';
type Lease={owner:Tenant;requestId:string;epoch:number;bytes:number;
  state:'INFLIGHT'|'CANCEL_PENDING'|'MUTATION_UNKNOWN'|'RELEASED'};
type Evidence={owner:Tenant;requestId:string;epoch:number;
  durableReadbackSha:string;source:'STAGED_WITNESS_SIMULATOR'};
class TestOnlyWriterWitness {
  private readonly observations=new Map<string,{
    owner:Tenant;epoch:number;stopped:boolean;readbackSha:string|null;
  }>();
  private readonly issued=new WeakMap<object,Evidence>();
  arm(owner:Tenant,requestId:string,epoch:number){
    const existed=this.observations.get(requestId);
    if(existed)throw Error('DUPLICATE_WITNESS_ID');
    this.observations.set(requestId,{owner,epoch,stopped:false,readbackSha:null});
  }
  // These test methods emulate an *external* writer completion/readback.
  // They do not make a real high-token/OS-backed/source-storage attestation.
  writerStopped(requestId:string){this.observations.get(requestId)!.stopped=true;}
  readback(requestId:string,digest:string){
    this.observations.get(requestId)!.readbackSha=digest;
  }
  issue(owner:Tenant,requestId:string,epoch:number,expectedSha:string):object|null{
    const o=this.observations.get(requestId);
    if(!o||o.owner!==owner||o.epoch!==epoch||!o.stopped||
      o.readbackSha!==expectedSha)return null;
    const token=Object.freeze({});
    this.issued.set(token,{owner,requestId,epoch,durableReadbackSha:expectedSha,
      source:'STAGED_WITNESS_SIMULATOR'});
    return token;
  }
  verify(token:object,owner:Tenant,requestId:string,epoch:number,sha:string){
    const o=this.issued.get(token),current=this.observations.get(requestId);
    return !!o&&!!current&&o.owner===owner&&o.requestId===requestId&&
      o.epoch===epoch&&o.durableReadbackSha===sha&&
      current.owner===owner&&current.epoch===epoch&&current.stopped&&
      current.readbackSha===sha;
  }
}
class TestOnlyTenantMemory {
  private readonly leases=new Map<string,Lease>();
  constructor(private readonly witness:TestOnlyWriterWitness){}
  used(owner:Tenant){
    return [...this.leases.values()].filter(x=>x.owner===owner&&x.state!=='RELEASED')
      .reduce((sum,x)=>sum+x.bytes,0);
  }
  reserve(owner:Tenant,requestId:string,epoch:number,bytes:number){
    assert.ok(Number.isSafeInteger(epoch)&&epoch>=1);
    assert.ok(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=CHUNK);
    const prior=this.leases.get(requestId);
    if(prior)return prior.owner===owner&&prior.epoch===epoch&&prior.bytes===bytes
      ?'DUPLICATE':'COLLISION';
    if(this.used(owner)+bytes>MAX_OWNER_BYTES)return 'THROTTLED';
    this.leases.set(requestId,{owner,requestId,epoch,bytes,state:'INFLIGHT'});
    this.witness.arm(owner,requestId,epoch);
    return 'RESERVED';
  }
  cancel(owner:Tenant,requestId:string,epoch:number){
    const x=this.leases.get(requestId);
    if(!x||x.owner!==owner||x.epoch!==epoch)return 'DENIED_SCOPE';
    if(x.state==='RELEASED')return 'ALREADY_RELEASED';
    if(x.state==='INFLIGHT')x.state='CANCEL_PENDING';
    return 'CANCEL_PENDING';
  }
  lostAck(owner:Tenant,requestId:string,epoch:number){
    const x=this.leases.get(requestId);
    if(!x||x.owner!==owner||x.epoch!==epoch||x.state==='RELEASED')
      return 'DENIED_SCOPE';
    x.state='MUTATION_UNKNOWN';return 'MUTATION_UNKNOWN';
  }
  release(owner:Tenant,requestId:string,epoch:number,sha:string,proof:object){
    const x=this.leases.get(requestId);
    if(!x||x.owner!==owner||x.epoch!==epoch)return 'DENIED_SCOPE';
    if(x.state==='RELEASED')return 'ALREADY_RELEASED';
    if(x.state==='INFLIGHT')return 'WRITER_STILL_ACTIVE';
    if(!this.witness.verify(proof,owner,requestId,epoch,sha))
      return 'INDEPENDENT_PROOF_REQUIRED';
    x.state='RELEASED';return 'RELEASED';
  }
}
function dbFixture(){
  const db=new DatabaseSync(':memory:');
  initArtifactBudgetFixture(db);
  return {db,staging:new StagingArtifactByteBudget(db)};
}
function begin(owner:Tenant,id:string){
  return {ownerId:owner,deviceId:'device-'+owner,projectId:'project-worker30',
    sessionId:'session-'+id,rootInvocationId:'root-'+id,sizeBytes:CHUNK*2,
    sourceSha256:SHA,physicalFreeBytes:8*1024**3,now:NOW};
}
function stage(owner:Tenant,id:string,requestId:string){
  return {ownerId:owner,deviceId:'device-'+owner,projectId:'project-worker30',
    sessionId:'session-'+id,requestId,offsetBytes:0,
    byteCount:CHUNK,chunkSha256:SHA,now:NOW};
}

test('QA30 pending SQLite receipt keeps tenant memory charged after cancel, lost ACK, re-pair',
  ()=>{
    const {db,staging}=dbFixture();
    const witness=new TestOnlyWriterWitness();
    const ledger=new TestOnlyTenantMemory(witness);
    try{
      assert.equal(staging.begin(begin(A,'a')),'RESERVED');
      assert.equal(staging.begin(begin(B,'b')),'RESERVED');
      assert.equal(staging.stageChunk(stage(A,'a','request30-a-1')),'CHUNK_PENDING');
      assert.equal(staging.stageChunk(stage(B,'b','request30-b-1')),'CHUNK_PENDING');
      assert.equal(ledger.reserve(A,'request30-a-1',12,CHUNK),'RESERVED');
      assert.equal(ledger.reserve(A,'request30-a-2',12,CHUNK),'RESERVED');
      assert.equal(ledger.reserve(A,'request30-a-3',12,CHUNK),'THROTTLED');
      assert.equal(ledger.reserve(B,'request30-b-1',21,CHUNK),'RESERVED');
      assert.equal(ledger.used(A),MAX_OWNER_BYTES);
      assert.equal(ledger.used(B),CHUNK);
      assert.equal(ledger.cancel(A,'request30-a-1',12),'CANCEL_PENDING');
      assert.equal(ledger.lostAck(A,'request30-a-1',12),'MUTATION_UNKNOWN');
      assert.equal(ledger.reserve(A,'request30-a-3',12,CHUNK),'THROTTLED');
      assert.equal(ledger.release(A,'request30-a-1',12,SHA,Object.freeze({
        stopped:true,postconditionVerified:true,
      })),'INDEPENDENT_PROOF_REQUIRED');
      assert.equal(ledger.release(B,'request30-a-1',12,SHA,{}),'DENIED_SCOPE');
      assert.equal(ledger.release(A,'request30-a-1',11,SHA,{}),'DENIED_SCOPE');

      witness.readback('request30-a-1',SHA);
      assert.equal(witness.issue(A,'request30-a-1',12,SHA),null,
        'digest alone cannot release a writer that may still mutate');
      witness.writerStopped('request30-a-1');
      const stale=witness.issue(A,'request30-a-1',11,SHA);
      assert.equal(stale,null,'old pairing/epoch proof cannot release memory');
      const wrongSha=witness.issue(A,'request30-a-1',12,OTHER);
      assert.equal(wrongSha,null);
      const authoritativeFixtureToken=witness.issue(A,'request30-a-1',12,SHA);
      assert.ok(authoritativeFixtureToken);
      assert.equal(ledger.release(A,'request30-a-1',12,SHA,
        authoritativeFixtureToken),'RELEASED');
      assert.equal(ledger.release(A,'request30-a-1',12,SHA,
        authoritativeFixtureToken),'ALREADY_RELEASED');
      assert.equal(ledger.used(A),CHUNK);
      assert.equal(ledger.reserve(A,'request30-a-3',12,CHUNK),'RESERVED');
      assert.equal(ledger.reserve(A,'request30-a-3',12,CHUNK),'DUPLICATE');
      assert.equal(ledger.used(A),MAX_OWNER_BYTES);
      assert.equal(ledger.used(B),CHUNK);
      // Critical: storage admission is separately source-bound and cannot
      // be "freed" because the test-only memory ledger released its slot.
      const pending=(db.prepare(
        "SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"
      ).get() as {n:number}).n;
      assert.equal(pending,2,'no phantom durable receipt or byte credit');
      const storage=(db.prepare(
        "SELECT SUM(size_bytes) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
      ).get() as {n:number}).n;
      assert.equal(storage,4*CHUNK);
      process.stdout.write('QA30_PENDING_MEMORY '+JSON.stringify({
        parserSourceSha:'cf58e6882e44968698f3f548b353287ba1698747',
        parentQaSha:'554528df1dd2be0c265571ac8a1233fade78da13',
        workflowCheckoutSha:process.env.GITHUB_SHA??null,
        classification:'TEST_ONLY_INDEPENDENT_WITNESS_SIMULATOR_PLUS_REAL_STAGING_SQLITE',
        ownerMemoryBudgetBytes:MAX_OWNER_BYTES,tenantAUsed:ledger.used(A),
        tenantBUsed:ledger.used(B),pendingDurableChunks:pending,
        storageStillReservedBytes:storage,realWriterWitness:false,
        nativeCompletion:0,paidCloudflare:null,
      })+'\n');
    }finally{db.close();}
  });

test('QA30 pending witness cannot be replayed for foreign tenant, changed epoch or absent readback',
  ()=>{
    const witness=new TestOnlyWriterWitness();
    const ledger=new TestOnlyTenantMemory(witness);
    assert.equal(ledger.reserve(B,'request30-quiet-pending',5,CHUNK),'RESERVED');
    assert.equal(ledger.cancel(B,'request30-quiet-pending',5),'CANCEL_PENDING');
    assert.equal(ledger.lostAck(B,'request30-quiet-pending',5),'MUTATION_UNKNOWN');
    witness.writerStopped('request30-quiet-pending');
    assert.equal(witness.issue(B,'request30-quiet-pending',5,SHA),null,
      'no independent postcondition receipt');
    witness.readback('request30-quiet-pending',OTHER);
    assert.equal(witness.issue(B,'request30-quiet-pending',5,SHA),null,
      'postcondition digest mismatch');
    witness.readback('request30-quiet-pending',SHA);
    assert.equal(witness.issue(A,'request30-quiet-pending',5,SHA),null,
      'foreign owner');
    assert.equal(witness.issue(B,'request30-quiet-pending',6,SHA),null,
      'stale owner epoch after re-pair');
    assert.equal(ledger.used(B),CHUNK,'unknown outcome still charged');
    assert.equal(ledger.reserve(B,'request30-quiet-other',5,CHUNK),'RESERVED');
    assert.equal(ledger.reserve(B,'request30-quiet-third',5,CHUNK),'THROTTLED');
  });
