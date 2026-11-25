import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REVIEWED_STORAGE_FIXTURES,validateFixtureSource,reconcileFixtureResult}
  from '../../scripts/ci/windows-storage-fixture-receipt.mjs';
const paths=Object.keys(REVIEWED_STORAGE_FIXTURES);
const first=paths[0];
const tap=(n=12,skip=0)=>[
  'TAP version 13', '1..'+n,'# tests '+n,
  '# pass '+(n-skip),'# fail 0','# cancelled 0','# skipped '+skip,'# todo 0','',
].join('\n');

test('exactly seven reviewed Windows storage/recovery files with independently reviewed blob pins',()=>{
  assert.equal(paths.length,7);
  assert.equal(paths.reduce((n,p)=>n+REVIEWED_STORAGE_FIXTURES[p].minimum,0),29);
  for(const p of paths){
    const pin=REVIEWED_STORAGE_FIXTURES[p];
    assert.match(pin.blob,/^[0-9a-f]{40}$/,p);
    const bytes=readFileSync(new URL('../../'+p,import.meta.url));
    assert.equal(validateFixtureSource(p,{path:p,blob:pin.blob},bytes),pin,p);
  }
});
test('unreviewed path, mismatched Git identity and worktree substitutions are rejected',()=>{
  assert.throws(()=>validateFixtureSource('test/unreviewed.test.ts',{},Buffer.alloc(0)),/UNREVIEWED_PATH/);
  const pin=REVIEWED_STORAGE_FIXTURES[first];
  const bytes=readFileSync(new URL('../../'+first,import.meta.url));
  assert.throws(()=>validateFixtureSource(first,{path:first,blob:'0'.repeat(40)},bytes),/SOURCE_REVIEW_REQUIRED/);
  assert.throws(()=>validateFixtureSource(first,{path:first,blob:pin.blob},Buffer.from('changed')),/WORKTREE_BLOB_MISMATCH/);
});
test('a positive complete TAP receipt is required for each reviewed file',()=>{
  const r=reconcileFixtureResult(first,{status:0,signal:null,stdout:tap()});
  assert.equal(r.result,'PASS');
  assert.equal(r.pass,12);
  assert.equal(r.gitBlobSha,REVIEWED_STORAGE_FIXTURES[first].blob);
  for(const result of [
    {status:1,stdout:tap()},
    {status:0,error:{code:'ETIMEDOUT'},stdout:tap()},
    {status:0,signal:'SIGTERM',stdout:tap()},
    {status:0,stdout:tap(11)},
    {status:0,stdout:tap(12,1)},
    {status:0,stdout:'# tests 12\n# pass 12'},
  ])assert.throws(()=>reconcileFixtureResult(first,result));
});
