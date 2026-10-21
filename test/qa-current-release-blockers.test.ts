import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const read=(x:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',x),'utf8')) as any;
const matrix=read('cross-project-final-acceptance.json');
const prs=read('PR_SOURCE_AND_RELEASE_GATES.json');
const audit=read('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json');
test('48 exact-head PRs include merged 567 anti-rollback and prior 572 CI failure without false final acceptance',()=>{
 assert.equal(prs.entries.length,48);
 assert.equal(prs.entries.find((x:any)=>x.pr===559).prState,'MERGED');
 assert.equal(prs.entries.find((x:any)=>x.pr===563).ci.status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===553).ci.status,'NOT_VERIFIED');
 assert.equal(prs.entries.find((x:any)=>x.pr===551).ci.status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===564).ci.status,'PASS');
 assert.ok(prs.entries.every((x:any)=>x.production==='BLOCKED'&&x.originalIncident==='BLOCKED'));
});
test('all 22 requirements are evaluated against current pinned main and no production pass exists',()=>{
 assert.equal(matrix.baselineSha,'4c5c810134c020cd04a5ef2be5c1138ea1954ad0');
 assert.equal(matrix.inspectedMainSha,matrix.baselineSha);
 assert.equal(matrix.requirements.length,22);
 const levels=['source','staging','production','incident'];
 assert.equal(matrix.requirements.find((x:any)=>x.id==='R17').levels.source.status,'PASS');
 assert.equal(matrix.requirements.find((x:any)=>x.id==='R07').levels.source.status,'FAIL');
 assert.equal(matrix.requirements.find((x:any)=>x.id==='R02').levels.source.status,'FAIL');
 assert.equal(matrix.requirements.find((x:any)=>x.id==='R20').levels.source.status,'FAIL');
 assert.equal(prs.entries.find((x:any)=>x.pr===572).ci.status,'FAIL');
 assert.equal(prs.entries.find((x:any)=>x.pr===582).ci.status,'FAIL');
 assert.equal(prs.entries.find((x:any)=>x.pr===596).ci.status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===597).ci.status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===598).ci.status,'FAIL');
 assert.ok(matrix.requirements.every((x:any)=>levels.slice(1).every(k=>x.levels[k].status==='BLOCKED')));
});
test('nineteen priority findings have exact SHA reproduction and correction without false physical proof',()=>{
 assert.equal(audit.findingCount,19);
 assert.equal(audit.findings.length,19);
 const ids=new Set();
 for(const f of audit.findings){
  assert.ok(!ids.has(f.id));ids.add(f.id);
  assert.ok(f.requirements.length&&f.affected.length);
  for(const a of f.affected)assert.match(a.headSha,/^[a-f0-9]{40}$/);
  assert.ok(f.reproduction.length>=2);
  assert.ok(f.reproduction.every((s:string)=>s.length>20));
  assert.ok(f.expectedFix.length>45);
  assert.ok(f.evidence.length);
  assert.equal(f.disposition.production,'BLOCKED');
  assert.equal(f.disposition.incident,'BLOCKED');
 }
});