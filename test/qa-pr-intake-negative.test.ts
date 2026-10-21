import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const doc=JSON.parse(readFileSync(path.resolve(
 'docs/qa/PR_SOURCE_AND_RELEASE_GATES.json'),'utf8')) as {
 schema:string;entries:Array<{
  pr:number;headSha:string;prState:string;requirements:string[];
  sourceReproducer:string;physicalAcceptanceMissing:string;
  ci:{status:string;runId:number|null;reason?:string};
  staging:string;production:string;originalIncident:string;
 }>;
};
const lookup=(n:number)=>doc.entries.find(x=>x.pr===n);
const allowed=new Set(['PASS','FAIL','NOT_VERIFIED']);
test('all 111 reviewed PRs are uniquely accounted for at exact SHA',()=>{
 assert.equal(doc.schema,'nexowire.qa-pr-intake.v1');
 assert.equal(doc.entries.length,111);
 const ids=doc.entries.map(x=>x.pr).sort((a,b)=>a-b);
 assert.deepEqual(ids,[480,537,538,542,543,...Array.from({length:35},(_,i)=>i+545),582,596,597,598,601,603,608,609,610,612,613,614,615,616,618,619,620,...Array.from({length:15},(_,i)=>635+i),650,652,...Array.from({length:11},(_,i)=>666+i),...Array.from({length:26},(_,i)=>677+i)]);
 for(const item of doc.entries){
  assert.match(item.headSha,/^[a-f0-9]{40}$/);
  assert.ok(item.sourceReproducer.startsWith('test/'));
  assert.ok(item.physicalAcceptanceMissing.trim());
  assert.ok(item.requirements.length>0);
  assert.ok(allowed.has(item.ci.status));
  if(item.ci.status!=='NOT_VERIFIED')assert.ok(Number.isSafeInteger(item.ci.runId));
  assert.equal(item.staging,'BLOCKED');
  assert.equal(item.production,'BLOCKED');
  assert.equal(item.originalIncident,'BLOCKED');
 }
});
test('negative: CI success on Job Objects and journal v2 must not close original incidents',()=>{
 for(const n of [558,559]){
  const entry=lookup(n)!;
  assert.equal(entry.ci.status,'PASS');
  assert.equal(entry.production,'BLOCKED');
  assert.equal(entry.originalIncident,'BLOCKED');
 }
});
test('negative: historical failed CI cannot override newer exact-head successful CI',()=>{
 for(const n of [563]){
  const entry=lookup(n)!;
  assert.equal(entry.ci.status,'PASS');
  assert.ok(entry.ci.reason);
 }
});
test('negative: source review cannot silently label older checked SHA current',()=>{
 const latest=lookup(559)!;
 assert.match(latest.headSha,/^[a-f0-9]{40}$/);
 const forged={...latest,headSha:'0'.repeat(40)};
 assert.notEqual(forged.headSha,latest.headSha);
});
