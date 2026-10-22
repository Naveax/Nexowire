/**
 * Worker #30 QA-only P1 #780: bounded per-task agent-loop admission and
 * strict-share small-request fairness with one UNKNOWN native transfer.
 * Uses real proposed S5 strict-share + real staging SQLite byte reservations;
 * TaskBudgetFence is TEST-ONLY, not a deployed worker, admission provider,
 * native writer-stop, billing policy or physical OS memory guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';
import {StagingArtifactByteBudget,initArtifactBudgetFixture,ARTIFACT_CHUNK_BYTES}
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';

const SOURCE_774='5e432c26072d82e89069fc702e634a80d2d02534';
const ISSUE_780=780;
const SEED=0x30ca5e21;
const NOW=new Date('2026-10-22T16:00:00.000Z');
const REQUEST_SHA=createHash('sha256').update('qa30-780-fixed-read-only').digest('hex');
const CHUNK_SHA=createHash('sha256').update('qa30-780-unknown-native').digest('hex');
const OWNER_NOISY='qa30-loop-noisy-owner',OWNER_QUIET='qa30-loop-quiet-owner';
type Owner=typeof OWNER_NOISY|typeof OWNER_QUIET;
const CHUNK=ARTIFACT_CHUNK_BYTES;
type Limits=Readonly<{steps:number;elapsedMs:number;tokens:number;
  memoryBytes:number;transferBytes:number}>;
const POLICY:Limits=Object.freeze({
  steps:16,elapsedMs:60_000,tokens:64,
  memoryBytes:2*CHUNK,transferBytes:2*CHUNK,
});
type Entry={owner:Owner;taskId:string;requestId:string;ownerEpoch:number;
  memoryBytes:number;transferBytes:number;state:'INFLIGHT'|'UNKNOWN'|'READ_ONLY_DONE'};
type Counters={steps:number;tokens:number;bornAtMs:number};
class TestOnlyTaskBudgetFence {
  private readonly tasks=new Map<string,Counters>();
  private readonly entries=new Map<string,Entry>();
  private readonly epochs=new Map<Owner,number>([[OWNER_NOISY,5],[OWNER_QUIET,8]]);
  private readonly seen=new Map<string,{owner:Owner;taskId:string;requestSha:string}>();
  constructor(private readonly limits:Limits=POLICY){}
  ownerMemory(owner:Owner){
    return [...this.entries.values()]
      .filter(e=>e.owner===owner&&e.state!=='READ_ONLY_DONE')
      .reduce((sum,e)=>sum+e.memoryBytes,0);
  }
  ownerTransfer(owner:Owner){
    return [...this.entries.values()]
      .filter(e=>e.owner===owner&&e.state!=='READ_ONLY_DONE')
      .reduce((sum,e)=>sum+e.transferBytes,0);
  }
  taskCounters(taskId:string){const c=this.tasks.get(taskId);
    return c?{...c}:undefined;}
  admit(owner:Owner,taskId:string,requestId:string,requestSha:string,
    nowMs:number,usage:{tokens:number;memoryBytes:number;transferBytes:number}){
    if(!Number.isSafeInteger(nowMs)||!Object.values(usage).every(
      n=>Number.isSafeInteger(n)&&n>=0))return 'INVALID_DIMENSION';
    const previous=this.seen.get(requestId);
    if(previous)return previous.owner===owner&&previous.taskId===taskId&&
      previous.requestSha===requestSha?'DUPLICATE':'COLLISION';
    const c=this.tasks.get(taskId)??{steps:0,tokens:0,bornAtMs:nowMs};
    if(nowMs<c.bornAtMs||nowMs-c.bornAtMs>=this.limits.elapsedMs)
      return 'TIME_BUDGET_EXHAUSTED';
    if(c.steps+1>this.limits.steps)return 'STEPS_EXHAUSTED';
    if(c.tokens+usage.tokens>this.limits.tokens)return 'TOKEN_BUDGET_EXHAUSTED';
    if(this.ownerMemory(owner)+usage.memoryBytes>this.limits.memoryBytes)
      return 'MEMORY_BUDGET_EXHAUSTED';
    if(this.ownerTransfer(owner)+usage.transferBytes>this.limits.transferBytes)
      return 'TRANSFER_BUDGET_EXHAUSTED';
    const hasUnresolvedUnknown=[...this.entries.values()].some(e=>
      e.taskId===taskId&&e.state==='UNKNOWN');
    if(hasUnresolvedUnknown)return 'RECONCILE_REQUIRED';
    this.tasks.set(taskId,{...c,steps:c.steps+1,tokens:c.tokens+usage.tokens});
    this.seen.set(requestId,{owner,taskId,requestSha});
    this.entries.set(requestId,{
      owner,taskId,requestId,ownerEpoch:this.epochs.get(owner)!,
      memoryBytes:usage.memoryBytes,transferBytes:usage.transferBytes,
      state:'INFLIGHT',
    });
    return 'RESERVED';
  }
  finishReadOnly(owner:Owner,id:string){
    const e=this.entries.get(id);
    if(!e||e.owner!==owner||e.state!=='INFLIGHT'||
      e.memoryBytes!==0||e.transferBytes!==0)
      return 'READ_ONLY_COMPLETION_UNPROVEN';
    e.state='READ_ONLY_DONE';return 'READ_ONLY_DONE';
  }
  markUnknown(owner:Owner,id:string){
    const e=this.entries.get(id);
    if(!e||e.owner!==owner||e.state!=='INFLIGHT')return 'SCOPE_DENIED';
    e.state='UNKNOWN';return 'MUTATION_UNKNOWN';
  }
  rePair(owner:Owner){this.epochs.set(owner,this.epochs.get(owner)!+1);}
  // No physical writer-stop+deletion authority is injected into this QA
  // reference. Caller-controlled "signed-looking" booleans MUST NOT refund.
  attemptNativeRelease(owner:Owner,id:string,epoch:number,_untrusted:object){
    const e=this.entries.get(id);
    if(!e||e.owner!==owner)return 'SCOPE_DENIED';
    if(epoch!==e.ownerEpoch||epoch!==this.epochs.get(owner))
      return 'STALE_OWNER_EPOCH';
    return 'INDEPENDENT_STOP_DELETE_READBACK_REQUIRED';
  }
}
function seededShuffle<T>(items:readonly T[],seed:number):T[]{
  const result=[...items];let x=seed>>>0;
  for(let i=result.length-1;i>0;i--){
    x^=x<<13;x^=x>>>17;x^=x<<5;
    const j=(x>>>0)%(i+1);
    [result[i],result[j]]=[result[j]!,result[i]!];
  }
  return result;
}
test('QA30 #780 fixed-seed 48 noisy + 16 quiet tiny jobs get protected share without UNKNOWN replay',
  ()=>{
    const db=new DatabaseSync(':memory:');
    try{
      db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
      const strict=new ProposedS5ProtectedTenantAdmission(db,{
        scope:'qa30-agent-loop-p1',globalRollingMinuteLimit:32,
        tenants:[{tenantId:OWNER_NOISY,weight:1},
          {tenantId:OWNER_QUIET,weight:1}],
      });
      const budget=new TestOnlyTaskBudgetFence();
      const jobs=seededShuffle([
        ...Array.from({length:48},(_,i)=>({
          owner:OWNER_NOISY as Owner,
          taskId:'noisy-task-'+String(i%3),
          id:'qa30-loop-noisy-'+String(i).padStart(3,'0'),
        })),
        ...Array.from({length:16},(_,i)=>({
          owner:OWNER_QUIET as Owner,
          taskId:'quiet-task-0',
          id:'qa30-loop-quiet-'+String(i).padStart(3,'0'),
        })),
      ],SEED);
      let acceptedNoisy=0,acceptedQuiet=0,deniedNoisy=0;
      for(const j of jobs){
        const admission=strict.observe(j.owner,j.id,REQUEST_SHA,NOW);
        assert.equal(admission.authorizesToolExecution,false);
        if(admission.status==='reserved'){
          assert.equal(budget.admit(j.owner,j.taskId,j.id,REQUEST_SHA,
            NOW.getTime(),{tokens:3,memoryBytes:0,transferBytes:0}),'RESERVED');
          assert.equal(budget.finishReadOnly(j.owner,j.id),'READ_ONLY_DONE');
          if(j.owner===OWNER_QUIET)acceptedQuiet++;else acceptedNoisy++;
        }else{
          assert.equal(j.owner,OWNER_NOISY);
          assert.equal(admission.status,'tenant-exhausted');
          deniedNoisy++;
        }
      }
      assert.deepEqual({acceptedNoisy,acceptedQuiet,deniedNoisy},{
        acceptedNoisy:16,acceptedQuiet:16,deniedNoisy:32,
      });
      const current=db.prepare(
        'SELECT COUNT(*) AS n FROM s5_fair_window'
      ).get() as {n:number};
      assert.equal(current.n,32);
      assert.equal(budget.taskCounters('quiet-task-0')?.steps,16);
      assert.equal(budget.taskCounters('quiet-task-0')?.tokens,48);
      assert.equal(budget.ownerMemory(OWNER_NOISY),0);
      assert.equal(budget.ownerMemory(OWNER_QUIET),0);
      process.stdout.write('QA30_P1_FAIRNESS '+JSON.stringify({
        parent774:SOURCE_774,issue:ISSUE_780,seed:SEED,
        checkoutSha:process.env.GITHUB_SHA??null,
        totalTinyAttempts:64,quietTinyAccepted:acceptedQuiet,
        noisyTinyAccepted:acceptedNoisy,noisyDenied:deniedNoisy,
        protectedShareEach:16,workers:'fixed-seed logical events only',
        physicalLatencyMs:null,physicalWss:0,
        sourceAllocator:'proposed S5 strict-share SQLite',
        sourceAgentLoopIntegrated:false,production:'NO_GO',
      })+'\n');
    }finally{db.close();}
  });

test('QA30 #780 task step/time/token/memory/transfer budgets retain native UNKNOWN over revoke and re-pair',
  ()=>{
    const db=new DatabaseSync(':memory:');
    initArtifactBudgetFixture(db);
    try{
      const stage=new StagingArtifactByteBudget(db);
      const budget=new TestOnlyTaskBudgetFence();
      for(const [owner,suffix] of [[OWNER_NOISY,'noisy'],[OWNER_QUIET,'quiet']] as const){
        assert.equal(stage.begin({
          ownerId:owner,deviceId:'device-'+suffix,
          projectId:'qa30-loop-project',sessionId:'session-qa30-'+suffix,
          rootInvocationId:'root-qa30-'+suffix,
          sizeBytes:2*CHUNK,sourceSha256:CHUNK_SHA,
          physicalFreeBytes:8*1024**3,now:NOW,
        }),'RESERVED');
      }
      const task='noisy-native-unknown-task',id='native30-pending-request';
      assert.equal(budget.admit(OWNER_NOISY,task,id,CHUNK_SHA,
        NOW.getTime(),{tokens:8,memoryBytes:CHUNK,transferBytes:CHUNK}),'RESERVED');
      assert.equal(stage.stageChunk({
        ownerId:OWNER_NOISY,deviceId:'device-noisy',
        projectId:'qa30-loop-project',sessionId:'session-qa30-noisy',
        requestId:id,offsetBytes:0,byteCount:CHUNK,
        chunkSha256:CHUNK_SHA,now:NOW,
      }),'CHUNK_PENDING');
      assert.equal(stage.requestCancel({
        ownerId:OWNER_NOISY,deviceId:'device-noisy',
        projectId:'qa30-loop-project',sessionId:'session-qa30-noisy',
        expectedOffsetBytes:0,
      }),'CANCEL_PENDING');
      assert.equal(budget.markUnknown(OWNER_NOISY,id),'MUTATION_UNKNOWN');
      assert.equal(budget.admit(OWNER_NOISY,task,'native30-next',CHUNK_SHA,
        NOW.getTime()+1,{tokens:1,memoryBytes:0,transferBytes:0}),
        'RECONCILE_REQUIRED');
      assert.equal(budget.admit(OWNER_NOISY,task,id,CHUNK_SHA,
        NOW.getTime()+1,{tokens:8,memoryBytes:CHUNK,transferBytes:CHUNK}),
        'DUPLICATE');
      assert.equal(budget.attemptNativeRelease(OWNER_NOISY,id,5,
        Object.freeze({writerStopped:true,deleted:true,signed:true})),
        'INDEPENDENT_STOP_DELETE_READBACK_REQUIRED');
      assert.equal(budget.ownerMemory(OWNER_NOISY),CHUNK);
      assert.equal(budget.ownerTransfer(OWNER_NOISY),CHUNK);
      budget.rePair(OWNER_NOISY);
      assert.equal(budget.attemptNativeRelease(OWNER_NOISY,id,5,{}),
        'STALE_OWNER_EPOCH');
      assert.equal(budget.attemptNativeRelease(OWNER_NOISY,id,6,{}),
        'STALE_OWNER_EPOCH');
      assert.equal(budget.ownerMemory(OWNER_NOISY),CHUNK);
      assert.equal(budget.ownerTransfer(OWNER_NOISY),CHUNK);
      const newTask='noisy-different-task';
      assert.equal(budget.admit(OWNER_NOISY,newTask,'native30-other',CHUNK_SHA,
        NOW.getTime()+1,{tokens:2,memoryBytes:CHUNK,transferBytes:CHUNK}),
        'RESERVED');
      assert.equal(budget.admit(OWNER_NOISY,newTask,'native30-overbudget',CHUNK_SHA,
        NOW.getTime()+2,{tokens:2,memoryBytes:CHUNK,transferBytes:CHUNK}),
        'MEMORY_BUDGET_EXHAUSTED');
      assert.equal(budget.ownerMemory(OWNER_NOISY),2*CHUNK);
      assert.equal(budget.ownerTransfer(OWNER_NOISY),2*CHUNK);
      assert.equal(budget.admit(OWNER_QUIET,'quiet-independent','quiet30-read',REQUEST_SHA,
        NOW.getTime()+2,{tokens:4,memoryBytes:0,transferBytes:0}),'RESERVED');
      assert.equal(budget.finishReadOnly(OWNER_QUIET,'quiet30-read'),'READ_ONLY_DONE');
      // Independent dimensional rejection cases use a new test-only ledger.
      const dimensions=new TestOnlyTaskBudgetFence({
        steps:2,elapsedMs:10,tokens:4,memoryBytes:2*CHUNK,transferBytes:2*CHUNK,
      });
      assert.equal(dimensions.admit(OWNER_QUIET,'bounded-task','step-1',REQUEST_SHA,
        NOW.getTime(),{tokens:2,memoryBytes:0,transferBytes:0}),'RESERVED');
      assert.equal(dimensions.finishReadOnly(OWNER_QUIET,'step-1'),'READ_ONLY_DONE');
      assert.equal(dimensions.admit(OWNER_QUIET,'bounded-task','over-tokens',REQUEST_SHA,
        NOW.getTime()+1,{tokens:3,memoryBytes:0,transferBytes:0}),
        'TOKEN_BUDGET_EXHAUSTED');
      assert.equal(dimensions.admit(OWNER_QUIET,'bounded-task','step-2',REQUEST_SHA,
        NOW.getTime()+2,{tokens:2,memoryBytes:0,transferBytes:0}),'RESERVED');
      assert.equal(dimensions.finishReadOnly(OWNER_QUIET,'step-2'),'READ_ONLY_DONE');
      assert.equal(dimensions.admit(OWNER_QUIET,'bounded-task','over-steps',REQUEST_SHA,
        NOW.getTime()+3,{tokens:0,memoryBytes:0,transferBytes:0}),
        'STEPS_EXHAUSTED');
      assert.equal(dimensions.admit(OWNER_QUIET,'bounded-task','over-time',REQUEST_SHA,
        NOW.getTime()+10,{tokens:0,memoryBytes:0,transferBytes:0}),
        'TIME_BUDGET_EXHAUSTED');
      const transferOnly=new TestOnlyTaskBudgetFence({
        steps:4,elapsedMs:1000,tokens:8,
        memoryBytes:4*CHUNK,transferBytes:CHUNK,
      });
      assert.equal(transferOnly.admit(OWNER_NOISY,'transfer-task','xfer-1',CHUNK_SHA,
        NOW.getTime(),{tokens:1,memoryBytes:CHUNK,transferBytes:CHUNK}),
        'RESERVED');
      assert.equal(transferOnly.admit(OWNER_NOISY,'transfer-task','xfer-2',CHUNK_SHA,
        NOW.getTime()+1,{tokens:1,memoryBytes:CHUNK,transferBytes:CHUNK}),
        'TRANSFER_BUDGET_EXHAUSTED');
      const pending=(db.prepare(
        "SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"
      ).get() as {n:number}).n;
      const reserved=(db.prepare(
        "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"
      ).get() as {n:number}).n;
      assert.equal(pending,1);
      assert.equal(reserved,4*CHUNK);
      process.stdout.write('QA30_P1_UNKNOWN_BUDGET '+JSON.stringify({
        parent774:SOURCE_774,issue:ISSUE_780,
        checkoutSha:process.env.GITHUB_SHA??null,
        taskLimits:POLICY,rejections:{
          unknown:'RECONCILE_REQUIRED',
          steps:'STEPS_EXHAUSTED',time:'TIME_BUDGET_EXHAUSTED',
          tokens:'TOKEN_BUDGET_EXHAUSTED',memory:'MEMORY_BUDGET_EXHAUSTED',
          transfer:'TRANSFER_BUDGET_EXHAUSTED',
        },pendingNativeChunks:pending,stagingBytesStillReserved:reserved,
        noisyMemoryHeld:budget.ownerMemory(OWNER_NOISY),
        noisyTransferHeld:budget.ownerTransfer(OWNER_NOISY),
        quietReadOnlyAccepted:true,
        independentSignedStopDelete:false,physicalReclamationVerified:false,
        realAgentLoopInstalled:false,paidCloudflareCost:null,
        publicWss:0,oneGiBFileTransfers:0,production:'NO_GO',
      })+'\n');
    }finally{db.close();}
  });
