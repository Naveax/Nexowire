import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REVIEWED_AUTHORITY_LEDGER_FIXTURES,validateFixtureSource,reconcileFixtureResult,
  collectReviewedFixtureOutcomes,summarizeReviewedFixtureOutcomes}
  from '../../scripts/ci/windows-authority-ledger-fixture-receipt.mjs';
const paths=Object.keys(REVIEWED_AUTHORITY_LEDGER_FIXTURES);
const first='test/guardian-sqlite-replay-ledger.test.ts';
const tap=(n=14,skip=0)=>[
  'TAP version 13', '1..'+n,'# tests '+n,
  '# pass '+(n-skip),'# fail 0','# cancelled 0','# skipped '+skip,'# todo 0','',
].join('\n');

test('exactly seven reviewed Windows authority and ledger files with independently reviewed blob pins',()=>{
  assert.equal(paths.length,7);
  assert.equal(paths.reduce((n,p)=>n+REVIEWED_AUTHORITY_LEDGER_FIXTURES[p].minimum,0),39);
  for(const p of paths){
    const pin=REVIEWED_AUTHORITY_LEDGER_FIXTURES[p];
    assert.match(pin.blob,/^[0-9a-f]{40}$/,p);
    const bytes=readFileSync(new URL('../../'+p,import.meta.url));
    assert.equal(validateFixtureSource(p,{path:p,blob:pin.blob},bytes),pin,p);
  }
});
test('unreviewed path, mismatched Git identity and worktree substitutions are rejected',()=>{
  assert.throws(()=>validateFixtureSource('test/unreviewed.test.ts',{},Buffer.alloc(0)),/UNREVIEWED_PATH/);
  const pin=REVIEWED_AUTHORITY_LEDGER_FIXTURES[first];
  const bytes=readFileSync(new URL('../../'+first,import.meta.url));
  assert.throws(()=>validateFixtureSource(first,{path:first,blob:'0'.repeat(40)},bytes),/SOURCE_REVIEW_REQUIRED/);
  assert.throws(()=>validateFixtureSource(first,{path:first,blob:pin.blob},Buffer.from('changed')),/WORKTREE_BLOB_MISMATCH/);
});
test('a positive complete TAP receipt is required for each reviewed file',()=>{
  const r=reconcileFixtureResult(first,{status:0,signal:null,stdout:tap()});
  assert.equal(r.result,'PASS');
  assert.equal(r.pass,14);
  assert.equal(r.gitBlobSha,REVIEWED_AUTHORITY_LEDGER_FIXTURES[first].blob);
  for(const result of [
    {status:1,stdout:tap()},
    {status:0,error:{code:'ETIMEDOUT'},stdout:tap()},
    {status:0,signal:'SIGTERM',stdout:tap()},
    {status:0,stdout:tap(13)},
    {status:0,stdout:tap(14,1)},
    {status:0,stdout:'# tests 14\n# pass 14'},
  ])assert.throws(()=>reconcileFixtureResult(first,result));
});

test('a failed child never prevents later independently reviewed fixtures and remains a failing receipt',()=>{
  const checked=[],ran=[];
  const bad='test/privileged-broker-health.test.ts';
  const files=collectReviewedFixtureOutcomes(p=>checked.push(p),p=>{
    ran.push(p);
    const n=REVIEWED_AUTHORITY_LEDGER_FIXTURES[p].minimum;
    return {elapsedMs:15,result:{status:p===bad?1:0,signal:null,stdout:tap(n)}};
  });
  assert.deepEqual(checked,[...paths,...paths]);
  assert.deepEqual(ran,paths);
  assert.equal(files.find(f=>f.path===bad).result,'FAIL');
  assert.equal(files.find(f=>f.path===bad).pass,undefined);
  assert.equal(files.at(-1).result,'PASS');
  const summary=summarizeReviewedFixtureOutcomes(files,654);
  assert.equal(summary.acceptance,'FAIL');
  assert.deepEqual(summary.statusCounts,{PASS:6,FAIL:1,SKIP:0,NOT_RUN:647});
  assert.equal(summary.passedAssertions,38);
  assert.throws(()=>summarizeReviewedFixtureOutcomes(files.slice(0,-1),654),/INVALID_OUTCOME_SET/);
  const forged=files.map(f=>f.path===bad?{...f,result:'PASS'}:f);
  assert.throws(()=>summarizeReviewedFixtureOutcomes(forged,654),/INVALID_PASS_COUNTERS/);
});
test('source admission failures abort before unreviewed work starts',()=>{
  let runs=0;
  assert.throws(()=>collectReviewedFixtureOutcomes(p=>{
    if(p===paths.at(-1))throw Error('SOURCE_CHANGED');
  },()=>{runs++;return {result:{status:0,stdout:tap()},elapsedMs:0};}),/SOURCE_CHANGED/);
  assert.equal(runs,0);
});
