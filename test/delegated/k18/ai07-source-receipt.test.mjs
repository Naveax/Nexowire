import test from 'node:test';
import assert from 'node:assert/strict';
import {gitBlob,exactTap,acceptChild} from './ai07-source-receipt.mjs';
const valid='# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('exact counts accept only the reviewed complete suite',()=>{
  assert.deepEqual(exactTap(valid,5),{tests:5,pass:5,fail:0,cancelled:0,skipped:0,todo:0});
  assert.throws(()=>exactTap(valid,4));
  assert.throws(()=>exactTap(valid,8));
});
test('missing or duplicate footer is rejected',()=>{
  assert.throws(()=>exactTap(valid.replace('# todo 0\n',''),5));
  assert.throws(()=>exactTap(valid+'# pass 5\n',5));
});
test('failed, cancelled, skipped and todo results are rejected',()=>{
  for(const key of ['fail','cancelled','skipped','todo'])assert.throws(()=>exactTap(valid.replace('# '+key+' 0','# '+key+' 1'),5));
});
test('bad numeric counts and zero expected counts are rejected',()=>{
  assert.throws(()=>exactTap(valid.replace('# tests 5','# tests 9007199254740992'),5));
  assert.throws(()=>exactTap(valid,0));
});
test('good footer cannot override nonzero exit, timeout or signal',()=>{
  assert.throws(()=>acceptChild({status:1,stdout:valid},5));
  assert.throws(()=>acceptChild({status:null,error:Error('timeout'),stdout:valid},5));
  assert.throws(()=>acceptChild({status:null,signal:'SIGTERM',stdout:valid},5));
  assert.equal(acceptChild({status:0,signal:null,stdout:valid},5).pass,5);
});
test('Git blob identity depends on raw bytes, including final newline',()=>{
  assert.equal(gitBlob(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.notEqual(gitBlob(Buffer.from('abc')),gitBlob(Buffer.from('abc\n')));
});
