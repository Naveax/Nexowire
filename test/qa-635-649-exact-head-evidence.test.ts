import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('#572 previous f7cb4d9 exact workflow exists and is FAILED, never no-run or green',()=>{
 const x=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 assert.equal(x.reviewedMainSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.equal(x.mainSourceCi.id,39622251466);
 assert.equal(x.historicalQaHead.sha,'f7cb4d96a22d32b10679f844c8c0c878d9d05bc4');
 assert.equal(x.historicalQaHead.ciRunId,39609482502);
 assert.equal(x.historicalQaHead.conclusion,'FAIL');
 assert.equal(x.historicalQaHead.notMissing,true);
 assert.ok(x.historicalQaHead.failures.some((s:string)=>s.includes('NW_DURABLE_READY')));
});
test('all #635 through #649 have exact 40-char HEAD and PR-CI independently tracked without parent laundering',()=>{
 const x=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 const l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(l.entries.length,111);
 assert.equal(x.prs.length,15);
 assert.deepEqual(x.prs.map((p:any)=>p.pr),Array.from({length:15},(_,i)=>635+i));
 for(const p of x.prs){
  assert.match(p.headSha,/^[a-f0-9]{40}$/);
  assert.match(p.baseSha,/^[a-f0-9]{40}$/);
  assert.equal(l.entries.find((r:any)=>r.pr===p.pr).headSha,p.headSha);
  assert.equal(l.entries.find((r:any)=>r.pr===p.pr).ci.status,p.ci.status);
  assert.equal(l.entries.find((r:any)=>r.pr===p.pr).production,'BLOCKED');
  assert.equal(p.originalIncident,'BLOCKED');
  assert.notEqual(p.headSha,p.baseSha);
 }
 for(const n of [635,636,637,639,643,644,648]){
  assert.equal(x.prs.find((p:any)=>p.pr===n).ci.status,'PASS');
 }
 for(const n of [638,640,641,645,646,647,649]){
  assert.equal(x.prs.find((p:any)=>p.pr===n).ci.status,'FAIL');
 }
 assert.equal(x.prs.find((p:any)=>p.pr===642).ci.status,'PASS');
 assert.equal(x.independentConfirmed.unspecifiedCurrent.latestCheckedStatus,'SUCCESS');
});
test('#640 two real broken cancellation transitions remain FAIL and no replay/fake CANCELLED is accepted',()=>{
 const x=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 const before=x.independentConfirmed.cancelBeforeWrite,after=x.independentConfirmed.cancelAfterWrite;
 assert.equal(before.pr,640);
 assert.equal(before.nativeWritesDispatched,0);
 assert.equal(before.expected,'CANCELLED');
 assert.equal(before.status,'FAIL');
 assert.equal(before.evidenceRun,39626203944);
 assert.equal(after.status,'FAIL');
 assert.equal(after.evidenceRun,39626203944);
 assert.match(after.expected,/MUTATION_UNKNOWN/);
 assert.match(after.observed,/UNKNOWN/);
 const l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(l.entries.find((q:any)=>q.pr===640).ci.status,'FAIL');
 assert.equal(l.entries.find((q:any)=>q.pr===641).ci.status,'FAIL');
});
test('#638 synthetic 100cycle PASS cannot override real Windows publisher and ACL red full CI',()=>{
 const x=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 const c=x.independentConfirmed;
 assert.equal(c.standaloneHundredCycles.pr,638);
 assert.equal(c.standaloneHundredCycles.ciRunId,39625276215);
 assert.equal(c.standaloneHundredCycles.conclusion,'SUCCESS');
 assert.equal(c.publisherAclRegression.ciRunId,39625275778);
 assert.equal(c.publisherAclRegression.conclusion,'FAIL');
 assert.equal(c.publisherAclRegression.checks.length,2);
 assert.equal(x.prs.find((p:any)=>p.pr===638).ci.status,'FAIL');
});
test('#648 two successful workflows are source audit only, while #649 inherited fast-exit remains FAIL',()=>{
 const x=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 const a=x.independentConfirmed.auditDualGreen;
 assert.equal(a.pr,648);
 assert.deepEqual(a.runs,[39628249630,39628250167]);
 assert.deepEqual(a.conclusions,['SUCCESS','SUCCESS']);
 assert.match(a.scope,/source-only/);
 const f=x.independentConfirmed.fairnessWindowsRed;
 assert.equal(f.pr,649);
 assert.equal(f.runId,39628451245);
 assert.equal(f.conclusion,'FAIL');
 assert.match(f.failure,/iteration 1/);
 assert.equal(x.acceptance.production,'BLOCKED');
});
test('R01-R22 remains source-specific and ALL physical acceptance blocked by 271 551 587 + unsigned CORE',()=>{
 const m=rd('cross-project-final-acceptance.json'),a=rd('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json');
 const p=rd('QA_20261021_PR635_649_EXACT_EVIDENCE.json');
 assert.equal(m.baselineSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.equal(m.requirements.length,22);
 assert.equal(a.findingCount,39);
 assert.equal(a.findings.length,39);
 for(const n of [271,551,587,617])assert.ok(p.mandatoryNoGo.some((b:any)=>b.issue===n),'#'+n);
 for(const id of ['QA16-640-CANCEL-TRUE-SEMANTIC-BUGS','QA16-638-100CYCLE-SIGNED-ACL-TRUST','QA16-648-AUDIT-DUAL-SOURCE-ONLY','QA16-649-FAIRNESS-WINDOWS-RED','QA16-635-649-STACKED-CORE-RELEASE'])
  assert.ok(a.findings.some((r:any)=>r.id===id),id);
 for(const k of ['R02','R04','R07','R15','R20','R22'])
  assert.equal(m.requirements.find((r:any)=>r.id===k).levels.source.status,'FAIL',k);
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
});
