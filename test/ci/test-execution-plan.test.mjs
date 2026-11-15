import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {readTestInventory,summarizeTestFiles} from '../../scripts/ci/test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES} from '../../scripts/ci/portable-root-execution-receipt.mjs';
import {createTestExecutionPlan} from '../../scripts/ci/test-execution-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const script=path.join(root,'scripts/ci/test-execution-plan.mjs');
const {entries,report}=readTestInventory(root);
function invoke(args,expected=report.commitSha) {
  const env={...process.env,NEXOWIRE_EXPECTED_COMMIT_SHA:expected};
  return spawnSync(process.execPath,[script,...args],{
    cwd:root,env,encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
  });
}
test('only explicitly reviewed portable tests are split into bounded deterministic shards',()=>{
  const p=createTestExecutionPlan(entries,report,2);
  assert.equal(p.trackedFileCount,entries.length);
  assert.equal(p.reviewedPortableFileCount,APPROVED_ROOT_TEST_FILES.length);
  assert.equal(p.notReviewedFileCount,entries.length-APPROVED_ROOT_TEST_FILES.length);
  assert.equal(p.notReviewedFiles.length,p.notReviewedFileCount);
  assert.equal(p.allTrackedFilesApproved,false);
  assert.equal(p.executionPerformed,false);
  assert.equal(p.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.equal(p.executionCoverage,'NOT_MEASURED');
  assert.deepEqual(
    p.reviewedPortableShards.flatMap(s=>s.files.map(f=>f.path)).sort(),
    [...APPROVED_ROOT_TEST_FILES].sort());
  assert.equal(JSON.stringify(p),JSON.stringify(createTestExecutionPlan(entries,report,2)));
});
test('every unreviewed file remains quarantined from reviewed shards',()=>{
  const p=createTestExecutionPlan(entries,report,3);
  const reviewed=new Set(p.reviewedPortableShards.flatMap(g=>g.files.map(f=>f.path)));
  const unreviewed=new Set(p.notReviewedFiles.map(f=>f.path));
  assert.equal(reviewed.size,APPROVED_ROOT_TEST_FILES.length);
  assert.equal(unreviewed.size,entries.length-APPROVED_ROOT_TEST_FILES.length);
  for(const e of entries) {
    assert.notEqual(reviewed.has(e.path),unreviewed.has(e.path));
  }
  for(const e of p.notReviewedFiles) assert.equal(e.reviewStatus,'NOT_REVIEWED_NO_EXECUTION');
});
test('refuses untrusted source, mutated blob or manifest',()=>{
  for(const inv of [
    {...report,commitSha:'bad-sha'},
    {...report,manifestSha256:'0'.repeat(64)},
    {...report,trackedTsTestFiles:entries.length+1},
  ]) assert.throws(()=>createTestExecutionPlan(entries,inv),/TEST_EXECUTION_PLAN_/);
  const changed=entries.map(e=>({...e}));
  changed[0].blob='0'.repeat(40);
  assert.throws(()=>createTestExecutionPlan(changed,report),/SOURCE_MANIFEST_MISMATCH/);
  const repeated=[...entries,entries[0]];
  assert.throws(()=>createTestExecutionPlan(repeated,{...report,trackedTsTestFiles:repeated.length}),
    /TEST_EXECUTION_PLAN_/);
});
test('an approved filename with changed Git blob is no longer approved',()=>{
  const changed=entries.map(e=>({...e}));
  const index=changed.findIndex(e=>e.path==='test/version.test.ts');
  assert.ok(index>=0);
  changed[index].blob='0'.repeat(40);
  const derived=summarizeTestFiles(changed,report.commitSha);
  assert.throws(()=>createTestExecutionPlan(changed,derived),
    /TEST_EXECUTION_PLAN_REVIEWED_SOURCE_BLOB_CHANGED/);
});
test('CI requires an explicitly matched expected PR source HEAD',()=>{
  const env={...process.env,CI:'true'};
  delete env.NEXOWIRE_EXPECTED_COMMIT_SHA;
  const result=spawnSync(process.execPath,[script,'--json'],{
    cwd:root,env,encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/CI_EXPECTED_SOURCE_REQUIRED/);
});
test('rejects invalid partitions and excessive shard requests',()=>{
  for(const n of [-1,0,1.2,9,APPROVED_ROOT_TEST_FILES.length+1,NaN,'2',null]) {
    assert.throws(()=>createTestExecutionPlan(entries,report,n),/INVALID_SHARDS/);
  }
  assert.equal(createTestExecutionPlan(entries,report,1).reviewedPortableShards.length,1);
});
test('live CLI emits source-pinned planning-only report',()=>{
  const result=invoke(['--json','--shards=2']);
  assert.equal(result.status,0,result.stderr);
  const p=JSON.parse(result.stdout);
  assert.equal(p.sourceCommitSha,report.commitSha);
  assert.equal(p.notReviewedFileCount,entries.length-APPROVED_ROOT_TEST_FILES.length);
  assert.equal(p.executionPerformed,false);
});
test('live CLI fails closed on wrong/empty SHA and unreviewed coverage claims',()=>{
  const wrong=invoke(['--json'],'0'.repeat(40));
  assert.equal(wrong.status,1);
  assert.match(wrong.stderr,/EXPECTED_SOURCE_MISMATCH/);
  const empty=invoke(['--json'],'');
  assert.equal(empty.status,1);
  assert.match(empty.stderr,/EXPECTED_SOURCE_MISMATCH/);
  const overclaim=invoke(['--assert-all-reviewed']);
  assert.equal(overclaim.status,1);
  assert.match(overclaim.stderr,/UNREVIEWED_FILES_/);
  const badFlag=invoke(['--execute-all']);
  assert.equal(badFlag.status,1);
  assert.match(badFlag.stderr,/USAGE/);
});
test('hosted inventory lane is read-only, source-pinned and runs planner contracts',()=>{
  const wf=readFileSync(path.join(root,'.github/workflows/test-discovery-inventory.yml'),'utf8');
  assert.match(wf,/permissions:\s+contents: read/);
  assert.match(wf,/run: node --test test\/ci\/test-execution-plan\.test\.mjs/);
  assert.match(wf,/run: node scripts\/ci\/test-execution-plan\.mjs --json --shards=2/);
  assert.match(wf,/ref: [$][{][{] github[.]event[.]pull_request[.]head[.]sha [|][|] github[.]sha [}][}]/);
  assert.match(wf,/NEXOWIRE_EXPECTED_COMMIT_SHA: [$][{][{] github[.]event[.]pull_request[.]head[.]sha [|][|] github[.]sha [}][}]/);
  const planner=readFileSync(script,'utf8');
  assert.doesNotMatch(planner,/\bspawnSync\b/);
});
