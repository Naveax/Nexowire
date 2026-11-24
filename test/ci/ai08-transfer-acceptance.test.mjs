import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTapSummary} from '../../scripts/ci/ai08-transfer-acceptance.mjs';

const summary=(n,p,f,c,s,t,sep='\n')=>[
  'TAP version 13','1..'+n,'# tests '+n,'# suites 0','# pass '+p,
  '# fail '+f,'# cancelled '+c,'# skipped '+s,'# todo '+t
].join(sep)+sep;

test('strict transfer receipt accepts exact Linux and Windows TAP summary line endings',()=>{
  for(const sep of ['\n','\r\n']) assert.deepEqual(parseTapSummary(summary(2,2,0,0,0,0,sep)),
    {tests:2,pass:2,fail:0,cancelled:0,skipped:0,todo:0});
});
test('strict transfer receipt preserves FAIL, SKIP, CANCELLED and TODO independently',()=>{
  assert.deepEqual(parseTapSummary(summary(5,1,1,1,1,1)),
    {tests:5,pass:1,fail:1,cancelled:1,skipped:1,todo:1});
});
test('strict transfer receipt rejects missing, duplicated and contradictory summary fields',()=>{
  assert.throws(()=>parseTapSummary(summary(2,2,0,0,0,0).replace('# skipped 0\n','')),/TAP_SUMMARY_INVALID:skipped/);
  assert.throws(()=>parseTapSummary(summary(2,2,0,0,0,0)+'# pass 2\n'),/TAP_SUMMARY_INVALID:pass/);
  assert.throws(()=>parseTapSummary(summary(2,1,0,0,0,0)),/TAP_COUNT_MISMATCH/);
  assert.throws(()=>parseTapSummary(summary(2,2,0,0,0,0).replace('# pass 2','# pass 99999999999999999999')),/TAP_COUNT_INVALID/);
  assert.throws(()=>parseTapSummary('TAP version 13\nok 1 - incomplete output\n'),/TAP_SUMMARY_INVALID/);
});
