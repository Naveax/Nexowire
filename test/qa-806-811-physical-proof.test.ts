import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const read=(name:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',name),'utf8').replace(/^\uFEFF/,'')) as any;
test('five #806–#811 exact source HEAD CI runs are pinned and do not claim production trust',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json');
 assert.equal(s.mainSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(s.prEvidence.map((v:any)=>v.pr),[809,811,808,807,806]);
 assert.deepEqual(s.prEvidence.map((v:any)=>v.run),[39843088157,39854971347,39841919586,39841880930,39841477982]);
 assert.deepEqual(s.prEvidence.map((v:any)=>v.ci),['FAILURE','SUCCESS','SUCCESS','FAILURE','FAILURE']);
 for(const p of s.prEvidence){assert.match(p.head,/^[a-f0-9]{40}$/);assert.match(p.base,/^[a-f0-9]{40}$/);assert.equal(p.staging,'BLOCKED');assert.equal(p.production,'BLOCKED');assert.equal(p.originalIncident,'BLOCKED');assert.equal(p.physicalProof,false);}
});
test('#809 original seven P0 negatives remain mandatory, Windows durable is separate',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),p=s.prEvidence.find((x:any)=>x.pr===809);
 assert.equal(p.jobs.p0.id,120049092580);
 assert.equal(p.jobs.p0.mandatorySeven,7);
 assert.equal(p.jobs.p0.changedOriginalTest,false);
 assert.equal(p.jobs.node22.id,120049092896);
 assert.equal(p.jobs.node22.sameMandatorySeven,true);
 assert.equal(p.jobs.node24.conclusion,'CANCELLED');
 assert.equal(p.jobs.windows.id,120049093038);
 assert.match(p.jobs.windows.failure,/NW_DURABLE_READY/);
 assert.equal(p.jobs.windows.separateFromP0,true);
});
test('#811 git root/hooks candidate green but #800 real negative not independently retired',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json');
 const p=s.prEvidence.find((x:any)=>x.pr===811),neg=s.independentAdversarial.find((x:any)=>x.pr===800);
 assert.equal(p.ci,'SUCCESS');
 assert.equal(p.source,'SOURCE_CANDIDATE_SUCCESS_NOT_INDEPENDENT_NEGATIVE_ACCEPTED');
 assert.match(p.scope,/fsmonitor/);
 assert.equal(neg.reproducedUnsafeSource,true);
 assert.match(neg.relation,/did not run unchanged negative/);
 assert.equal(s.p1.sourceSandbox,'FAIL_ADVERSARIAL_PR800');
});
test('#808 source CORE UI green cannot promote HIGH status until original #726 red is accepted',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),p=s.prEvidence.find((x:any)=>x.pr===808),old=s.independentAdversarial.find((x:any)=>x.pr===726);
 assert.equal(p.run,39841919586);
 assert.equal(p.ci,'SUCCESS');
 assert.equal(p.physicalProof,false);
 assert.match(old.negative,/ownerEpoch|owner/);
 assert.equal(old.reproducedUnsafeSource,true);
});
test('#807 Windows Job stdout-before-exited iteration0 distinct from real #708 CAS negative',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),p=s.prEvidence.find((x:any)=>x.pr===807),old=s.independentAdversarial.find((x:any)=>x.pr===708);
 assert.equal(p.jobs.windows.id,120044773235);
 assert.match(p.jobs.windows.failure,/iteration 0/);
 assert.equal(p.ci,'FAILURE');
 assert.match(old.negative,/UNKNOWN|CAS/);
 assert.equal(old.reproducedUnsafeSource,true);
});
test('#806 staging quota failure is API expected exception mismatch not confirmed false refund',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),p=s.prEvidence.find((x:any)=>x.pr===806);
 assert.equal(p.run,39841477982);
 assert.equal(p.jobs.node24.id,120043339572);
 assert.match(p.jobs.node24.failure,/TRUSTED_DELETION_EVIDENCE_REQUIRED/);
 assert.match(p.jobs.node24.failure,/WRITER_FENCE_REQUIRED/);
 assert.match(p.scope,/NOT physical double refund proof|not.*double-refund/i);
 assert.equal(p.jobs.node22.conclusion,'CANCELLED');
 assert.equal(p.physicalProof,false);
});
test('R01–R22 every real staging production incident still BLOCKED',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),m=read('cross-project-final-acceptance.json');
 assert.equal(m.baselineSha,s.mainSha);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((a:any,r:any)=>(a[r.levels.source.status]=(a[r.levels.source.status]||0)+1,a),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
});
test('P1 sandbox #800 red persists despite #811 source green; four other features unaccepted',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),p=read('QA_20261022_P1_ISSUE780_FEATURE_MATRIX.json');
 assert.equal(p.acceptance.length,5);
 const san=p.acceptance.find((z:any)=>z.id==='P1-SANDBOX');
 assert.equal(san.source,'FAIL');
 assert.equal(san.followup811.fullCI,'SUCCESS');
 assert.match(san.followup811.interpretation,/not independently/);
 assert.equal(p.acceptance.filter((z:any)=>z.source==='NOT_TESTED').length,4);
 assert.ok(p.acceptance.every((z:any)=>z.staging==='BLOCKED'&&z.production==='BLOCKED'));
});
test('release remains NO_GO with no retroactive P0 green or physical rights',()=>{
 const s=read('QA_20261023_PR806_811_PHYSICAL_PROOF.json'),m=read('cross-project-final-acceptance.json');
 assert.equal(s.truth.greenSourceIsNotPhysicalProof,true);
 assert.equal(s.truth.greenSourceIsNotMergeApproval,true);
 assert.equal(s.truth.mandatoryP0RedTestsUntouched,true);
 assert.equal(s.truth.doNotRerunUnchangedSha,true);
 assert.equal(s.truth.noLiveAgentUacBrokerAclD1BillingVm,true);
 assert.ok(Object.entries(s.physicalNoGo).filter(([k])=>k!=='ReVoltVPNUbuntuLab').every(([,v])=>v==='BLOCKED'));
 assert.equal(s.physicalNoGo.ReVoltVPNUbuntuLab,'UNTOUCHED');
 assert.equal(m.qa16LatestReview.production,'NO_GO');
});
