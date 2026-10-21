import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(n:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',n),'utf8').replace(/^\uFEFF/,'')) as any;
test('exact main and 27 literal PR heads #703-#729, 17 success 9 full failures and changing #721 pending',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json'),l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 assert.equal(e.main.head,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.equal(e.prs.length,27);
 assert.deepEqual(e.prs.map((x:any)=>x.number),Array.from({length:27},(_,i)=>i+703));
 assert.equal(l.entries.length,138);
 assert.equal(new Set(l.entries.map((x:any)=>x.pr)).size,138);
 assert.deepEqual(e.prs.reduce((r:any,x:any)=>(r[x.status]=(r[x.status]||0)+1,r),{}),{PASS:17,FAIL:9,PENDING:1});
 for(const x of e.prs){
  assert.match(x.headSha,/^[0-9a-f]{40}$/);
  assert.match(x.baseSha,/^[0-9a-f]{40}$/);
  const y=l.entries.find((p:any)=>p.pr===x.number);
  assert.equal(y.headSha,x.headSha);
  assert.equal(y.production,'BLOCKED');
  assert.equal(y.ci.status,x.status==='PENDING'?'NOT_VERIFIED':x.status);
 }
});
test('#729 seven deliberately failing P0 source gates are nonoptional and not suppressed',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json');
 const v=e.qa729;
 assert.equal(v.ciRunId,39662119627);
 assert.equal(v.conclusion,'FAILURE');
 const gate=v.classifications.purposefullyFailingAcceptance;
 assert.equal(gate.jobId,119437584894);
 assert.equal(gate.status,'FAIL');
 assert.deepEqual(gate.tests,{passed:10,failed:7,skipped:0});
 assert.ok(gate.cases.some((s:string)=>s.includes('HIGH')));
 assert.ok(gate.cases.some((s:string)=>s.includes('#587')));
 assert.ok(gate.cases.some((s:string)=>s.includes('#588')));
 assert.ok(gate.cases.some((s:string)=>s.includes('Hyper-V')));
});
test('#729 Windows durable READY timeout is separate from seven required red product tests',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json');
 const other=e.qa729.classifications.ordinaryCodeOrHostFailures;
 assert.ok(other.some((j:any)=>j.jobId===119437584585&&j.status==='FAIL'&&j.reason.includes('NW_DURABLE_READY')));
 assert.ok(other.some((j:any)=>j.jobId===119437584597&&j.status==='FAIL'));
 assert.ok(other.some((j:any)=>j.jobId===119437584672&&j.status==='CANCELLED'));
 assert.equal(e.prs.find((x:any)=>x.number===729).status,'FAIL');
});
test('#704 semantic cancel/ACK red, #705 and #717 protected import-ACL red despite separate green QA',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json');
 for(const n of [704,705,717])assert.equal(e.prs.find((x:any)=>x.number===n).status,'FAIL');
 assert.match(e.prs.find((x:any)=>x.number===704).description,/[Tt]wo REAL Node24/);
 assert.match(e.prs.find((x:any)=>x.number===705).description,/dedicated run/);
 assert.match(e.prs.find((x:any)=>x.number===717).description,/separate QA19/);
 assert.equal(e.prs.find((x:any)=>x.number===725).status,'PASS');
});
test('#721 exact SHA queued, no historical 17/10 branch result laundering',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json');
 const p=e.prs.find((x:any)=>x.number===721);
 assert.equal(p.headSha,'aa16d3e0fc2627960be9a51ad7bba30f0e9ac87d');
 assert.equal(p.runId,39676732876);
 assert.equal(p.status,'PENDING');
 assert.equal(e.currentFullCi.pending,1);
 assert.match(e.currentFullCi.oldCount,/17 success and 10 failure/);
});
test('P0 physical CORE, 271 ACL, 551 signed bootstrap, 587 rollback witness and R01-R22 all blocked',()=>{
 const e=rd('QA_20261022_PR703_729_EXACT_HEAD.json');
 const m=rd('cross-project-final-acceptance.json'),f=rd('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json');
 assert.equal(f.findingCount,44);
 assert.equal(m.requirements.length,22);
 assert.equal(m.baselineSha,e.main.head);
 for(const id of ['QA16-729-PURPOSEFUL-P0-RED','QA16-729-INDEPENDENT-DURABLE-CI','QA16-704-CANCEL-PROVENANCE-RED','QA16-705-717-IMPORT-ACL-RED','QA16-721-HEAD-MOVED-CI-UNKNOWN'])
  assert.ok(f.findings.some((x:any)=>x.id===id));
 for(const id of ['R02','R04','R07','R15','R20','R22'])
  assert.equal(m.requirements.find((x:any)=>x.id===id).levels.source.status,'FAIL');
 assert.equal(e.sourceNoGo.realCoreHighToken,false);
 assert.equal(e.sourceNoGo.protectedAcl271,false);
 assert.equal(e.sourceNoGo.firstPartySignedBootstrap551,false);
 assert.equal(e.sourceNoGo.externalNonRestorableWitness587,false);
 assert.ok(m.requirements.every((x:any)=>['staging','production','incident'].every(k=>x.levels[k].status==='BLOCKED')));
});
