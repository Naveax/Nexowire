import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const read=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('five exact current NEXT2 PR heads and full CI statuses, no inferred success',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json');
 assert.equal(e.main,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(e.records.map((r:any)=>r.pr),[837,821,814,826,829]);
 assert.deepEqual(e.records.map((r:any)=>r.fullConclusion),['FAILURE','FAILURE','FAILURE','FAILURE','SUCCESS']);
 assert.deepEqual(e.records.map((r:any)=>r.fullRun),[39864371572,39862537837,39865936576,39866105972,39863445519]);
 for(const r of e.records){assert.match(r.head,/^[a-f0-9]{40}$/);assert.match(r.base,/^[a-f0-9]{40}$/);}
});
test('#837 seven mandatory independent P0 FAIL are contract gaps, Windows durable separate',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),r=e.records.find((r:any)=>r.pr===837);
 const qa=r.jobEvidence.find((j:any)=>j.name==='qa-independent-negative-acceptance');
 assert.equal(qa.id,120122734718);
 assert.deepEqual([qa.pass,qa.fail,qa.skip],[10,7,0]);
 assert.equal(r.fullConclusion,'FAILURE');
 assert.equal(r.jobEvidence.find((j:any)=>j.name==='browser-live').missing,'NW_DURABLE_READY');
 assert.equal(r.jobEvidence.find((j:any)=>j.name==='browser-live').durationMs,26337);
});
test('#821 actual git filter.clean external command source escape reproduced',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),r=e.records.find((r:any)=>r.pr===821);
 assert.equal(r.fullRun,39862537837);
 assert.ok(r.jobEvidence.some((j:any)=>j.classification==='REAL_GIT_FILTER_CLEAN_TASKROOT_ESCAPE'&&j.id===120116564545));
 assert.match(r.interpretation,/filter.clean/);
});
test('#814 nested refs loose and packed object link three real source negatives, separate Windows Job',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),r=e.records.find((r:any)=>r.pr===814);
 const n=r.jobEvidence.find((j:any)=>j.name==='Node24');
 assert.equal(n.id,120128010532);
 assert.equal(n.cases.length,3);
 assert.equal(r.jobEvidence.find((j:any)=>j.name==='browser-live').iteration,7);
 assert.equal(r.fullConclusion,'FAILURE');
});
test('#826 blanket deny is real compatibility loss not test bug or external provider proof',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),r=e.records.find((r:any)=>r.pr===826);
 assert.equal(r.fullRun,39866105972);
 assert.equal(r.fullConclusion,'FAILURE');
 const j=r.jobEvidence.find((j:any)=>j.name==='test (22)');
 assert.equal(j.id,120128575331);
 assert.equal(j.failures.length,4);
 assert.match(j.failures[3],/RECONCILE_REQUIRED/);
 assert.equal(r.jobEvidence.find((j:any)=>j.name==='browser-live').conclusion,'SUCCESS');
 assert.match(r.interpretation,/compatibility\/availability regression/);
});
test('#829 full and independent Windows durable workflow green on own SHA only',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),r=e.records.find((r:any)=>r.pr===829);
 assert.equal(r.fullConclusion,'SUCCESS');
 assert.equal(r.fullRun,39863445519);
 assert.equal(r.dedicatedRun,39863445634);
 assert.equal(r.dedicatedConclusion,'SUCCESS');
 assert.match(r.interpretation,/not a merge into #837/);
});
test('original P0 source mix physical staging production incident and P1 sandbox fail retain no-go',()=>{
 const e=read('QA_20261023_RELEASE_NEXT2_EXACT_PROOF.json'),m=read('cross-project-final-acceptance.json'),p=read('QA_20261022_P1_ISSUE780_FEATURE_MATRIX.json');
 assert.equal(m.baselineSha,e.main);
 assert.equal(m.requirements.length,22);
 assert.deepEqual(m.requirements.reduce((a:any,r:any)=>(a[r.levels.source.status]=(a[r.levels.source.status]||0)+1,a),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 assert.equal(p.acceptance.find((v:any)=>v.id==='P1-SANDBOX').source,'FAIL');
 assert.equal(p.acceptance.filter((v:any)=>v.source==='NOT_TESTED').length,4);
 assert.equal(e.release.vm,'UNTOUCHED');
 assert.equal(e.truthRules.neverDisableOriginalP0Seven,true);
});
