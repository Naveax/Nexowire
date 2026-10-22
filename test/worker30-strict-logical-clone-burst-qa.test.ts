/**
 * #30 owner-scoped QA: real #718 strict beginForLogicalMutation admission
 * versus a seeded burst of cloned runbook/session/root IDs.
 * This is NOT the unchanged #791 test and does not alter its RED result.
 * Real disposable WAL SQLite, actual #718 staging/S5 code, no real worker.
 * Test-only admission proof is NOT independent off-host CAS authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  ARTIFACT_CHUNK_BYTES,
  StagingArtifactByteBudget,
  initArtifactBudgetFixture,
  type ArtifactBudgetPolicy,
  type TrustedLogicalOpenArtifact,
  type TrustedLogicalReservationAuthority,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

const OWNER_718_SHA='3f2bbfa8c3003b410992d631946a17263ea2b987';
const ORIGINAL_791_SHA='22eec6de24264ed1b8a70f5dfbf4bd5375c3ae39';
const SEED=0x30ca5e21;
const SIZE=ARTIFACT_CHUNK_BYTES;
const CLOCK=new Date('2026-10-23T01:00:00.000Z');
const NOISY='qa30-noisy-owner';
const QUIET='qa30-quiet-owner';
const PROJECT='qa30-cloned-project';
const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
const mutationSha=digest('IMMUTABLE_NATIVE_MUTATION_NOT_RUN');
const sourceSha=digest('SOURCE_NOT_A_REAL_USER_FILE');
const readSha=digest('READ_ONLY_TINY_REQUEST');
const policy:ArtifactBudgetPolicy={
  globalMinuteBytes:8*SIZE,ownerMinuteBytes:2*SIZE,
  globalStorageBytes:8*SIZE,ownerStorageBytes:2*SIZE,
  minFreeDiskBytes:SIZE,maxConcurrentGlobal:8,maxConcurrentPerOwner:2,
};
const original:TrustedLogicalOpenArtifact={
  ownerId:NOISY,deviceId:'qa30-device-noisy',projectId:PROJECT,
  sessionId:'session-qa30-original',rootInvocationId:'root-qa30-original',
  originRunbookId:'runbook-qa30-original',
  logicalOperationId:'canonical-operation-qa30',logicalMutationSha256:mutationSha,
  ownerEpoch:7,grantGeneration:9,
  sizeBytes:SIZE,sourceSha256:sourceSha,physicalFreeBytes:16*SIZE,now:CLOCK,
};
// TEST-ONLY local oracle; no rollback-independent signature/lease. The API
// additionally MUST fail closed when this authority is absent.
const localOracle=(state:'NEVER_DISPATCHED'|'MUTATION_UNKNOWN'='NEVER_DISPATCHED')
  :TrustedLogicalReservationAuthority=>({
    async withCurrentLogicalAdmission(x,apply){
      return apply({
        ownerId:x.ownerId,deviceId:x.deviceId,projectId:x.projectId,
        sessionId:x.sessionId,rootInvocationId:x.rootInvocationId,
        originRunbookId:x.originRunbookId,
        logicalOperationId:x.logicalOperationId,
        logicalMutationSha256:x.logicalMutationSha256,
        ownerEpoch:x.ownerEpoch,grantGeneration:x.grantGeneration,
        mutationState:state,
      });
    },
  });
function shuffle<T>(items:readonly T[],seed:number):T[]{
  const a=[...items];let s=seed>>>0;
  for(let i=a.length-1;i>0;i--){
    s^=s<<13;s^=s>>>17;s^=s<<5;
    const j=(s>>>0)%(i+1);
    [a[i],a[j]]=[a[j]!,a[i]!];
  }
  return a;
}
test('QA30 strict real admission denies cloned UNKNOWN reservation burst and preserves quiet share',
  {timeout:30000},async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'nexowire-qa30-logical-'));
    const file=path.join(dir,'disposable-quota.sqlite');
    const one=new DatabaseSync(file),two=new DatabaseSync(file);
    try{
      one.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000;');
      two.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=15000;');
      initArtifactBudgetFixture(one);
      one.exec(readFileSync(
        path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
      const strictA=new StagingArtifactByteBudget(one,policy,undefined,true);
      const strictB=new StagingArtifactByteBudget(two,policy,undefined,true);
      const admission=new ProposedS5ProtectedTenantAdmission(one,{
        scope:'qa30-logical-stress-share',
        globalRollingMinuteLimit:8,
        tenants:[{tenantId:NOISY,weight:1},{tenantId:QUIET,weight:1}],
      });
      const n=(sql:string,...args:string[])=>
        Number((one.prepare(sql).get(...args) as {n:number}).n);
      // Verify no unprotected compatibility fallback can bypass admission.
      assert.throws(()=>strictA.begin(original),/LOGICAL_ADMISSION_REQUIRED/);
      await assert.rejects(
        ()=>strictA.beginForLogicalMutation(original),
        /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
      assert.equal(n('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),0);
      assert.equal(await strictA.beginForLogicalMutation(original,localOracle()),
        'RESERVED');
      assert.equal(strictA.stageChunk({
        ownerId:NOISY,deviceId:original.deviceId,projectId:PROJECT,
        sessionId:original.sessionId,requestId:'pending-qa30-original',
        offsetBytes:0,byteCount:SIZE,chunkSha256:sourceSha,now:CLOCK,
      }),'CHUNK_PENDING');
      assert.equal(strictA.requestCancel({
        ownerId:NOISY,deviceId:original.deviceId,projectId:PROJECT,
        sessionId:original.sessionId,expectedOffsetBytes:0,
      }),'CANCEL_PENDING');
      assert.throws(()=>strictA.acknowledgeDeletionOnce({
        ownerId:NOISY,deviceId:original.deviceId,projectId:PROJECT,
        sessionId:original.sessionId,durableDeletionVerified:true,
        writersStoppedVerified:true,
      }),/TRUSTED_DELETION_EVIDENCE_REQUIRED/);

      const clones=shuffle(Array.from({length:32},(_,i)=>{
        const num=String(i).padStart(3,'0');
        return {...original,
          sessionId:'session-qa30-clone-'+num,
          rootInvocationId:'root-qa30-clone-'+num,
          originRunbookId:'runbook-qa30-clone-'+num,
          logicalOperationId:i%2===0
            ?'canonical-operation-qa30'
            :'alias-operation-qa30-'+num,
          // Same immutable semantic digest in ALL clone attempts, even
          // when caller fabricates a fresh logicalOperationId.
        };
      }),SEED);
      let deniedClones=0;
      const verdicts=await Promise.all(clones.map((clone,i)=>
        (i%2===0?strictA:strictB).beginForLogicalMutation(
          clone,localOracle())));
      for(const result of verdicts){
        assert.equal(result,'DENIED_REPLAY');
        deniedClones++;
      }
      // Even a forged "not dispatched" witness is rejected by the local
      // immutable logical reservation; a genuine UNKNOWN witness rejects
      // earlier, BEFORE the SQLite transaction.
      await assert.rejects(()=>strictB.beginForLogicalMutation({
        ...original,sessionId:'session-qa30-after-unknown',
        rootInvocationId:'root-qa30-after-unknown',
      },localOracle('MUTATION_UNKNOWN')),
      /LOGICAL_ADMISSION_RECONCILE_REQUIRED/);
      assert.equal(await strictB.beginForLogicalMutation({
        ...original,sessionId:'session-qa30-repaired-epoch',
        rootInvocationId:'root-qa30-repaired-epoch',ownerEpoch:8,
      },localOracle()),'DENIED_REPLAY');
      // A separate tenant can reserve while noisy UNKNOWN is unresolved.
      const quiet:TrustedLogicalOpenArtifact={...original,
        ownerId:QUIET,deviceId:'qa30-device-quiet',
        sessionId:'session-qa30-quiet',rootInvocationId:'root-qa30-quiet',
        originRunbookId:'runbook-qa30-quiet',
        logicalOperationId:'quiet-independent-effect',
        logicalMutationSha256:digest('QUIET_INDEPENDENT_EFFECT'),
      };
      assert.equal(await strictB.beginForLogicalMutation(quiet,localOracle()),
        'RESERVED');

      // Deterministic S5 small logical requests: source-backed strict
      // share, not network latency or physical native admission.
      let quietAccepted=0,noisyAccepted=0,noisyRejected=0;
      const tiny=shuffle([
        ...Array.from({length:12},(_,i)=>({
          owner:NOISY,id:'qa30-tiny-noisy-'+String(i).padStart(3,'0')})),
        ...Array.from({length:4},(_,i)=>({
          owner:QUIET,id:'qa30-tiny-quiet-'+String(i).padStart(3,'0')})),
      ],SEED);
      for(const req of tiny){
        const result=admission.observe(req.owner,req.id,readSha,CLOCK);
        assert.equal(result.authorizesToolExecution,false);
        if(result.status==='reserved'){
          if(req.owner===QUIET)quietAccepted++;else noisyAccepted++;
        }else{
          assert.equal(req.owner,NOISY);
          assert.equal(result.status,'tenant-exhausted');
          noisyRejected++;
        }
      }
      assert.deepEqual({quietAccepted,noisyAccepted,noisyRejected},
        {quietAccepted:4,noisyAccepted:4,noisyRejected:8});
      assert.equal(n("SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE state='PENDING'"),1);
      assert.equal(n("SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state='CANCEL_PENDING'"),1);
      assert.equal(n('SELECT COUNT(*) AS n FROM budget_artifact_logical_reservations'),2);
      assert.equal(n('SELECT COUNT(*) AS n FROM budget_artifact_sessions'),2);
      assert.equal(n("SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE owner_id=? AND state<>'RELEASED'",NOISY),SIZE);
      assert.equal(n("SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE owner_id=? AND state<>'RELEASED'",QUIET),SIZE);
      process.stdout.write('QA30_STRICT_LOGICAL_CLONE_BURST '+JSON.stringify({
        exact718Source:OWNER_718_SHA,unchanged791Source:ORIGINAL_791_SHA,
        workflowCheckoutSha:process.env.GITHUB_SHA??null,
        seed:SEED,cloneAttempts:clones.length,cloneDenied:deniedClones,
        distinctCloneRunbookIds:clones.length,
        pendingOriginalChunks:1,cancelPendingEscrowBytes:SIZE,
        quietReservedBytes:SIZE,quietTinyAccepted:quietAccepted,
        noisyTinyAccepted:noisyAccepted,noisyTinyDenied:noisyRejected,
        authority:'TEST_ONLY_LOCAL_WITNESS_NOT_REAL_OFFHOST_CAS',
        realWorkerAdmissionIntegrated:false,independentWriterStop:false,
        paidCloudflareCost:null,physicalWssConnections:0,
        physicalGiBTransferred:0,production:'P0_NO_GO',
      })+'\n');
    }finally{
      two.close();one.close();rmSync(dir,{recursive:true,force:true});
    }
  });
