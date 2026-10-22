import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('PR 759-773 literal exact heads and per-head full CI, no missing-run green',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 assert.equal(s.main,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(s.prs.map((p:any)=>p.pr),Array.from({length:15},(_,i)=>759+i));
 const counts=s.prs.reduce((v:any,p:any)=>(v[p.status]=(v[p.status]||0)+1,v),{});
 assert.deepEqual(counts,{PASS:s.fullCi.success,IN_PROGRESS:s.fullCi.inProgress,FAIL:s.fullCi.failed,NOT_VERIFIED:s.fullCi.noRunVerified});
 for(const p of s.prs){
  assert.match(p.head,/^[a-f0-9]{40}$/);
  assert.match(p.base,/^[a-f0-9]{40}$/);
  assert.equal(p.staging,'BLOCKED');
  assert.equal(p.production,'BLOCKED');
  assert.equal(p.incident,'BLOCKED');
  assert.equal(p.status==='NOT_VERIFIED',p.run===null);
 }
});
test('dedicated QA03 success does not launder PR763 pending ordinary full CI',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 const x=s.prs.find((v:any)=>v.pr===763);
 assert.equal(s.otherWorkflows.qa763.run,39803137184);
 assert.equal(s.otherWorkflows.qa763.result,'SUCCESS');
 assert.equal(s.otherWorkflows.qa763.scope.includes('not full CI'),true);
 assert.equal(x.run,39803136306);
 assert.equal(x.status,'IN_PROGRESS');
});
test('PR769 P0 missing installed HIGH CORE, Hyper-V, #587 and #588 preserved, distinct from Windows',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 assert.equal(s.priorQa.head,'cd01c7e80a9d1eac8309b6fea4fa21a82f246a19');
 assert.equal(s.priorQa.conclusion,'FAILURE');
 assert.equal(s.priorQa.requiredP0.jobId,119911125445);
 assert.equal(s.priorQa.requiredP0.missingContracts,7);
 assert.equal(s.priorQa.requiredP0.originalNegativeSuiteUnmodified,true);
 assert.equal(s.priorQa.windowsDurable.jobId,119911125386);
 assert.match(s.priorQa.windowsDurable.reason,/NW_DURABLE_READY/);
 for(const k of ['coreSignedInstalledHighExecutor','acl271','signedInstaller551','rollbackResistantExternalCas587','durableOnecallAndIndependentFinalPublisher588'])assert.equal(s.releaseGates[k],'BLOCKED');
 assert.equal(s.releaseGates.typedHypervElevatedGuidPrivilege,'FAIL');
});
test('PR771 independent public CORE reason red is not a Windows native surrogate timeout',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 const v=s.actualFailEvidence.pr771;
 assert.equal(v.run,39804391279);
 assert.equal(v.sourceJob,119913589035);
 assert.match(v.sourceFailure,/PUBLIC_CORE_STATUS_CONTRACT_GAP/);
 assert.equal(v.windowsJob,119913589085);
 assert.match(v.windowsFailure,/20s/);
 assert.equal(s.prs.find((p:any)=>p.pr===771).status,'FAIL');
});
test('PR772 hosted fast-exit failure not accepted as source DAG merge success',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 assert.equal(s.actualFailEvidence.pr772.run,39804484972);
 assert.equal(s.actualFailEvidence.pr772.job,119913921496);
 assert.match(s.actualFailEvidence.pr772.reason,/iteration 1/);
 assert.equal(s.prs.find((p:any)=>p.pr===772).status,'FAIL');
});
test('22 physical staging production incident gates BLOCKED, ReVoltVPN VM untouched',()=>{
 const s=rd('QA_20261022_PR759_773_EXACT_HEAD.json');
 const m=rd('cross-project-final-acceptance.json');
 assert.equal(m.baselineSha,s.main);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((o:any,r:any)=>(o[r.levels.source.status]=(o[r.levels.source.status]||0)+1,o),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 assert.equal(s.releaseGates.ReVoltVpnUbuntuLab,'UNTOUCHED');
 assert.equal(s.governance.originalNegativeTestsPreserved,true);
 assert.equal(s.governance.productionMerge,false);
});
