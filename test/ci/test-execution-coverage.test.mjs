import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';
import {reconcileCoverage} from '../../scripts/ci/test-execution-coverage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {entries,report}=readTestInventory(root);
const subset=entries.slice(0,3);
const receipt=()=>({
  schemaVersion:1, sourceCommitSha:report.commitSha,
  sourceManifestSha256:report.manifestSha256,
  scope:'ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES',
  physicalWindowsAcceptance:'NOT_INFERRED',
  executedFileCount:subset.length,testsPassed:subset.length,
  fail:0,skipped:0,todo:0,cancelled:0,
  files:subset.map(e=>({path:e.path,gitBlobSha:e.blob,tests:1,pass:1,
    fail:0,skipped:0,todo:0,cancelled:0,result:'PASS'})),
});
test('exact manifest and blob reconciliation explicitly counts NOT_RUN',()=>{
  const result=reconcileCoverage(entries,report,receipt());
  assert.equal(result.trackedFileCount,entries.length);
  assert.equal(result.executedFileCount,3);
  assert.equal(result.notRunFileCount,entries.length-3);
  assert.equal(result.comprehensiveCoverage,false);
  assert.equal(result.physicalWindowsAcceptance,'NOT_INFERRED');
});
test('rejects wrong source SHA, manifest and Git blob',()=>{
  for(const key of ['sourceCommitSha','sourceManifestSha256']) {
    const r=receipt();r[key]='0'.repeat(key==='sourceCommitSha'?40:64);
    assert.throws(()=>reconcileCoverage(entries,report,r),/TEST_COVERAGE_SOURCE_MISMATCH/);
  }
  const r=receipt();r.files[0].gitBlobSha='0'.repeat(40);
  assert.throws(()=>reconcileCoverage(entries,report,r),/TEST_COVERAGE_FILE_NOT_BOUND_TO_SOURCE/);
});
test('rejects duplicate and untracked test file evidence',()=>{
  const r=receipt();r.files[1]={...r.files[0]};
  assert.throws(()=>reconcileCoverage(entries,report,r),/TEST_COVERAGE_FILE_NOT_BOUND_TO_SOURCE/);
  const other=receipt();other.files[0].path='test/untracked.test.ts';
  assert.throws(()=>reconcileCoverage(entries,report,other),/TEST_COVERAGE_FILE_NOT_BOUND_TO_SOURCE/);
});
test('rejects skipped, failed, ambiguous or inconsistent counters',()=>{
  for (const mutate of [
    r=>{r.files[0].skipped=1},r=>{r.files[0].result='SKIP'},
    r=>{r.files[0].pass=0},r=>{r.testsPassed++},
    r=>{r.executedFileCount++},r=>{r.scope='ALL_TESTS'},
    r=>{r.physicalWindowsAcceptance='PASS'}
  ]) {
    const r=receipt(); mutate(r);
    assert.throws(()=>reconcileCoverage(entries,report,r),/TEST_COVERAGE_/);
  }
});
test('rejects source inventory inconsistencies',()=>{
  const r=receipt();
  assert.throws(()=>reconcileCoverage(entries,{...report,trackedTsTestFiles:1},r),
    /TEST_COVERAGE_INVALID_RECEIPT/);
  assert.throws(()=>reconcileCoverage([...entries,entries[0]],
    {...report,trackedTsTestFiles:entries.length+1},r),
    /TEST_COVERAGE_INVALID_INVENTORY/);
});
