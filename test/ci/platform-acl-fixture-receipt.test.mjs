import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MIXED_FILE,MIXED_CASES,PLATFORM_FIXTURES,expectedMixedStates,
  reconcileMixedTap,reconcilePlatformResult,verifyPlatformFixtureBytes}
  from '../../scripts/ci/platform-acl-fixture-receipt.mjs';
const tap=platform=>{
  const cases=expectedMixedStates(platform);
  const skip=cases.filter(c=>c.result==='SKIP').length;
  return ['TAP version 13',...cases.map((c,i)=>
    'ok '+(i+1)+' - '+c.name+(c.result==='SKIP'?' # SKIP':'')),
    '1..6','# tests 6','# pass '+(6-skip),'# fail 0','# cancelled 0',
    '# skipped '+skip,'# todo 0',''].join('\n');
};
test('all exact platform fixture pins match complete checked-out bytes',()=>{
  assert.equal(Object.keys(PLATFORM_FIXTURES.win32).length,5);
  assert.equal(Object.keys(PLATFORM_FIXTURES.linux).length,2);
  for(const [platform,plan] of Object.entries(PLATFORM_FIXTURES))
    for(const [file,pin] of Object.entries(plan)){
      assert.match(pin.blob,/^[0-9a-f]{40}$/,file);
      const bytes=readFileSync(new URL('../../'+file,import.meta.url));
      assert.doesNotThrow(()=>verifyPlatformFixtureBytes(file,{path:file,blob:pin.blob},bytes,platform));
      assert.throws(()=>verifyPlatformFixtureBytes(file,{path:file,blob:pin.blob},Buffer.from('changed'),platform),/WORKTREE_BLOB_MISMATCH/);
    }
});
test('mixed platform cases retain real SKIP without laundering it to full file PASS',()=>{
  for(const platform of ['win32','linux']){
    const r=reconcilePlatformResult(MIXED_FILE,{status:0,signal:null,stdout:tap(platform)},platform);
    assert.equal(r.result,'SKIP');
    assert.equal(r.pass,platform==='win32'?5:4);
    assert.equal(r.skipped,platform==='win32'?1:2);
    assert.equal(r.caseStates.length,6);
  }
  for(let i=0;i<6;i++)assert.ok(['win32','linux'].some(p=>expectedMixedStates(p)[i].result==='PASS'));
});
test('wrong platform skip, substituted case, forged plan or summary, partial TAP and failures deny',()=>{
  const original=tap('win32');
  for(const bad of [
    tap('linux'),original.replace(MIXED_CASES[0], 'forged case'),
    original.replace('1..6','1..5'),original.replace('# pass 5','# pass 6'),
    original.replace(' # SKIP',' # TODO'),original.replace('ok 1 -','not ok 1 -'),
    original+'# pass 5\n',original.split('# tests')[0],
  ])assert.throws(()=>reconcileMixedTap(bad,'win32'),/PLATFORM_ACL_FIXTURE_/);
  assert.throws(()=>reconcilePlatformResult(MIXED_FILE,{status:0,error:{code:'ETIMEDOUT'},stdout:original},'win32'),/PROCESS_FAILED/);
  assert.throws(()=>reconcilePlatformResult('test/guardian-sqlite-sidecar-preflight.test.ts',{status:0,stdout:original},'win32'),/UNREVIEWED_PATH/);
});

test('Windows listener fixture requires all four reviewed cases without a platform skip',()=>{
  const file='test/windows-local-listener-owner.test.ts';
  assert.equal(PLATFORM_FIXTURES.win32[file].minimum,4);
  assert.equal(Object.hasOwn(PLATFORM_FIXTURES.linux,file),false);
  const summary=(n,skip=0)=>['TAP version 13','1..'+n,'# tests '+n,
    '# pass '+(n-skip),'# fail 0','# cancelled 0','# skipped '+skip,'# todo 0',''].join('\n');
  const result=stdout=>({status:0,signal:null,stdout});
  assert.throws(()=>reconcilePlatformResult(file,result(summary(3)),'win32'));
  assert.throws(()=>reconcilePlatformResult(file,result(summary(4,1)),'win32'));
  assert.equal(reconcilePlatformResult(file,result(summary(4)),'win32').pass,4);
});
