/** #11 synthetic log parser tests; no Windows token/physical acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {assessWindowsJobMsvcLog} from '../scripts/qa-windows-job-msvc-log.js';

const observed=String.raw`windows-job-medium-dup-probe.c
D:\\a\\Nexowire\\Nexowire\\test\\fixtures\\windows-job-medium-dup-probe.c(85): warning C4133: 'function': incompatible types - from 'char [17]' to 'LPCWSTR'
Windows Job helper built.`;

test('the observed C4133 fixture warning fails rather than reporting green',()=>{
  const r=assessWindowsJobMsvcLog(observed);
  assert.deepEqual(r,{ok:false,reason:'PROBE_C4133_INCOMPATIBLE_POINTER',physicalAcceptance:'NOT_PROVEN'});
});

test('a compiled fixture without this warning gives only a source-log result',()=>{
  const r=assessWindowsJobMsvcLog('windows-job-owner.c\r\n'+
    "windows-job-owner.c(30): warning C4189: unused\r\n"+
    'windows-job-medium-dup-probe.c\r\nWindows Job helper built.\r\n');
  assert.equal(r.ok,true);
  assert.equal(r.physicalAcceptance,'NOT_PROVEN');
});

test('missing fixture compile, malformed or oversized log fail closed',()=>{
  for(const value of ['',null,'x'.repeat(2*1024*1024+1)]){
    const r=assessWindowsJobMsvcLog(value);
    assert.equal(r.ok,false);
    assert.equal(r.physicalAcceptance,'NOT_PROVEN');
  }
});

test('column and error variants of the fixture C4133 diagnostic are rejected',()=>{
  const r=assessWindowsJobMsvcLog(
    'windows-job-medium-dup-probe.c\nC:\\\\p\\\\windows-job-medium-dup-probe.c(85,3): error C4133: incompatible\n');
  assert.equal(r.reason,'PROBE_C4133_INCOMPATIBLE_POINTER');
});

test('a similar warning from another source is not misattributed to the fixture',()=>{
  const r=assessWindowsJobMsvcLog(
    'windows-job-medium-dup-probe.c\nother.c(85): warning C4133: incompatible\n');
  assert.equal(r.ok,true);
  assert.equal(r.physicalAcceptance,'NOT_PROVEN');
});
