import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REVIEWED_CROSS_OWNER_FIXTURES,validateFixtureSource,reconcileFixtureResult,
  collectReviewedFixtureOutcomes,summarizeReviewedFixtureOutcomes}
  from '../../scripts/ci/windows-cross-owner-fixture-receipt.mjs';
const paths=Object.keys(REVIEWED_CROSS_OWNER_FIXTURES);
const tap=(n,skip=0)=>['TAP version 13','1..'+n,'# tests '+n,
  '# pass '+(n-skip),'# fail 0','# cancelled 0','# skipped '+skip,'# todo 0',''].join('\n');
const result=(file,status=0)=>({status,signal:null,stdout:tap(REVIEWED_CROSS_OWNER_FIXTURES[file].minimum)});
test('exact nine cross-owner fixtures match reviewed Git bytes and bounded deadlines',()=>{
  assert.equal(paths.length,9);
  assert.equal(paths.reduce((n,p)=>n+REVIEWED_CROSS_OWNER_FIXTURES[p].minimum,0),44);
  for(const file of paths){
    const p=REVIEWED_CROSS_OWNER_FIXTURES[file];
    assert.match(p.blob,/^[a-f0-9]{40}$/,file);
    assert.equal(validateFixtureSource(file,{path:file,blob:p.blob},readFileSync(new URL('../../'+file,import.meta.url))),p);
    assert.ok([180000,300000,360000].includes(p.timeoutMs));
    assert.throws(()=>validateFixtureSource(file,{path:file,blob:p.blob},Buffer.from('changed')),/WORKTREE_BLOB_MISMATCH/);
  }
  assert.equal(REVIEWED_CROSS_OWNER_FIXTURES['test/ai03/system-dpapi-acceptance.test.ts'].timeoutMs,360000);
  assert.equal(REVIEWED_CROSS_OWNER_FIXTURES['test/ai05/system-stage-plan-windows.test.ts'].timeoutMs,300000);
});
test('missing prerequisite or conditional skip cannot create complete file PASS',()=>{
  const file='test/ai05/system-stage-plan-windows.test.ts';
  for(const r of [{status:0,stdout:tap(2,1)},{status:0,stdout:tap(1)},
    {status:1,stdout:tap(2)},{status:0,error:{code:'ETIMEDOUT'},stdout:tap(2)},
    {status:0,stdout:'# tests 2\n# pass 2'}])
    assert.throws(()=>reconcileFixtureResult(file,r));
});
test('independent execution continues, failed files remain FAIL, counters are never fabricated',()=>{
  const first=paths[0],ran=[];
  const files=collectReviewedFixtureOutcomes(()=>{},p=>{
    ran.push(p);return {elapsedMs:10,result:result(p,p===first?1:0)};
  });
  assert.deepEqual(ran,paths);
  assert.equal(files[0].result,'FAIL');
  assert.equal(files[0].pass,undefined);
  assert.equal(files.at(-1).result,'PASS');
  const r=summarizeReviewedFixtureOutcomes(files,672);
  assert.equal(r.acceptance,'FAIL');
  assert.deepEqual(r.statusCounts,{PASS:8,FAIL:1,SKIP:0,NOT_RUN:663});
  assert.equal(r.passedAssertions,40);
  assert.throws(()=>summarizeReviewedFixtureOutcomes(files.slice(1),672),/INVALID_OUTCOME_SET/);
});
test('all source admission checks precede fixture execution',()=>{
  let invoked=0;
  assert.throws(()=>collectReviewedFixtureOutcomes(p=>{
    if(p===paths.at(-1))throw Error('SOURCE_REVIEW_REQUIRED');
  },p=>{invoked++;return {elapsedMs:0,result:result(p)};}),/SOURCE_REVIEW_REQUIRED/);
  assert.equal(invoked,0);
});
