import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('12 #747-#758 exact SHA snapshots count full CI success, red and absent separately',()=>{
 const s=rd('QA_20261022_PR747_758_EXACT_HEAD.json');
 assert.equal(s.pinnedMain,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(s.prs.map((p:any)=>p.number),Array.from({length:12},(_,i)=>747+i));
 assert.deepEqual(s.prs.reduce((m:any,p:any)=>(m[p.ciStatus]=(m[p.ciStatus]||0)+1,m),{}),{NOT_VERIFIED:2,PASS:6,FAIL:4});
 for(const p of s.prs){assert.match(p.headSha,/^[a-f0-9]{40}$/);assert.match(p.baseSha,/^[a-f0-9]{40}$/);assert.equal(p.production,'BLOCKED');assert.equal(p.incident,'BLOCKED');}
 for(const n of [747,749])assert.equal(s.prs.find((p:any)=>p.number===n).ciRunId,null);
});
test('#758 true P0 seven red remain mandatory and distinct from Windows durable timeout',()=>{
 const s=rd('QA_20261022_PR747_758_EXACT_HEAD.json');
 const p=s.failures.qa758.p0Acceptance;
 assert.equal(s.parentQa.exactCiRunId,39736944182);
 assert.equal(p.jobId,119685142704);
 assert.deepEqual([p.pass,p.fail,p.skip],[10,7,0]);
 assert.equal(p.mandatory,true);
 assert.equal(p.missing.length,7);
 assert.ok(p.missing.some((t:string)=>t.includes('hyperv.vm.start')));
 assert.ok(p.missing.some((t:string)=>t.includes('#587')));
 assert.ok(p.missing.some((t:string)=>t.includes('#588')));
 assert.equal(s.failures.qa758.windowsDurable.jobId,119685142763);
 assert.match(s.failures.qa758.windowsDurable.condition,/NW_DURABLE_READY/);
 assert.equal(s.failures.qa758.node24.kind,'REQUIRED_NEGATIVE_GATES');
});
test('#750 Linux private desktop mismatch and #751/#754 Windows stdout order are independent CI failures',()=>{
 const s=rd('QA_20261022_PR747_758_EXACT_HEAD.json');
 assert.equal(s.failures.node750.runId,39735615243);
 assert.match(s.failures.node750.message,/requires Windows/);
 assert.deepEqual([s.failures.windowsJob751.iteration,s.failures.windowsJob754.iteration],[5,6]);
 for(const n of [750,751,754,758])assert.equal(s.prs.find((p:any)=>p.number===n).ciStatus,'FAIL');
});
test('source success or TEMP OS ACL cannot assert real signed HIGH CORE or final Native publication',()=>{
 const s=rd('QA_20261022_PR747_758_EXACT_HEAD.json');
 assert.equal(s.independent.qa753.conclusion,'SUCCESS');
 assert.equal(s.independent.qa756.conclusion,'SUCCESS');
 assert.equal(s.noGo.coreHighToken,'BLOCKED');
 assert.equal(s.noGo.vmTypedPrivilege,'FAIL');
 for(const k of ['acl271','signedBroker551','externalRollbackResistantCas587','finalAuthenticatedPublisher588','authorizedHypervRunningReadback'])assert.equal(s.noGo[k],'BLOCKED');
 assert.equal(s.guardrails.redTestsUnmodified,true);
 assert.equal(s.noGo.ReVoltVPNUbuntuLab,'UNTOUCHED');
});
test('R01-R22 layer statuses never promote source green to production acceptance',()=>{
 const m=rd('cross-project-final-acceptance.json');
 assert.equal(m.requirements.length,22);
 assert.equal(m.inspectedMainSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(m.requirements.reduce((o:any,r:any)=>(o[r.levels.source.status]=(o[r.levels.source.status]||0)+1,o),{}),{BLOCKED:9,FAIL:6,PASS:6,NOT_TESTED:1});
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 assert.deepEqual(m.qa16LatestReview.fullCi,{success:6,failed:4,unverified:2});
});
