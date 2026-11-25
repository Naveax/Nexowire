import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';
import {createTestExecutionPlan} from '../../scripts/ci/test-execution-plan.mjs';
import {sourceTextHints,triageTrackedTests,readTestReviewTriage,TEXT_SIGNAL_NAMES}
  from '../../scripts/ci/test-review-triage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {entries:trackedEntries,report:trackedReport}=readTestInventory(root);
const sha=trackedReport.commitSha;
const reviewedPlan=createTestExecutionPlan(trackedEntries,trackedReport,2);
const script=path.join(root,'scripts/ci/test-review-triage.mjs');
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function fixture(){
  const bodies=[
    Buffer.from("import test from 'node:test'; test('a',()=>{});"),
    Buffer.from("import {spawn} from 'node:child_process'; import {DatabaseSync} from 'node:sqlite';"),
    Buffer.from("import os from 'node:os'; const x='static';"),
  ];
  const entries=bodies.map((b,i)=>({path:'test/f'+i+'.test.ts',blob:blob(b),mode:'100644'}));
  const inventory={schemaVersion:1,commitSha:sha,manifestSha256:'a'.repeat(64),trackedTsTestFiles:3};
  const plan={schemaVersion:1,sourceCommitSha:sha,sourceManifestSha256:inventory.manifestSha256,
    trackedFileCount:3,reviewedPortableShards:[{files:[{path:entries[0].path,gitBlobSha:entries[0].blob}]}],
    reviewedPortableFileCount:1,notReviewedFiles:entries.slice(1).map(e=>({
      path:e.path,gitBlobSha:e.blob,reviewStatus:'NOT_REVIEWED_NO_EXECUTION'})),
    notReviewedFileCount:2,policy:'DENY_UNREVIEWED_TEST_EXECUTION',executionPerformed:false,
    physicalWindowsAcceptance:'NOT_INFERRED'};
  return {bodies,entries,inventory,plan,readSource:f=>bodies[Number(/f(\d)/.exec(f)[1])]};
}
test('source signal hints are explicitly textual, not proof of execution',()=>{
  const s=sourceTextHints("import {spawn} from 'node:child_process';\n const x='https://example.com';");
  assert.ok(s.includes('process_execution'));assert.ok(s.includes('network_or_listener'));
  assert.ok(!s.includes('sqlite_or_database'));
  assert.equal(new Set(TEXT_SIGNAL_NAMES).size,TEXT_SIGNAL_NAMES.length);
});
test('review queue partitions every file and cannot approve the unknown',()=>{
  const x=fixture();const r=triageTrackedTests(x.entries,x.inventory,x.plan,x.readSource);
  assert.equal(r.trackedTestFiles,3);assert.equal(r.explicitlyReviewedFiles,1);
  assert.equal(r.queuedManualReviewFiles,2);assert.equal(r.manualReviewQueue.length,2);
  assert.equal(r.bandCounts.SPECIALIST_REVIEW_REQUIRED,1);
  assert.equal(r.bandCounts.STATIC_HINTS_INSUFFICIENT_REVIEW_REQUIRED,1);
  assert.ok(r.manualReviewQueue.every(z=>z.admission==='NOT_APPROVED_NO_EXECUTION'));
  assert.equal(r.noAutomaticExecution,true);
  assert.equal(r.physicalWindowsAcceptance,'NOT_INFERRED');
});
test('changed blob, duplicate partitions and review-count inflation are rejected',()=>{
  const x=fixture();
  assert.throws(()=>triageTrackedTests(x.entries,x.inventory,x.plan,f=>
    f==='test/f1.test.ts'?Buffer.from('changed'):x.readSource(f)),/WORKTREE_GIT_BLOB_MISMATCH/);
  const overlap=structuredClone(x.plan);overlap.notReviewedFiles.push({
    path:x.entries[0].path,gitBlobSha:x.entries[0].blob,reviewStatus:'NOT_REVIEWED_NO_EXECUTION'});
  overlap.notReviewedFileCount++;
  assert.throws(()=>triageTrackedTests(x.entries,x.inventory,overlap,x.readSource),
    /DENIED_COUNT_MISMATCH|OVERLAPPING_REVIEW_PARTITIONS/);
  const invented=structuredClone(x.plan);invented.reviewedPortableFileCount=3;
  assert.throws(()=>triageTrackedTests(x.entries,x.inventory,invented,x.readSource),
    /REVIEWED_COUNT_MISMATCH/);
});
test('live tracked test paths are all partitioned and still require review',()=>{
  const r=readTestReviewTriage(root,sha);
  assert.equal(r.trackedTestFiles,trackedEntries.length);
  assert.equal(r.explicitlyReviewedFiles,reviewedPlan.reviewedPortableFileCount);
  assert.equal(r.queuedManualReviewFiles,reviewedPlan.notReviewedFileCount);
  assert.equal(r.manualReviewQueue.length,reviewedPlan.notReviewedFileCount);
  assert.equal(Object.values(r.bandCounts).reduce((a,b)=>a+b,0),reviewedPlan.notReviewedFileCount);
  assert.equal(r.reviewSemantics,'TEXTUAL_HEURISTIC_NOT_SAFETY_CLASSIFICATION');
});
test('CLI refuses wrong SHA, absent CI SHA and unsupported execute flags',()=>{
  for(const [args,env,error] of [
    [['--summary'],{...process.env,NEXOWIRE_EXPECTED_COMMIT_SHA:'0'.repeat(40)},'EXPECTED_HEAD_SHA_MISMATCH'],
    [['--summary'],{...process.env,CI:'true',NEXOWIRE_EXPECTED_COMMIT_SHA:undefined},'EXPECTED_HEAD_REQUIRED_IN_CI'],
    [['--execute-all'],{...process.env},'USAGE'],
  ]){
    const r=spawnSync(process.execPath,[script,...args],{
      cwd:root,env,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
    assert.equal(r.status,1,r.stderr);assert.match(r.stderr,new RegExp(error));
  }
});

test('hosted discovery has bounded source-pinned triage with no execution',()=>{
  const wf=readFileSync(path.join(root,'.github/workflows/test-discovery-inventory.yml'),'utf8');
  assert.match(wf,/permissions:\s+contents: read/);
  assert.match(wf,/run: node --test test\/ci\/test-review-triage\.test\.mjs/);
  assert.match(wf,/run: node scripts\/ci\/test-review-triage\.mjs --summary/);
  assert.match(wf,/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(wf,/NEXOWIRE_EXPECTED_COMMIT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.doesNotMatch(wf,/run:\s+node scripts\/ci\/test-review-triage\.mjs --execute/);
});

test('refuses forged approved blob, missing review record and duplicate source',()=>{
  const x=fixture();const corrupt=structuredClone(x.plan);
  corrupt.reviewedPortableShards[0].files[0].gitBlobSha='0'.repeat(40);
  assert.throws(()=>triageTrackedTests(x.entries,x.inventory,corrupt,x.readSource),
    /FILE_NOT_EXACTLY_PARTITIONED/);
  const missing=structuredClone(x.plan);
  missing.notReviewedFiles.pop();missing.notReviewedFileCount--;
  assert.throws(()=>triageTrackedTests(x.entries,x.inventory,missing,x.readSource),
    /DENIED_COUNT_MISMATCH|FILE_NOT_EXACTLY_PARTITIONED/);
  const dup=[...x.entries,x.entries[1]];
  const plan={...x.plan,trackedFileCount:4,notReviewedFileCount:3,
    notReviewedFiles:[...x.plan.notReviewedFiles,x.plan.notReviewedFiles[0]]};
  const inv={...x.inventory,trackedTsTestFiles:4};
  assert.throws(()=>triageTrackedTests(dup,inv,plan,x.readSource),
    /INVALID_DENIED_RECORD|INVALID_TRACKED_TEST/);
});
test('CLI summary is bounded, explicitly not a safety or execution attestation',()=>{
  const r=spawnSync(process.execPath,[script,'--summary'],{
    cwd:root,env:{...process.env,NEXOWIRE_EXPECTED_COMMIT_SHA:sha},
    encoding:'utf8',timeout:25000,maxBuffer:1024*1024,
  });
  assert.equal(r.status,0,r.stderr);
  const summary=JSON.parse(r.stdout);
  assert.equal(summary.queuedManualReviewFiles,reviewedPlan.notReviewedFileCount);
  assert.equal(summary.explicitlyReviewedFiles,reviewedPlan.reviewedPortableFileCount);
  assert.equal(summary.manualReviewQueue,undefined);
  assert.equal(summary.examplePendingPaths.length,Math.min(8,reviewedPlan.notReviewedFileCount));
  assert.equal(summary.noAutomaticExecution,true);
  assert.equal(summary.reviewSemantics,'TEXTUAL_HEURISTIC_NOT_SAFETY_CLASSIFICATION');
});
