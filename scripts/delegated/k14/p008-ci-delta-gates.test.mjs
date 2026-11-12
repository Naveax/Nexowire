import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditDelta, markdownDelta, stageTriage } from './p008-ci-delta-gates.mjs';

const base=fileURLToPath(new URL('../../../docs/delegated/integration-k14/p007-59-prs-20261108.json',import.meta.url));
const next=fileURLToPath(new URL('../../../docs/delegated/integration-k14/p008-59-pr-ci-delta-20261108.json',import.meta.url));
const old=JSON.parse(readFileSync(base,'utf8'));
const fresh=JSON.parse(readFileSync(next,'utf8'));
const clone=()=>structuredClone(fresh);
const one=(s,n)=>s.prs.find(p=>p.number===n);

test('P008 59 exact-head source CI results: 48 green/5 failed/6 action required zero-job',()=>{
  const r=auditDelta(old,fresh);
  assert.equal(r.scannedPrs,59);
  assert.deepEqual(Object.fromEntries(Object.entries(r.groups).map(([k,v])=>[k,v.length])),{
    GREEN_SOURCE_JOBS_ONLY:48,CI_FAILED:5,ZERO_JOB_ACTION_REQUIRED:6,
  });
  assert.deepEqual(r.groups.CI_FAILED,[1152,1141,1130,1120,1118]);
  assert.deepEqual(r.groups.ZERO_JOB_ACTION_REQUIRED,[1035,1030,1016,1015,1011,1010]);
});

test('eight PR heads moved after P007, 17 job pages refreshed; all old SHA evidence stays historical',()=>{
  const r=auditDelta(old,fresh);
  assert.deepEqual(r.sourceHEADChanges,[1153,1152,1149,1147,1146,1145,1142,1106]);
  assert.equal(r.jobRefreshCount,17);
  for(const n of r.sourceHEADChanges) assert.equal(r.rows.find(p=>p.number===n).jobSource,'NEW_RUN_JOBS');
  assert.equal(r.rows.find(p=>p.number===1153).runId,42501593766);
});

test('missing PR, duplicate, closed, non-Draft, stale previous HEAD all rejected',()=>{
  for(const mutate of [s=>s.prs.pop(),s=>s.prs[0].number=s.prs[1].number,
    s=>s.prs[0].state='closed',s=>s.prs[0].draft=false,
    s=>s.prs[0].previousHead='f'.repeat(40)]) {
    const s=clone();mutate(s);assert.throws(()=>auditDelta(old,s));
  }
});

test('new head run must exactly match commit SHA; previous CI never inherited',()=>{
  const s=clone();one(s,1153).run.head_sha='f'.repeat(40);
  assert.throws(()=>auditDelta(old,s),/exact-head run/);
  const t=clone();one(t,1153).updatedJobs=null;
  assert.throws(()=>auditDelta(old,t),/jobs must match/);
});

test('refreshed job page must match current run ID, not prior or other workflow',()=>{
  const s=clone();one(s,1153).updatedJobs.runId=42486357049;
  assert.throws(()=>auditDelta(old,s),/jobs must match/);
  const t=clone();one(t,1153).updatedJobs.jobs[0].head_sha='f'.repeat(40);
  const r=auditDelta(old,t);
  assert.equal(r.rows.find(p=>p.number===1153).ci,'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
});

test('green seven jobs cannot prove new nested test execution or authorize merge',()=>{
  const r=auditDelta(old,fresh);
  assert.equal(r.mergeAuthorized,false);
  assert.equal(r.physicalAcceptance,'NOT_RUN');
  assert.equal(r.newNestedTestHostedProof,'NOT_VERIFIED');
  assert.ok(r.rows.every(p=>p.mergeAuthorized===false&&p.newNestedTestHostedProof==='NOT_VERIFIED'));
});

test('failed WSL #1120 three setup steps passed; distro install unresolved; later code tests not run',()=>{
  const r=auditDelta(old,fresh).wsl;
  assert.equal(r.failedRun,42411741316);
  assert.equal(r.failedJob,128521158395);
  assert.equal(r.failedDurationSeconds,2700);
  assert.equal(r.firstThreeStepsSuccess,true);
  assert.equal(r.failedInstallStepState,'in_progress');
  assert.equal(r.failedInstallStepConclusion,null);
  assert.equal(r.downstreamWereNotRun,true);
  assert.equal(r.inference,'WSL_DISTRO_INSTALL_STAGE_HUNG_OR_TIMED_OUT_CAUSE_NOT_PROVEN');
});

test('WSL log 404 and zero artifacts block root-cause and source-defect assertions',()=>{
  const r=auditDelta(old,fresh).wsl;
  assert.equal(r.directRootCauseLogAvailable,false);
  assert.equal(r.artifactCount,0);
  assert.equal(r.bugInNexowireSourceProven,false);
});

test('successful later WSL control completed distro install and actual wsl.exec step',()=>{
  const r=auditDelta(old,fresh).wsl;
  assert.equal(r.controlRun,42501593766);
  assert.equal(r.controlJob,128795316359);
  assert.equal(r.controlInstallSeconds,43);
  assert.equal(r.controlDurationSeconds,88);
  assert.equal(fresh.wslInvestigation.control.steps.find(s=>s.name==='Verify Nexowire wsl.exec against real WSL2').conclusion,'success');
});

test('WSL triage cannot silently reinterpret missing step or fake control SHA',()=>{
  const s=clone();s.wslInvestigation.failed.steps=s.wslInvestigation.failed.steps.filter(x=>x.name!=='Install real Ubuntu WSL2 distro');
  assert.throws(()=>auditDelta(old,s),/WSL control pairing/);
  const t=clone();t.wslInvestigation.control.runHead='f'.repeat(40);
  assert.throws(()=>auditDelta(old,t),/WSL provenance incomplete/);
});

test('cannot claim later tests failed when WSL installer step only in_progress',()=>{
  const b=structuredClone(fresh.wslInvestigation.failed);
  b.steps.find(s=>s.name==='Run npm ci').status='completed';
  const result=stageTriage(b,fresh.wslInvestigation.control);
  assert.equal(result.downstreamWereNotRun,false);
  assert.equal(result.bugInNexowireSourceProven,false);
});

test('offline markdown lists all 59 PRs and preserves 404/NOT_VERIFIED caveats',()=>{
  const report=markdownDelta(old,fresh);
  assert.equal((report.match(/^\| #\d+ \|/gm)||[]).length,59);
  assert.match(report,/42501593766/);
  assert.match(report,/NOT_VERIFIED/);
  assert.match(report,/NO MERGE/);
});

test('missing logs never prove direct root cause',()=>{
  for(const value of [undefined, null, '', 'NOT_RUN']) {
    const failed=structuredClone(fresh.wslInvestigation.failed);
    if(value===undefined) delete failed.jobLog;
    else failed.jobLog=value;
    assert.equal(stageTriage(failed,fresh.wslInvestigation.control).directRootCauseLogAvailable,false);
  }
});

test('an incomplete downstream job list cannot prove WSL installation hung',()=>{
  const failed=structuredClone(fresh.wslInvestigation.failed);
  failed.steps=failed.steps.filter(s=>!['Run npm ci','Run npm run typecheck','Verify Nexowire wsl.exec against real WSL2'].includes(s.name));
  const r=stageTriage(failed,fresh.wslInvestigation.control);
  assert.equal(r.downstreamWereNotRun,false);
  assert.equal(r.inference,'WSL_FAILURE_STAGE_UNKNOWN');
});

test('a downstream step with missing conclusion cannot be treated as pending/NOT_RUN',()=>{
  const failed=structuredClone(fresh.wslInvestigation.failed);
  failed.steps.find(s=>s.name==='Run npm ci').conclusion='failure';
  const r=stageTriage(failed,fresh.wslInvestigation.control);
  assert.equal(r.downstreamWereNotRun,false);
  assert.equal(r.inference,'WSL_FAILURE_STAGE_UNKNOWN');
});
