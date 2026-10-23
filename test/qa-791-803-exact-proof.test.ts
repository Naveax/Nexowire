import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('all 13 PRs 791–803 have literal exact heads, 8 SUCCESS 5 FAIL, no unknown',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 assert.equal(x.main,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(x.prs.map((p:any)=>p.pr),Array.from({length:13},(_,i)=>791+i));
 assert.deepEqual(x.prs.reduce((a:any,p:any)=>(a[p.conclusion]=(a[p.conclusion]||0)+1,a),{}),{FAILURE:5,SUCCESS:8});
 assert.deepEqual(x.fullCi,{success:8,failed:5,queued:0,unknown:0});
 for(const p of x.prs){assert.match(p.headSha,/^[a-f0-9]{40}$/);assert.match(p.baseSha,/^[a-f0-9]{40}$/);assert.ok(Number.isInteger(p.runId));assert.equal(p.prodGate,'BLOCKED');}
});
test('#802 failure is seven original P0 reds plus independent Windows durable timeout',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 assert.equal(x.sourceQa802.ci,39824624827);
 assert.equal(x.sourceQa802.conclusion,'FAILURE');
 assert.equal(x.sourceQa802.negativeJobId,119984527813);
 assert.equal(x.sourceQa802.node24JobId,119984527868);
 assert.equal(x.sourceQa802.windowsJobId,119984527847);
 assert.equal(x.sourceQa802.windowsTimeoutMs,27884);
 assert.equal(x.sourceQa802.requiredP0Seven,true);
 assert.equal(x.prs.find((p:any)=>p.pr===802).conclusion,'FAILURE');
});
test('#800 real source Git fsmonitor P1 sandbox escape reproduced, not hosted flake',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 const p=x.prs.find((y:any)=>y.pr===800);
 assert.equal(p.runId,39823730640);
 assert.equal(p.defectReproduced,true);
 assert.match(p.evidence,/core.fsmonitor/);
 const ev=x.focusedExternalNegativeRuns.find((y:any)=>y.pr===800);
 assert.equal(ev.jobId,119981387012);
 assert.match(ev.test,/p20-780-git-fsmonitor/);
 assert.equal(ev.classification,'REPRODUCED_REAL_P1_SANDBOX_DEFECT');
});
test('#791 #792 #799 hosted Windows stdout red not proof their proposed feature failed',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 for(const [id,iter] of [[791,6],[792,11],[799,10]] as const){
 const y=x.prs.find((p:any)=>p.pr===id);
 assert.equal(y.conclusion,'FAILURE');
 assert.equal(y.defectReproduced,false);
 assert.equal(y.classification,'WINDOWS_JOB_STDOUT_ORDER');
 assert.match(y.evidence,new RegExp('iteration '+iter));
 }
});
test('#708 Node22 CAS and #726 Node24 stale effective CORE source negative truly fail',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 const a=x.focusedExternalNegativeRuns.find((z:any)=>z.pr===708);
 const b=x.focusedExternalNegativeRuns.find((z:any)=>z.pr===726);
 assert.equal(a.runId,39824007092);
 assert.equal(a.jobId,119982616074);
 assert.match(a.failure,/Missing expected rejection/);
 assert.equal(b.runId,39823764746);
 assert.equal(b.jobId,119981513248);
 assert.match(b.failure,/CORE effective/);
});
test('#803 success source is not main merge or prod authority',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 const p=x.prs.find((y:any)=>y.pr===803);
 assert.equal(p.runId,39824845400);
 assert.equal(p.conclusion,'SUCCESS');
 assert.equal(x.truthPolicy.fullCiGreenDoesNotAuthorizeMerge,true);
 assert.equal(x.truthPolicy.noPhysicalCoreElevatedProof,true);
});
test('R01–R22 original P0 matrix physical layers all BLOCKED and source stable',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json'),m=rd('cross-project-final-acceptance.json');
 assert.equal(m.baselineSha,x.main);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((a:any,r:any)=>(a[r.levels.source.status]=(a[r.levels.source.status]||0)+1,a),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
});
test('#780 P1 sandbox FAIL, other 4 NOT_TESTED, staging production BLOCKED',()=>{
 const x=rd('QA_20261022_P1_ISSUE780_FEATURE_MATRIX.json'),m=rd('cross-project-final-acceptance.json');
 assert.equal(x.issue,780);
 assert.equal(x.acceptance.length,5);
 assert.equal(x.acceptance.find((p:any)=>p.id==='P1-SANDBOX').source,'FAIL');
 assert.match(x.acceptance.find((p:any)=>p.id==='P1-SANDBOX').sourceObservedDefect,/core.fsmonitor/);
 assert.equal(x.acceptance.filter((p:any)=>p.source==='NOT_TESTED').length,4);
 assert.ok(x.acceptance.every((p:any)=>p.staging==='BLOCKED'&&p.production==='BLOCKED'));
 assert.equal(m.qa16P1FeatureAcceptance.p0OverridesAllowed,false);
 assert.equal(m.qa16P1FeatureAcceptance.sandboxSource,'FAIL');
});
test('no red test weakening, no live VM/Agent/UAC/ACL, no main merge',()=>{
 const x=rd('QA_20261022_PR791_803_EXACT_CI.json');
 assert.equal(x.truthPolicy.noOriginalP0NegativeTestRemoved,true);
 assert.equal(x.physicalNoGo.ReVoltVPNUbuntuLab,'UNTOUCHED');
 assert.ok(Object.entries(x.physicalNoGo).filter(([k])=>k!=='ReVoltVPNUbuntuLab').every(([,v])=>v==='BLOCKED'));
});
