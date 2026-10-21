import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('26 independent literal GitHub PR #677-#702 HEADs, branch-vs-main and 20 green 6 red no pending',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json'),l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(s.prs.length,26);
 assert.deepEqual(s.prs.map((p:any)=>p.number),Array.from({length:26},(_,i)=>i+677));
 assert.equal(l.entries.length,138);
 assert.equal(new Set(l.entries.map((p:any)=>p.pr)).size,138);
 assert.equal(s.main.sha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.deepEqual(s.sourceCiCounts.success,20);
 assert.deepEqual(s.sourceCiCounts.failed,6);
 assert.equal(s.sourceCiCounts.pending,0);
 for(const v of s.prs){
  assert.match(v.headSha,/^[a-f0-9]{40}$/);
  assert.match(v.baseSha,/^[a-f0-9]{40}$/);
  assert.ok(v.test.startsWith('test/'));
  const row=l.entries.find((p:any)=>p.pr===v.number);
  assert.equal(row.headSha,v.headSha);
  assert.equal(row.production,'BLOCKED');
  assert.equal(row.originalIncident,'BLOCKED');
  assert.equal(row.ci.status,v.status==='PENDING'?'NOT_VERIFIED':v.status);
 }
});
test('100 open first page is NOT total, non-atomic pagination and no authoritative open count',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json'),l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(s.openPrPagination.page1Length,100);
 assert.equal(s.openPrPagination.page2Length,23);
 assert.equal(s.openPrPagination.page3Length,0);
 assert.equal(s.openPrPagination.atomicSnapshot,false);
 assert.equal(s.openPrPagination.authoritativeCount,null);
 assert.equal(l.authoritativeOpenCount,null);
 assert.equal(l.entries.length,138);
});
test('#677 source 2 real semantic red: extra Native write and forged ACK masking',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json');
 const r=s.negativeCases.cancel677;
 assert.equal(r.run,39644025130);
 assert.equal(r.sourceFailures.length,2);
 assert.match(r.sourceFailures[0],/extra Native/);
 assert.match(r.sourceFailures[1],/FORGED_WRITE_RECEIPT/);
 assert.equal(s.prs.find((p:any)=>p.number===677).status,'FAIL');
});
test('#682 source late cancel never may downgrade UNKNOWN and real Agent E2E is red',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json');
 const r=s.negativeCases.cancel682;
 assert.equal(r.run,39644551666);
 assert.equal(r.sourceFailures.length,2);
 assert.match(r.sourceFailures[0],/UNKNOWN/);
 assert.match(r.sourceFailures[1],/E2E/);
 assert.equal(s.prs.find((p:any)=>p.number===682).status,'FAIL');
 assert.equal(s.negativeCases.lateUnknown.ci,'SUCCESS');
 assert.match(s.negativeCases.lateUnknown.scope,/not proven/);
});
test('#699 old TS1005 both red, current different HEAD dedicated QA green / main queued',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json'),l=rd('PR_SOURCE_AND_RELEASE_GATES.json').entries;
 assert.equal(s.old699.headSha,'405828e09d572450ebb393c0fdc005cec21c855a');
 assert.equal(s.old699.ciRunId,39645530491);
 assert.equal(s.old699.qaRunId,39645530924);
 assert.equal(s.old699.ci,'FAIL');
 assert.match(s.old699.reason,/TS1005/);
 assert.notEqual(s.old699.headSha,s.new699.headSha);
 assert.equal(s.new699.qa,'SUCCESS');
 assert.equal(s.new699.qaRunId,39658654826);
 assert.equal(s.new699.ciRunId,39658654687);
 assert.equal(s.new699.ci,'SUCCESS_VERIFIED');
 const p=l.find((x:any)=>x.pr===699);
 assert.equal(p.headSha,s.new699.headSha);
 assert.equal(p.ci.status,'PASS');
 assert.equal(p.ci.runId,s.new699.ciRunId);
});
test('#700 three Windows import/updater/ancestor ACL failures are unwaived',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json');
 assert.equal(s.negativeCases.protected700.failed,3);
 assert.equal(s.negativeCases.protected700.run,39645643225);
 assert.equal(s.negativeCases.protected700.sourceFailures.length,3);
 assert.equal(s.prs.find((p:any)=>p.number===700).status,'FAIL');
});
test('#683 native current-user DPAPI 180s timeouts and #695/#697 inherited red do not become green',()=>{
 const s=rd('QA_20261021_PR677_702_EXACT_CI.json');
 assert.equal(s.negativeCases.dpapi683.sourceFailures.length,2);
 assert.match(s.negativeCases.dpapi683.sourceFailures[0],/180s/);
 for(const n of [683,695,697])assert.equal(s.prs.find((p:any)=>p.number===n).status,'FAIL');
});
test('physical high-token CORE, #271 ACL, #551 rollback, #587 external witness all remain NO-GO in R01–R22',()=>{
 const m=rd('cross-project-final-acceptance.json'),f=rd('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json'),s=rd('QA_20261021_PR677_702_EXACT_CI.json');
 assert.equal(m.requirements.length,22);
 assert.equal(m.baselineSha,s.main.sha);
 assert.equal(f.findingCount,44);
 for(const id of ['QA16-677-682-NATIVE-CANCEL-REAL-RED','QA16-699-SUPERSEDED-TS1005-VERIFY','QA16-700-WINDOWS-IMPORT-ACL-THREE-RED','QA16-683-WINDOWS-DPAPI-180S','QA16-695-697-INHERITED-WINDOWS-RED','QA16-702-CAS-CORE-SOURCE-NOT-PHYSICAL'])
 assert.ok(f.findings.some((v:any)=>v.id===id),id);
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 for(const id of ['R02','R04','R07','R15','R20','R22'])
  assert.equal(m.requirements.find((v:any)=>v.id===id).levels.source.status,'FAIL');
 for(const k of ['issue271','issue551','issue587','core'])assert.ok(s.physicalNoGo[k]);
});
