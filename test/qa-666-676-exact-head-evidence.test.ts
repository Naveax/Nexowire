import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
const snap=()=>rd('QA_20261021_PR650_652_666_676_EXACT_EVIDENCE.json');
test('historical 77 open PR snapshot is distinct from 138 reviewed HEADs and non-atomic current pages',()=>{
 const x=snap(),l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(x.repo.openPrCount,77);
 assert.equal(l.entries.length,138);
 assert.equal(l.openPrCountAtSnapshot,null);
 assert.equal(l.authoritativeOpenCount,null);
 assert.equal(x.repo.openPrCount,77,'historical 21 Oct snapshot, not current open count');
 assert.equal(new Set(l.entries.map((p:any)=>p.pr)).size,138);
 assert.equal(x.mainSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.equal(x.mainCi.runId,39622251466);
 assert.equal(x.prs.length,13);
 assert.deepEqual(x.prs.map((v:any)=>v.pr),[650,652,...Array.from({length:11},(_,i)=>i+666)]);
});
test('650 and 652 exact HEAD: dedicated provider QA success does not whiten overall Windows Authenticode/ACL red',()=>{
 const x=snap(),p=rd('PR_SOURCE_AND_RELEASE_GATES.json').entries;
 const row=(n:number)=>p.find((r:any)=>r.pr===n);
 assert.equal(row(650).ci.status,'PASS');
 assert.equal(row(650).ci.runId,39629695531);
 assert.equal(row(652).ci.status,'FAIL');
 assert.equal(row(652).ci.runId,39629996191);
 assert.equal(row(652).ci.dedicatedQaRunId,39629996167);
 assert.equal(row(652).ci.dedicatedQaStatus,'PASS');
 assert.equal(x.special.qaDedicated.fullResult,'FAILURE');
 assert.equal(x.special.qaDedicated.trueFailures.length,2);
 assert.equal(row(652).production,'BLOCKED');
});
test('666 cancelled macOS is overall CI FAIL, even with six successful siblings',()=>{
 const x=snap(),m=x.special.macCancelled,l=rd('PR_SOURCE_AND_RELEASE_GATES.json').entries;
 assert.equal(m.ci,39631675531);
 assert.equal(m.jobState,'CANCELLED');
 assert.equal(m.overall,'FAILURE');
 assert.equal(m.sixOtherJobs,'SUCCESS');
 assert.equal(l.find((p:any)=>p.pr===666).ci.status,'FAIL');
});
test('667, 668, 674 exact-head Windows Job fast-exit red remains red, no 6/7 green laundering',()=>{
 const x=snap(),l=rd('PR_SOURCE_AND_RELEASE_GATES.json').entries;
 assert.deepEqual(x.special.windowsRed.map((r:any)=>[r.pr,r.runId,r.iteration]),[
  [667,39631999739,1],[668,39632010226,1],[674,39632610866,10]
 ]);
 for(const n of [667,668,674]){
  assert.equal(l.find((r:any)=>r.pr===n).ci.status,'FAIL');
  assert.equal(l.find((r:any)=>r.pr===n).production,'BLOCKED');
 }
 const r=x.special.sourceSemantic;
 assert.equal(r.pr,667);
 assert.equal(r.authorReportedOriginalQa640,'5/5 PASS');
 assert.equal(r.authorReportedOriginalQa641,'7/7 PASS');
 assert.match(r.verification,/not rerun independently/);
 assert.equal(l.find((r:any)=>r.pr===640).ci.status,'FAIL','historical original red preserved');
});
test('669-673, 675-676 source CI SUCCESS cannot be physical CORE, ACL, OAuth D1, or live external witness',()=>{
 const x=snap(),l=rd('PR_SOURCE_AND_RELEASE_GATES.json').entries;
 const ok=[669,670,671,672,673,675,676];
 assert.deepEqual(x.special.success.slice(0,7),ok);
 for(const n of ok){
  const c=x.prs.find((v:any)=>v.pr===n),r=l.find((v:any)=>v.pr===n);
  assert.ok(c);
  assert.match(c.headSha,/^[a-f0-9]{40}$/);
  assert.equal(r.headSha,c.headSha);
  assert.equal(r.ci.runId,c.runId);
  assert.equal(r.ci.status,'PASS');
  assert.equal(r.production,'BLOCKED');
 }
 assert.equal(x.securityNoGo.actualCoreHighToken,false);
 assert.equal(x.securityNoGo.realExternalRollbackIndependentCas,false);
 assert.equal(x.securityNoGo.firstPartySignedBrokerInstalled,false);
 assert.equal(x.securityNoGo.physicalOwnerUac,false);
});
test('R01-R22, 33 blocker findings and old #572 CI stay fail closed',()=>{
 const e=snap(),m=rd('cross-project-final-acceptance.json'),f=rd('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json'),l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(f.findingCount,44);
 assert.equal(f.findings.length,44);
 assert.equal(m.baselineSha,e.mainSha);
 assert.equal(m.requirements.length,22);
 assert.equal(e.priorQa.runId,39632915464);
 assert.equal(e.priorQa.result,'FAIL');
 assert.equal(l.entries.find((p:any)=>p.pr===572).ci.status,'FAIL');
 for(const k of ['R02','R04','R07','R15','R20','R22'])
  assert.equal(m.requirements.find((r:any)=>r.id===k).levels.source.status,'FAIL',k);
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
 for(const id of ['QA16-666-CANCELLED-MAC-IS-FAIL','QA16-652-WINDOWS-PROVIDER-FULL-RED','QA16-667-668-674-WINDOWS-FAST-EXIT','QA16-669-670-672-REAL-CORE-HIGH-TOKEN','QA16-675-OAUTH-D1-UNWIRED','QA16-676-CAS-EXTERNAL-NOT-DEPLOYED'])
  assert.ok(f.findings.some((r:any)=>r.id===id),id);
});
