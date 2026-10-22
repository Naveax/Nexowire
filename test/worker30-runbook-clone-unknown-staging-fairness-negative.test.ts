/**
 * Worker #30 / #780 independent hostile NEGATIVE against the EXISTING
 * executeDurableRunbook -> callback boundary and actual staging byte ledger.
 *
 * #781 proved a cloned runbook can redispatch after a lost Native ACK.
 * This one new test adds a missing source-backed consequence: the clone can
 * reserve a SECOND independent staging session while the first remains
 * CANCEL_PENDING with a PENDING chunk. A strict-share SQLite allocator keeps
 * an unrelated quiet tenant's tiny logical requests eligible.
 *
 * All Native mutation effects are TEST-ONLY counters. This test PASS means
 * the SOURCE GAP was reproduced; it NEVER means clone/replay is safe.
 * No deployed P1 agent-worker admission, external CAS, OS writer-stop, live
 * Cloudflare, Agent, VM, WSS or billing is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';
import {
  ARTIFACT_CHUNK_BYTES,
  initArtifactBudgetFixture,
  StagingArtifactByteBudget,
  type ArtifactBudgetPolicy,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const ISSUE_781='89a865363829c8c30a74de1516e53a697549c05b';
const QA_784='b49dc57b03df146c56e09032c8e3eff07d01e2a9';
const QUOTA_718='81931c5f3d9a0995b621bd3c678ab0854876e26d';
const SEED=0x30ca5e21;
const CHUNK=ARTIFACT_CHUNK_BYTES;
const NOISY='qa30-clone-noisy-owner',QUIET='qa30-clone-quiet-owner';
const DEVICE='qa30-clone-device';
const PROJECT='qa30-clone-project';
const NOW=new Date('2026-10-22T17:00:00.000Z');
const chunkBytes=Buffer.alloc(CHUNK,7);
const chunkSha=createHash('sha256').update(chunkBytes).digest('hex');
const readOnlySha=createHash('sha256').update('qa30-cloned-runbook-readonly').digest('hex');
const stagedPolicy:ArtifactBudgetPolicy={
  globalMinuteBytes:8*CHUNK,
  ownerMinuteBytes:2*CHUNK,
  globalStorageBytes:8*CHUNK,
  ownerStorageBytes:2*CHUNK,
  minFreeDiskBytes:CHUNK,
  maxConcurrentGlobal:8,
  maxConcurrentPerOwner:2,
};
function seededShuffle<T>(xs:readonly T[],seed:number):T[]{
  const result=[...xs];let s=seed>>>0;
  for(let i=result.length-1;i>0;i--){
    s^=s<<13;s^=s>>>17;s^=s<<5;
    const j=(s>>>0)%(i+1);
    [result[i],result[j]]=[result[j]!,result[i]!];
  }
  return result;
}
test('QA30 RED-SOURCE: cloned UNKNOWN runbook double-reserves staging, quiet strict-share remains isolated',
  {timeout:30000},async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'qa30-runbook-escrow-'));
    t.after(()=>rm(root,{force:true,recursive:true}));
    const db=new DatabaseSync(':memory:');
    t.after(()=>db.close());
    initArtifactBudgetFixture(db);
    db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
    const quota=new StagingArtifactByteBudget(db,stagedPolicy);
    const fair=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'qa30-runbook-clone-share',
      globalRollingMinuteLimit:8,
      tenants:[{tenantId:NOISY,weight:1},{tenantId:QUIET,weight:1}],
    });
    const stateFile=path.join(root,'qa30-disposable-runbooks.json');
    const store=new RunbookStore({stateFile});
    await store.initialize();
    const steps=[{
      id:'semantic-effect-same-step',
      kind:'task_graph' as const,
      task_graph:{jobs:[{id:'same-logical-effect',kind:'NO_NATIVE_OS_IO'}]},
    }];
    const semanticSha=createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    const sourceSessionIds:string[]=[];
    const nestedGraphIds:string[]=[];
    let simulatedDispatches=0;
    let syntheticEpoch=7;
    let independentReadbacks=0;
    const callbacks={
      runTaskGraph:async(input:unknown)=>{
        const nested=input as Record<string,unknown>;
        const graph=String(nested.graph_id);
        const suffix=createHash('sha256').update(graph).digest('hex').slice(0,16);
        const sessionId='session-qa30-'+suffix;
        const requestId='request-qa30-'+suffix;
        assert.ok(!sourceSessionIds.includes(sessionId));
        assert.equal(quota.begin({
          ownerId:NOISY,deviceId:DEVICE,projectId:PROJECT,
          sessionId,rootInvocationId:'root-qa30-'+suffix,
          sizeBytes:CHUNK,sourceSha256:chunkSha,
          physicalFreeBytes:16*CHUNK,now:NOW,
        }),'RESERVED','source accepts cloned task as independent file session');
        assert.equal(quota.stageChunk({
          ownerId:NOISY,deviceId:DEVICE,projectId:PROJECT,
          sessionId,requestId,offsetBytes:0,byteCount:CHUNK,
          chunkSha256:chunkSha,now:NOW,
        }),'CHUNK_PENDING');
        sourceSessionIds.push(sessionId);
        nestedGraphIds.push(graph);
        simulatedDispatches++;
        if(simulatedDispatches===1)
          throw Object.assign(new Error('synthetic Native effect sent, ACK lost'),{
            code:'MUTATION_STATE_UNKNOWN',
          });
        return {data:{ok:true,graphId:graph,
          summary:{total:1,succeeded:1,failed:0}}};
      },
      runAssertions:async()=>({data:{ok:true,passed:1,failed:0,skipped:0}}),
    };
    const first=await executeDurableRunbook({
      runbook_id:'qa30-original-clone-test',steps,
    },store,callbacks) as {data:{
      summary:{failed:number;unknown:number};
      steps:Array<{status:string;errorCode?:string}>;
    }};
    assert.equal(simulatedDispatches,1);
    assert.equal(first.data.steps[0]?.errorCode,'MUTATION_STATE_UNKNOWN');
    assert.equal(first.data.steps[0]?.status,'failed',
      'existing source incorrectly classifies lost Native ACK as FAILED');
    assert.deepEqual(first.data.summary,{failed:1,unknown:0});
    assert.equal(quota.requestCancel({
      ownerId:NOISY,deviceId:DEVICE,projectId:PROJECT,
      sessionId:sourceSessionIds[0]!,expectedOffsetBytes:0,
    }),'CANCEL_PENDING');
    assert.throws(()=>quota.acknowledgeDeletion({
      ownerId:NOISY,deviceId:DEVICE,projectId:PROJECT,
      sessionId:sourceSessionIds[0]!,durableDeletionVerified:true,
    }),/WRITER_FENCE_REQUIRED/,
    'actual staging source must not refund CANCEL_PENDING without stopped writer');

    const restarted=new RunbookStore({stateFile});
    await restarted.initialize();
    assert.equal(restarted.get('qa30-original-clone-test').steps[0]?.status,'failed');
    syntheticEpoch++;
    assert.equal(syntheticEpoch,8);
    const cloned=await executeDurableRunbook({
      runbook_id:'qa30-new-id-same-effect',steps,
      resume:false,retry_unknown:false,retry_failed:false,
    },restarted,callbacks) as {data:{ok:boolean;summary:{succeeded:number}}};
    assert.equal(cloned.data.ok,true,'unsafe clone bypass reproduced, not approved');
    assert.equal(cloned.data.summary.succeeded,1);
    assert.equal(simulatedDispatches,2);
    assert.notEqual(nestedGraphIds[0],nestedGraphIds[1],
      'actual runbook IDs produce different nested graph IDs');
    assert.equal(independentReadbacks,0,
      'runbook API has no authoritative prior mutation readback');
    assert.equal(restarted.get('qa30-original-clone-test').steps[0]?.status,'failed');
    assert.equal(quota.begin({
      ownerId:NOISY,deviceId:DEVICE,projectId:PROJECT,
      sessionId:'session-qa30-third',
      rootInvocationId:'root-qa30-third',
      sizeBytes:CHUNK,sourceSha256:chunkSha,
      physicalFreeBytes:16*CHUNK,now:NOW,
    }),'DENIED_CAPACITY',
    'two separate cloned reservations saturate noisy owner storage budget');

    // A distinct quiet tenant still receives its protected strict share.
    const jobs=seededShuffle([
      ...Array.from({length:12},(_,i)=>({
        tenant:NOISY,id:'qa30-clone-noisy-'+String(i).padStart(3,'0'),
      })),
      ...Array.from({length:4},(_,i)=>({
        tenant:QUIET,id:'qa30-clone-quiet-'+String(i).padStart(3,'0'),
      })),
    ],SEED);
    let noisyAdmit=0,quietAdmit=0,noisyDeny=0;
    for(const j of jobs){
      const decision=fair.observe(j.tenant,j.id,readOnlySha,NOW);
      assert.equal(decision.authorizesToolExecution,false);
      if(decision.status==='reserved'){
        if(j.tenant===NOISY)noisyAdmit++;else quietAdmit++;
      }else{
        assert.equal(j.tenant,NOISY);
        assert.equal(decision.status,'tenant-exhausted');
        noisyDeny++;
      }
    }
    assert.deepEqual({noisyAdmit,quietAdmit,noisyDeny},{
      noisyAdmit:4,quietAdmit:4,noisyDeny:8,
    });
    const quiet=await executeDurableRunbook({
      runbook_id:'qa30-quiet-read-only-runbook',
      steps:[{id:'quiet-check',kind:'assertions',assertions:{check:'READ_ONLY'}}],
    },restarted,callbacks) as {data:{
      ok:boolean,summary:{succeeded:number},
    }};
    assert.equal(quiet.data.ok,true);
    assert.equal(quiet.data.summary.succeeded,1);
    assert.equal(simulatedDispatches,2);

    const pending=(db.prepare(
      "SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"
    ).get() as {n:number}).n;
    const noisyReserved=(db.prepare(
      "SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE owner_id=? AND state<>'RELEASED'"
    ).get(NOISY) as {n:number}).n;
    const cancelled=(db.prepare(
      "SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='CANCEL_PENDING'"
    ).get() as {n:number}).n;
    assert.deepEqual({pending,noisyReserved,cancelled},{
      pending:2,noisyReserved:2*CHUNK,cancelled:1,
    });
    process.stdout.write('QA30_CLONED_UNKNOWN_DOUBLE_ESCROW_NEGATIVE '+JSON.stringify({
      source781:ISSUE_781,qa784:QA_784,quotaOwner718:QUOTA_718,
      branchCheckoutSha:process.env.GITHUB_SHA??null,
      semanticPlanSha:semanticSha,seed:SEED,
      sourceRunbookStatusAfterAckLoss:'FAILED_NOT_UNKNOWN',
      clonedRunbookUnsafeRedispatches:simulatedDispatches,
      distinctDerivedGraphIds:nestedGraphIds.length,
      currentEpochInSyntheticObserver:syntheticEpoch,
      independentAuthorityReadbacks:independentReadbacks,
      sourceStagingPendingChunks:pending,sourceNoisyStorageHeldBytes:noisyReserved,
      sourceCancelledSessionsHeld:cancelled,
      quietLogicalAccepted:quietAdmit,noisyLogicalAccepted:noisyAdmit,
      noisyLogicalDenied:noisyDeny,quietReadOnlyRunbookSucceeded:quiet.data.ok,
      realNativeEffects:0,productionWorkerIntegrated:false,
      externalSignedStopDeletion:false,cloudflareCost:null,
      physicalWssConnections:0,physicalGiBTransfers:0,
      disposition:'EXPECTED_UNSAFE_SOURCE_GAP_NOT_PRODUCTION_PASS',
    })+'\n');
  });
