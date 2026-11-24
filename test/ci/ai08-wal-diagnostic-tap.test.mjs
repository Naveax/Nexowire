import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DIAGNOSTIC_TITLES,NAMED_SKIP,assertWindowsDiagnosticTap} from '../../scripts/ci/ai08-wal-diagnostic-tap.mjs';
import {assertTapSummary} from '../../scripts/ci/assert-tap-summary.mjs';
const tap=()=>['TAP version 13',...DIAGNOSTIC_TITLES.map((title,i)=>'ok '+(i+1)+' - '+title+(i===5?' # SKIP':'')),'1..10','# tests 10','# suites 0','# pass 9','# fail 0','# cancelled 0','# skipped 1','# todo 0',''].join('\n');
test('diagnostic policy matches exact fixture and permits only historical symlink skip',()=>{
 const bytes=readFileSync('test/native-agent-startup-diagnostic.test.ts');
 assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),'4a9095dad4232313df8504071a1de1f557668a8c');
 assert.deepEqual([...bytes.toString().matchAll(/^test\('([^']+)'/gm)].map(m=>m[1]),DIAGNOSTIC_TITLES);
 assert.equal([...bytes.toString().matchAll(/skip:/g)].length,1);
 for(const t of [tap(),tap().replaceAll('\n','\r\n')]){
  const r=assertWindowsDiagnosticTap(t);
  assert.equal(r.counts.pass,9);
  assert.deepEqual(r.expectedSkippedCases,[NAMED_SKIP]);
  assert.deepEqual(r.passedCases.slice(-3),DIAGNOSTIC_TITLES.slice(-3));
  assert.throws(()=>assertTapSummary(t,10));
 }
});
test('diagnostic parser denies wrong skip, fake counts, duplicate, partial or changed case',()=>{
 const t=tap();
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace(NAMED_SKIP+' # SKIP',NAMED_SKIP).replace(DIAGNOSTIC_TITLES[9],DIAGNOSTIC_TITLES[9]+' # SKIP')),/CASE_MISMATCH/);
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace('# pass 9','# pass 10')),/SUMMARY_MISMATCH/);
 assert.throws(()=>assertWindowsDiagnosticTap(t+t),/DUPLICATE/);
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace('# todo 0','')),/SUMMARY_MISMATCH/);
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace('1..10','1..9')),/TAP_STRUCTURE/);
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace(DIAGNOSTIC_TITLES[7],'fake instability check')),/CASE_MISMATCH/);
 assert.throws(()=>assertWindowsDiagnosticTap(t.replace('ok 9 -','not ok 9 -')),/CASE_MISMATCH/);
});
