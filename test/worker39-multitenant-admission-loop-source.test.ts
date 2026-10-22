/**
 * #39 independent cross-boundary SOURCE QA on #718.
 * No external CAS witness is invented. No native tool or worker is launched.
 * Existing #791/#806 hostile negatives are intentionally untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  StagingArtifactByteBudget,initArtifactBudgetFixture,
  STAGING_ARTIFACT_BUDGET,ARTIFACT_CHUNK_BYTES,
  type TrustedLogicalOpenArtifact,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';

const NOW=new Date('2026-10-23T00:00:00.000Z');
const A='tenant-39-noisy',B='tenant-39-quiet';
const SHA=createHash('sha256').update('worker39-same-logical-effect').digest('hex');
const RO_SHA=createHash('sha256').update('worker39-readonly-only').digest('hex');
const binding:TrustedLogicalOpenArtifact={
  ownerId:A,deviceId:'device-39-a',projectId:'project-39-a',
  sessionId:'session-39-original',rootInvocationId:'root-39-original',
  originRunbookId:'runbook-39-original',
  logicalOperationId:'effect-39-immutable',logicalMutationSha256:SHA,
  ownerEpoch:7,grantGeneration:3,
  sizeBytes:ARTIFACT_CHUNK_BYTES,sourceSha256:SHA,
  physicalFreeBytes:32*ARTIFACT_CHUNK_BYTES,now:NOW,
};
function seededShuffle<T>(items:readonly T[],seed:number):T[]{
  const result=[...items];let x=seed>>>0;
  for(let i=result.length-1;i>0;i--){
    x^=x<<13;x^=x>>>17;x^=x<<5;
    const j=(x>>>0)%(i+1);
    [result[i],result[j]]=[result[j]!,result[i]!];
  }
  return result;
}

test('#39 strict #718 rejects UNKNOWN/cloned identities without off-host CAS before any reservation',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    initArtifactBudgetFixture(db);
    const budget=new StagingArtifactByteBudget(
      db,STAGING_ARTIFACT_BUDGET,undefined,true);
    assert.throws(()=>budget.begin(binding),/LOGICAL_ADMISSION_REQUIRED/);
    for(const altered of [
      binding,
      {...binding,sessionId:'session-39-cloned',rootInvocationId:'root-39-cloned'},
      {...binding,originRunbookId:'runbook-39-cloned',
        sessionId:'session-39-cloned',rootInvocationId:'root-39-cloned'},
      {...binding,ownerEpoch:8},
      {...binding,grantGeneration:4},
    ]){
      await assert.rejects(
        ()=>budget.beginForLogicalMutation(altered),
        /LOGICAL_ADMISSION_EXTERNAL_CAS_REQUIRED/);
    }
    const count=(table:string)=>Number((db.prepare(
      'SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n);
    assert.equal(count('budget_artifact_sessions'),0);
    assert.equal(count('budget_artifact_logical_reservations'),0);
    assert.equal(count('budget_artifact_chunks'),0);
  }finally{db.close();}
});

test('#39 fixed-seed Tenant B eight real read-only runbooks progress while noisy A fills its S5 share',async t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(readFileSync(path.resolve('test/fixtures/s5-protected-share-local.sql'),'utf8'));
  const fair=new ProposedS5ProtectedTenantAdmission(db,{
    scope:'worker39-readonly-fairness',globalRollingMinuteLimit:16,
    tenants:[{tenantId:A,weight:1},{tenantId:B,weight:1}],
  });
  const dir=await mkdtemp(path.join(tmpdir(),'nexowire-qa39-'));
  t.after(()=>rm(dir,{force:true,recursive:true}));
  const store=new RunbookStore({stateFile:path.join(dir,'runbooks.json')});
  await store.initialize();
  let readOnlyCalls=0;
  const callbacks={
    runTaskGraph:async()=>{throw Error('NATIVE_DISPATCH_FORBIDDEN_IN_QA39');},
    runAssertions:async()=>{
      readOnlyCalls++;
      return {data:{ok:true,passed:1,failed:0,skipped:0}};
    },
  };
  const jobs=seededShuffle([
    ...Array.from({length:24},(_,i)=>({
      tenant:A,id:'qa39-noisy-'+String(i).padStart(3,'0')})),
    ...Array.from({length:8},(_,i)=>({
      tenant:B,id:'qa39-quiet-'+String(i).padStart(3,'0')})),
  ],0x39a19d);
  let acceptedA=0,deniedA=0,doneB=0,lastQuietStep=0;
  for(let step=0;step<jobs.length;step++){
    const job=jobs[step]!;
    const d=fair.observe(job.tenant,job.id,RO_SHA,NOW);
    assert.equal(d.authorizesToolExecution,false,
      'S5 fairness reservation is never native execution permission');
    if(job.tenant===A){
      if(d.status==='reserved')acceptedA++;
      else{
        assert.equal(d.status,'tenant-exhausted');
        deniedA++;
      }
      continue;
    }
    assert.equal(d.status,'reserved','noisy A must not starve quiet B');
    const result=await executeDurableRunbook({
      runbook_id:job.id,steps:[{
        id:'readonly-assert-39',kind:'assertions',
        assertions:{check:'READ_ONLY_SOURCE_QA'},
      }],
    },store,callbacks) as {data:{ok:boolean;summary:{succeeded:number}}};
    assert.equal(result.data.ok,true);
    assert.equal(result.data.summary.succeeded,1);
    doneB++;
    lastQuietStep=step+1;
  }
  assert.deepEqual({acceptedA,deniedA,doneB},{acceptedA:8,deniedA:16,doneB:8});
  assert.equal(readOnlyCalls,8);
  assert.ok(lastQuietStep<=32,'bounded fixed-seed scheduling events');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM s5_fair_window')
    .get() as {n:number}).n,16);
  process.stdout.write('QA39_SOURCE_READONLY_FAIRNESS '+JSON.stringify({
    seed:0x39a19d,quietCompleted:doneB,scheduleEvents:lastQuietStep,
    nativeToolCalls:0,realBoundedLoop:false,
    fairnessAuthorizesExecution:false,production:'NO_GO',
  })+'\n');
});

/**
 * INTENTIONALLY RED against existing executeDurableRunbook until #01/#33
 * install an independent immutable logical-mutation admission fence.
 * The callback is a pure counter; no OS or network effect.
 * Unlike #781/#791, the assertion is the required NO-REDISPATCH property.
 */
test('#39 RED: A lost-ACK UNKNOWN cannot redispatch via cloned runbook_id',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nexowire-qa39-red-'));
  t.after(()=>rm(dir,{force:true,recursive:true}));
  const stateFile=path.join(dir,'runbooks.json');
  const store=new RunbookStore({stateFile});
  await store.initialize();
  let attemptedNativeDispatches=0;
  const callbacks={
    runTaskGraph:async()=>{
      attemptedNativeDispatches++;
      throw Object.assign(Error('test-only lost final ACK'),{
        code:'MUTATION_STATE_UNKNOWN',
      });
    },
    runAssertions:async()=>({data:{ok:true,passed:1,failed:0,skipped:0}}),
  };
  const steps=[{
    id:'one-semantic-mutation-39',kind:'task_graph' as const,
    task_graph:{jobs:[{id:'same-logical-effect-39',kind:'NO_NATIVE_OS_IO'}]},
  }];
  await executeDurableRunbook({
    runbook_id:'runbook-39-original',steps,
  },store,callbacks);
  assert.equal(attemptedNativeDispatches,1);
  const restarted=new RunbookStore({stateFile});
  await restarted.initialize();
  await executeDurableRunbook({
    runbook_id:'runbook-39-cloned',steps,
    resume:false,retry_unknown:false,retry_failed:false,
  },restarted,callbacks);
  assert.equal(attemptedNativeDispatches,1,
    'RED: cloned runbook must not dispatch unresolved semantic mutation again');
});
