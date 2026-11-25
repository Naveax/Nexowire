import test from 'node:test';
import assert from 'node:assert/strict';
import {assessReleaseEvidence, REQUIRED_CHECKS, REQUIRED_WORKFLOWS,
  statusOf, type ReleaseSnapshot, type WorkflowRun} from './ai06-release-evidence.js';
const SHA = '43e8125e7a4ced654a769b661dc10938c02bc7a4';
function complete(): ReleaseSnapshot {
  let id = 42517451600;
  const workflows: WorkflowRun[] = Object.entries(REQUIRED_WORKFLOWS).map(([name, names]) => {
    const runId = ++id;
    return {id: runId, name, head_sha: SHA, status: 'completed',
      conclusion: 'success', event: 'pull_request', run_attempt: 1,
      jobs: names.map(job => ({name: job, status: 'completed',
        conclusion: 'success', run_id: runId, head_sha: SHA}))};
  });
  return {expectedHeadSha: SHA, workflows, checks: Object.fromEntries(
    REQUIRED_CHECKS.map(name => [name, {status:'PASS',sha:SHA,
      evidence:'verified-independent-device-receipt:' + name}]))};
}
test('PASS, FAIL, SKIP, NOT_RUN and RUNNING are not conflated', () => {
  assert.equal(statusOf('completed','success'), 'PASS');
  assert.equal(statusOf('completed','failure'), 'FAIL');
  assert.equal(statusOf('completed','skipped'), 'SKIP');
  assert.equal(statusOf('completed',null), 'FAIL');
  assert.equal(statusOf(undefined,undefined), 'NOT_RUN');
  assert.equal(statusOf('pending',null), 'NOT_RUN');
  assert.equal(statusOf('in_progress',null), 'RUNNING');
  assert.equal(statusOf('queued',null), 'RUNNING');
  assert.equal(statusOf('cancelled',null), 'FAIL');
});
test('all complete metadata only earns manual signoff, never automatic production GO',()=>{
  const result=assessReleaseEvidence(complete());
  assert.equal(result.recommendation,'READY_FOR_MANUAL_SIGNOFF');
  assert.equal(result.snapshotOnly,true);
  assert.deepEqual(result.findings,[]);
});
test('a successful run from the wrong SHA blocks acceptance',()=>{
  const s=complete(); s.workflows[1]!.head_sha='a'.repeat(40);
  const r=assessReleaseEvidence(s);
  assert.equal(r.recommendation,'NO_GO');
  assert.ok(r.findings.some(f=>f.startsWith('WORKFLOW_SHA_MISMATCH')));
  assert.ok(r.findings.some(f=>f.startsWith('JOB_PROVENANCE_MISMATCH')));
});
test('stale job SHA or foreign workflow run cannot be used as evidence',()=>{
  const s=complete(); s.workflows[0]!.jobs[0]!.head_sha='b'.repeat(40);
  s.workflows[0]!.jobs[1]!.run_id=0;
  const r=assessReleaseEvidence(s);
  assert.equal(r.recommendation,'NO_GO');
  assert.equal(r.findings.filter(f=>f.startsWith('JOB_PROVENANCE_MISMATCH')).length,2);
});
test('missing, duplicate and skipped required CI jobs block acceptance',()=>{
  const s=complete(); const ci=s.workflows[0]!;
  ci.jobs.splice(0,1);
  ci.jobs[0]!.conclusion='skipped';
  ci.jobs.push({...ci.jobs[1]!});
  const r=assessReleaseEvidence(s);
  assert.ok(r.findings.some(f=>f.startsWith('DUPLICATE_JOB')));
  assert.ok(r.findings.some(f=>f.startsWith('REQUIRED_JOB_NOT_RUN')));
  assert.ok(r.findings.some(f=>f.startsWith('REQUIRED_JOB_SKIP')));
  assert.equal(r.recommendation,'NO_GO');
});
test('an incomplete Windows package or browser runner never masquerades as green',()=>{
  const s=complete(); const win=s.workflows.find(w=>w.name==='Release Readiness')!;
  win.status='in_progress';win.conclusion=null;
  const packageJob=win.jobs.find(j=>j.name==='package (windows-latest)')!;
  packageJob.status='in_progress';packageJob.conclusion=null;
  const browser=s.workflows.find(w=>w.name==='CI')!.jobs.find(j=>j.name==='browser-live')!;
  browser.status='in_progress';browser.conclusion=null;
  const r=assessReleaseEvidence(s);
  assert.equal(r.workflowStatus['Release Readiness'],'RUNNING');
  assert.ok(r.findings.some(f=>f.includes('REQUIRED_JOB_RUNNING:Release Readiness:package (windows-latest)')));
  assert.ok(r.findings.some(f=>f.includes('REQUIRED_JOB_RUNNING:CI:browser-live')));
});
test('source preservation cannot be claimed on wrong candidate SHA or without proof',()=>{
  const s=complete();
  s.checks.source_preservation_79={status:'PASS',sha:'a'.repeat(40),evidence:'plausible text'};
  s.checks.source_preservation_243={status:'PASS',sha:SHA,evidence:''};
  const r=assessReleaseEvidence(s);
  assert.ok(r.findings.includes('CHECK_PROVENANCE_MISSING:source_preservation_79'));
  assert.ok(r.findings.includes('CHECK_PROVENANCE_MISSING:source_preservation_243'));
});
test('physical reboot, power loss and rollback remain NOT_RUN even if CI passes',()=>{
  const s=complete();
  delete s.checks.windows_vm_reboot;
  s.checks.sqlite_power_loss={status:'NOT_RUN'};
  s.checks.official_upgrade_rollback={status:'SKIP'};
  const r=assessReleaseEvidence(s);
  assert.equal(r.recommendation,'NO_GO');
  assert.equal(r.checkStatus.windows_vm_reboot,'NOT_RUN');
  assert.ok(r.findings.includes('CHECK_NOT_RUN:sqlite_power_loss'));
  assert.ok(r.findings.includes('CHECK_SKIP:official_upgrade_rollback'));
});
test('duplicate or missing required workflows block even with successful other workflows',()=>{
  const s=complete();s.workflows.push({...s.workflows[0]!});
  let r=assessReleaseEvidence(s);
  assert.ok(r.findings.includes('DUPLICATE_WORKFLOW:CI'));
  s.workflows=s.workflows.filter(w=>w.name!=='Connection v2 Relay QA');
  r=assessReleaseEvidence(s);
  assert.ok(r.findings.includes('MISSING_WORKFLOW:Connection v2 Relay QA'));
});
test('malformed run identities and incomplete SHA are never accepted',()=>{
  const s=complete();s.expectedHeadSha='43e8125';
  s.workflows[0]!.id=0;s.workflows[0]!.run_attempt=0;s.workflows[0]!.event='other';
  const r=assessReleaseEvidence(s);
  assert.ok(r.findings.includes('INVALID_EXPECTED_SHA'));
  assert.ok(r.findings.includes('WORKFLOW_IDENTITY_INVALID:CI'));
  assert.equal(r.recommendation,'NO_GO');
});
