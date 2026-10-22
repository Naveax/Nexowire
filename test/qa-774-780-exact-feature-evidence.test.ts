import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
const md=(n:string)=>readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'');
test('6 PR exact SHA full CI records, issue 780 separately classified as P1 not PR',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json');
 assert.equal(e.pinnedMain,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(e.prs.map((p:any)=>p.number),[774,775,776,777,778,779]);
 assert.equal(new Set(e.prs.map((p:any)=>p.number)).size,6);
 assert.deepEqual(e.prs.reduce((o:any,p:any)=>(o[p.fullCi]=(o[p.fullCi]||0)+1,o),{}),{SUCCESS:3,FAILURE:3});
 for(const p of e.prs){
  assert.match(p.headSha,/^[0-9a-f]{40}$/);
  assert.match(p.baseSha,/^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(p.runId));
 }
 assert.equal(e.issue780.number,780);
 assert.equal(e.issue780.type,'ISSUE_P1_PRODUCT_EPIC');
 assert.equal(e.issue780.notP0Regression,true);
 assert.equal(e.issue780.ciRunId,null);
});
test('PR774 first empty query resolved to exact workflow 39806480924 and 7 hosted success',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json');
 assert.equal(e.prs.find((p:any)=>p.number===774).runId,39806480924);
 assert.equal(e.prs.find((p:any)=>p.number===774).fullCi,'SUCCESS');
 assert.equal(e.prs.find((p:any)=>p.number===775).runId,39806640003);
 assert.equal(e.prs.find((p:any)=>p.number===778).runId,39807830909);
});
test('PR776 new HEAD four Node24 negatives and Windows SUCCESS, old Windows red stays historical',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json'),c=e.failureEvidence.pr776;
 assert.equal(c.runId,39816348613);
 assert.equal(c.negativeCount,4);
 assert.match(c.reason,/CAS is not configured/);
 assert.match(c.reason,/MUTATION_UNKNOWN/);
 assert.equal(c.node24Job,119955780908);
 assert.equal(c.windowsStatus,'SUCCESS');
 assert.equal(c.windowsJob,119955781543);
 assert.equal(c.historical.runId,39809339319);
 assert.equal(c.historical.windowsIteration,4);
 assert.equal(e.prs.find((p:any)=>p.number===776).fullCi,'FAILURE');
});
test('PR777 Node22/24 source green does not launder exact full CI Windows Job failure',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json'),c=e.failureEvidence.pr777;
 assert.equal(c.runId,39807272228);
 assert.equal(c.node22And24,'SUCCESS');
 assert.equal(c.windowsJob,119923726560);
 assert.equal(c.windowsIteration,8);
 assert.equal(c.fullCi,'FAILURE');
});
test('PR779 seven real P0 gate reds remain, Windows durable reattach independent',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json'),c=e.failureEvidence.pr779;
 assert.equal(e.parentQa.headSha,'8487b5be39737c10f0edfaf6da55bc37d5bad8fe');
 assert.equal(c.runId,39808685776);
 assert.equal(c.mandatoryJob,119928712888);
 assert.equal(c.mandatorySourceFailures,7);
 assert.equal(c.mandatoryTestsSkipped,0);
 assert.equal(c.originalTestsModified,false);
 assert.equal(c.windowsJob,119928712954);
 assert.match(c.windowsFailure,/NW_DURABLE_READY/);
 assert.equal(e.prs.find((p:any)=>p.number===779).fullCi,'FAILURE');
});
test('P1 inventory diff rollback sandbox bounded loop and checkpoint are a separate NOT_TESTED acceptance',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json'),m=rd('cross-project-final-acceptance.json');
 const f=m.qa16P1FeatureAcceptance;
 assert.equal(f.issue,780);
 assert.equal(f.scope,'P1_PRODUCT_EPIC_SEPARATE_FROM_R01_R22');
 assert.deepEqual(f.featureIds,['P1-INV','P1-DIFF','P1-SANDBOX','P1-LOOP','P1-CKPT']);
 assert.equal(f.source,'NOT_TESTED');
 assert.equal(f.staging,'BLOCKED');
 assert.equal(f.production,'BLOCKED');
 assert.equal(f.p0OverridesAllowed,false);
 const content=md('QA_P1_FEATURE_ACCEPTANCE_ISSUE780_20261022.md');
 for(const token of ['P1-INV','P1-DIFF','P1-SANDBOX','P1-LOOP','P1-CKPT','MUTATION_STATE_UNKNOWN','root-relative','forged','disk full','stale','CAS']){
  assert.ok(content.includes(token),token);
 }
 assert.equal(e.issue780.acceptance,'SEPARATE_P1_NOT_TESTED');
});
test('R01-R22 original P0 states and physical blocker cases remain intact',()=>{
 const e=rd('QA_20261022_PR774_780_EXACT_HEAD.json'),m=rd('cross-project-final-acceptance.json');
 assert.equal(m.baselineSha,e.pinnedMain);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((x:any,r:any)=>(x[r.levels.source.status]=(x[r.levels.source.status]||0)+1,x),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 assert.deepEqual(m.qa16LatestReview.fullCi,{success:3,failed:3,issueNotPr:1});
 assert.equal(e.productionNoGo.liveReVoltVpnUbuntuLab,'UNTOUCHED');
 for(const k of ['realSignedInstalledHighCore','typedHypervElevatedVmGuid','acl271','signedBrokerBootstrap551','independentNonRestorableCas587','durableOnecallPublisher588','physicalVmStateReadback']){
  assert.equal(e.productionNoGo[k],'BLOCKED',k);
 }
});
