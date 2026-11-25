import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';
import {reconcileLaneCoverage} from '../../scripts/ci/test-execution-coverage.mjs';
import {reviewedLanes,extractReviewedBootSource,reconcileDirectory,BOOT_FIXTURES} from '../../scripts/ci/combined-lane-coverage.mjs';
import {CORE_FIXTURES,INSTALLER_FIXTURES,RUNTIME_FIXTURES,validateGroupSource,reconcileGroupResult} from '../../scripts/ci/windows-installer-core-fixture-receipt.mjs';
const root=process.cwd();
test('actual repository inventory admits all independent policies but no missing receipt becomes PASS',()=>{
  const {entries,report}=readTestInventory(root);
  for(const platform of ['win32','linux']){
    const target={platform,nodeVersion:'v22.23.5'};
    const lanes=reviewedLanes(target);
    assert.equal(lanes.length,platform==='win32'?9:2);
    const r=reconcileLaneCoverage(entries,report,target,lanes.map(l=>l.policy),[]);
    assert.equal(r.requiredLaneAcceptance,'INCOMPLETE');
    assert.equal(r.statusCounts.NOT_RUN,entries.length);
    assert.equal(r.missingLaneIds.length,lanes.length);
    assert.ok(lanes.every(l=>l.policy.files.length>0));
  }
});
test('immutable Release Readiness boot program extraction rejects changed workflow bytes',()=>{
  const bytes=readFileSync(path.join(root,'.github/workflows/release-readiness.yml'));
  const program=extractReviewedBootSource(bytes);
  assert.match(program,/^import \{spawnSync\} from 'node:child_process'/);
  assert.match(program,/EXPLICIT_WINDOWS_SOURCE_FIXTURES_ONLY/);
  assert.throws(()=>extractReviewedBootSource(Buffer.concat([bytes,Buffer.from('\n')])),/BOOT_WORKFLOW_REVIEW_REQUIRED/);
});
test('CORE and installer source pins match checked-out bytes, skips and truncated TAP deny',()=>{
  for(const [group,plan] of [['core',CORE_FIXTURES],['installer',INSTALLER_FIXTURES],['runtime',RUNTIME_FIXTURES]]){
    for(const [file,pin] of Object.entries(plan)){
      assert.equal(validateGroupSource(group,file,{path:file,blob:pin.blob},readFileSync(path.join(root,file))),pin);
      assert.throws(()=>validateGroupSource(group,file,{path:file,blob:pin.blob},Buffer.from('wrong')),/SOURCE_REVIEW_REQUIRED/);
      assert.throws(()=>reconcileGroupResult(group,file,{status:0,stdout:'# tests 99\n# pass 99'}));
      assert.throws(()=>reconcileGroupResult(group,file,{status:0,stdout:'TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'}));
    }
  }
});
test('empty receipt directory is incomplete, not a green global CI claim',t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nx-coverage-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {entries,report}=readTestInventory(root);
  const r=reconcileDirectory(entries,report,{platform:'win32',nodeVersion:'v24.22.3'},dir);
  assert.equal(r.requiredLaneAcceptance,'INCOMPLETE');
  assert.equal(r.statusCounts.PASS,0);
  assert.equal(r.comprehensiveCoverage,false);
});

test('runtime scope has nine exact files and 37 minimum cases, no silent signed-host skip',()=>{
  assert.equal(Object.keys(RUNTIME_FIXTURES).length,9);
  assert.equal(Object.values(RUNTIME_FIXTURES).reduce((n,p)=>n+p.minimum,0),37);
  const lanes=reviewedLanes({platform:'win32',nodeVersion:'v24.22.3'});
  const runtime=lanes.find(l=>l.policy.id==='runtime');
  assert.equal(runtime.policy.scope,'REVIEWED_WINDOWS_SIGNED_RUNTIME_INSTALLER_ACL_FIXTURES_ONLY');
  assert.equal(runtime.policy.schemaVersion,2);
  assert.equal(runtime.policy.files.length,9);
  for(const [file,pin] of Object.entries(RUNTIME_FIXTURES)){
    const n=pin.minimum;
    const skip=['TAP version 13','1..'+n,'# tests '+n,'# pass '+(n-1),'# fail 0','# cancelled 0','# skipped 1','# todo 0',''].join('\n');
    assert.throws(()=>reconcileGroupResult('runtime',file,{status:0,stdout:skip}));
  }
});

test('canonical boot policy requires thirteen exact files and 68 cases',()=>{
  assert.equal(Object.keys(BOOT_FIXTURES).length,13);
  assert.equal(Object.values(BOOT_FIXTURES).reduce((n,p)=>n+p.minimum,0),68);
  assert.equal(BOOT_FIXTURES['test/hub-boot-machine-startup-admission.test.ts'].minimum,5);
});
