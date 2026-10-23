import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('both direct exact PR HEADs and full CI failures, empty run search not no-CI',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 assert.equal(x.pinnedMain,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(x.prs.map((p:any)=>p.number),[779,790]);
 assert.deepEqual(x.prs.map((p:any)=>p.runId),[39808685776,39818835181]);
 assert.deepEqual(x.prs.map((p:any)=>p.conclusion),['FAILURE','FAILURE']);
 for(const p of x.prs){assert.match(p.headSha,/^[a-f0-9]{40}$/);assert.match(p.baseSha,/^[a-f0-9]{40}$/);assert.equal(p.source,'DIRECT_SAME_SHA_GITHUB_ACTIONS_RUN');}
});
test('both mandatory independent P0 acceptance jobs each preserve 10 PASS 7 FAIL 0 SKIP',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 const jobs=x.runJobEvidence.filter((j:any)=>j.class==='MANDATORY_P0_NEGATIVE_ACCEPTANCE');
 assert.equal(jobs.length,2);
 assert.deepEqual(jobs.map((j:any)=>j.jobId),[119928712888,119964334955]);
 for(const j of jobs)assert.deepEqual([j.tests,j.pass,j.fail,j.skip,j.status],[17,10,7,0,'FAILURE']);
 assert.equal(x.sevenRequiredP0.length,7);
 assert.ok(x.sevenRequiredP0.every((g:any)=>g.status==='FAIL'));
 for(const t of ['ROOT_ISSUED_MAX_900S','REAL_INSTALLED_HIGH_CORE_EXECUTOR','EXPLICIT_SIGNED_CORE_BROKER_ENDPOINT','HYPERV_VM_START_TYPED_ELEVATED','HYPERV_VM_GUID_SCOPED_BROKER','ROLLBACK_INDEPENDENT_AUTHORITY_587','DURABLE_ONECALL_PUBLICATION_588'])assert.ok(x.sevenRequiredP0.some((g:any)=>g.id===t));
});
test('Node24 general npm check same P0 7, no proven independent TS syntax issue',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 const jobs=x.runJobEvidence.filter((j:any)=>j.class==='MANDATORY_P0_GATES_IN_GENERAL_SUITE');
 assert.deepEqual(jobs.map((j:any)=>j.jobId),[119928712863,119964334776]);
 assert.ok(jobs.every((j:any)=>j.knownSevenSame===true&&j.separateTypeScriptSyntaxFailureProved===false));
 assert.equal(x.comparison.noIndependentTsSyntaxRegressionEstablished,true);
});
test('Windows durable process fail is independent in both CI runs, preserve exact elapsed and logs',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 const jobs=x.runJobEvidence.filter((j:any)=>j.class==='INDEPENDENT_WINDOWS_DURABLE_REATTACH_FAILURE');
 assert.deepEqual(jobs.map((j:any)=>j.jobId),[119928712954,119964334340]);
 assert.deepEqual(jobs.map((j:any)=>j.timeoutMs),[27108,26573]);
 assert.ok(jobs.every((j:any)=>j.pattern==='NW_DURABLE_READY'));
 assert.equal(x.windowsDurable.distinctFromRequiredSeven,true);
 assert.equal(x.comparison.notAllCiFailuresIntentional,true);
});
test('Node22 cancellation and four hosted sibling successes never turn full CI green',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 assert.deepEqual(x.runJobEvidence.filter((j:any)=>j.class==='CANCELLED_NOT_PASS_OR_SEPARATE_ASSERTION').map((j:any)=>j.jobId),[119928713216,119964334853]);
 assert.equal(x.comparison.noFullCiGreen,true);
 assert.deepEqual(x.comparison.hostedSuccessesAtBoth,['linux-native-live','wsl2-live','security-operational-live','macos-agent-lifecycle-live']);
});
test('R01-R22 physical P0 matrix source statuses remain stable, no hidden waiver',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json'),m=rd('cross-project-final-acceptance.json');
 assert.equal(m.baselineSha,x.pinnedMain);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((o:any,r:any)=>(o[r.levels.source.status]=(o[r.levels.source.status]||0)+1,o),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 assert.equal(x.runJobEvidence.filter((j:any)=>j.class==='MANDATORY_P0_NEGATIVE_ACCEPTANCE').length,2);
 assert.equal(x.runJobEvidence.filter((j:any)=>j.class==='INDEPENDENT_WINDOWS_DURABLE_REATTACH_FAILURE').length,2);
});
test('issue780 P1 sandbox source FAIL and four other feature items NOT_TESTED, original P0 protected',()=>{
 const x=rd('QA_20261022_P1_ISSUE780_FEATURE_MATRIX.json'),m=rd('cross-project-final-acceptance.json');
 assert.equal(x.issue,780);
 assert.equal(x.issueType,'OPEN_P1_EPIC_NOT_PR');
 assert.deepEqual(x.acceptance.map((a:any)=>a.id),['P1-INV','P1-DIFF','P1-SANDBOX','P1-LOOP','P1-CKPT']);
 assert.equal(x.acceptance.find((a:any)=>a.id==='P1-SANDBOX').source,'FAIL');
 assert.equal(x.acceptance.filter((a:any)=>a.source==='NOT_TESTED').length,4);
 assert.ok(x.acceptance.every((a:any)=>a.staging==='BLOCKED'&&a.production==='BLOCKED'&&a.requiredNegative.length>=3));
 assert.equal(x.policy.realSignedHighCoreMustStayDisabledWithoutP0,true);
 assert.equal(m.qa16P1FeatureAcceptance.p0OverridesAllowed,false);
 assert.equal(m.qa16P1FeatureAcceptance.source,'MIXED_1_FAIL_4_NOT_TESTED');
});
test('no live VM UAC Agent ACL or original red source-test mutations in QA scope',()=>{
 const x=rd('QA_20261022_PR779_790_FAILED_STEPS.json');
 assert.equal(x.policy.doNotDeleteOriginalSeven,true);
 assert.equal(x.policy.doNotXfailOrSuppress,true);
 assert.equal(x.policy.doNotMutateLiveAgentUacVmAcl,true);
 assert.equal(x.policy.mainMerge,false);
 assert.ok(Object.values(x.releaseNoGo).every(v=>v===true));
});
