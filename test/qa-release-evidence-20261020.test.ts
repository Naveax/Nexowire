import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve('docs/qa');
const read=(name:string)=>JSON.parse(readFileSync(path.join(root,name),'utf8')) as any;
test('independent 2026-10-20 evidence preserves exact failing CI, source-only successes and physical P0 ACL',()=>{
 const e=read('QA_20261020_EXACT_HEAD_EVIDENCE.json');
 assert.equal(e.reviewedMainSha,'fda2a2da164ea7c6a2fe2271fc669f1fd623cede');
 assert.equal(e.evaluatedHead.pr,572);
 assert.equal(e.evaluatedHead.result,'FAIL');
 assert.equal(e.evaluatedHead.run,39284185988);
 const ref=(n:number)=>e.historicalSourceHeads.find((x:any)=>x.pr===n);
 assert.equal(ref(582).status,'FAIL');
 assert.equal(ref(597).status,'FAIL');
 assert.equal(ref(596).status,'PASS');
 assert.equal(ref(598).status,'PASS');
 assert.equal(e.actualAclReadOnly.stackAce,'NT AUTHORITY\\Authenticated Users:(I)(M)');
 assert.equal(e.actualAclReadOnly.cliAce,'NT AUTHORITY\\Authenticated Users:(I)(M)');
 assert.equal(e.actualAclReadOnly.protectedBroker.status,'UNKNOWN_DENIED');
 assert.equal(e.actualAclReadOnly.protectedBroker.icaclsExitCode,5);
 assert.equal(e.production,'BLOCKED');
 assert.equal(e.originalIncident,'BLOCKED');
});
test('unresolved source negative tests never elevate staged or production acceptance',()=>{
 const m=read('cross-project-final-acceptance.json');
 const prs=read('PR_SOURCE_AND_RELEASE_GATES.json');
 for(const key of ['R02','R04','R07','R15','R20','R22']){
  const item=m.requirements.find((x:any)=>x.id===key);
  assert.equal(item.levels.source.status,'FAIL',key);
 }
 assert.equal(prs.entries.find((x:any)=>x.pr===582).ci.status,'FAIL');
 assert.equal(prs.entries.find((x:any)=>x.pr===597).ci.status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===598).ci.status,'FAIL');
 const old=read('QA_20261020_EXACT_HEAD_EVIDENCE.json');
 assert.equal(old.historicalSourceHeads.find((x:any)=>x.pr===597).status,'FAIL');
 assert.equal(old.historicalSourceHeads.find((x:any)=>x.pr===598).status,'PASS');
 assert.equal(prs.entries.find((x:any)=>x.pr===598).production,'BLOCKED');
 assert.ok(m.requirements.every((x:any)=>['staging','production','incident'].every(k=>x.levels[k].status==='BLOCKED')));
});
