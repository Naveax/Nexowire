import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readTestInventory,summarizeTestFiles} from '../../scripts/ci/test-inventory.mjs';
import {reconcileCoverage,reconcileLaneCoverage} from '../../scripts/ci/test-execution-coverage.mjs';
import {APPROVED_ROOT_TEST_FILES} from '../../scripts/ci/portable-root-execution-receipt.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {entries,report}=readTestInventory(root);
const subset=APPROVED_ROOT_TEST_FILES.slice(0,3).map(file=>entries.find(e=>e.path===file));
assert.ok(subset.every(Boolean),'reviewed test files must exist in immutable inventory');
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

test('rejects any unreviewed tracked file masquerading as an approved portable root test',()=>{
  const unapproved=entries.find(e=>!APPROVED_ROOT_TEST_FILES.includes(e.path));
  assert.ok(unapproved,'fixture requires an unreviewed tracked test');
  const r=receipt();
  r.files[0]={...r.files[0],path:unapproved.path,gitBlobSha:unapproved.blob};
  assert.throws(()=>reconcileCoverage(entries,report,r),
    /TEST_COVERAGE_UNAPPROVED_ROOT_FILE/);
});
test('rejects a forged full-inventory PASS claim under the portable-root receipt scope',()=>{
  const forged=receipt();
  forged.files=entries.map(e=>({
    path:e.path,gitBlobSha:e.blob,tests:1,pass:1,
    fail:0,skipped:0,todo:0,cancelled:0,result:'PASS',
  }));
  forged.executedFileCount=entries.length;
  forged.testsPassed=entries.length;
  assert.throws(()=>reconcileCoverage(entries,report,forged),
    /TEST_COVERAGE_UNAPPROVED_ROOT_FILE/);
});
test('reviewed-only receipt cannot claim full test inventory execution',()=>{
  const approved=APPROVED_ROOT_TEST_FILES.map(file=>entries.find(e=>e.path===file));
  assert.ok(approved.every(Boolean));
  const r=receipt();
  r.files=approved.map(e=>({
    path:e.path,gitBlobSha:e.blob,tests:1,pass:1,
    fail:0,skipped:0,todo:0,cancelled:0,result:'PASS',
  }));
  r.executedFileCount=approved.length;
  r.testsPassed=approved.length;
  const coverage=reconcileCoverage(entries,report,r);
  assert.equal(coverage.executedFileCount,APPROVED_ROOT_TEST_FILES.length);
  assert.equal(coverage.notRunFileCount,entries.length-APPROVED_ROOT_TEST_FILES.length);
  assert.equal(coverage.comprehensiveCoverage,false);
});

test('recomputes the complete Git manifest, not only receipt-selected blobs',()=>{
  const untouched=entries.find(e=>!APPROVED_ROOT_TEST_FILES.includes(e.path));
  assert.ok(untouched);
  const changed=entries.map(e=>e.path===untouched.path?
    {...e,blob:'f'.repeat(40)}:e);
  assert.throws(()=>reconcileCoverage(changed,report,receipt()),
    /TEST_COVERAGE_INVENTORY_MANIFEST_MISMATCH/);
  const renamed=entries.map(e=>e.path===untouched.path?
    {...e,path:'test/forged-unreviewed-coverage.test.ts'}:e);
  assert.throws(()=>reconcileCoverage(renamed,report,receipt()),
    /TEST_COVERAGE_INVENTORY_MANIFEST_MISMATCH/);
});

test('rejects reordered inventory and fabricated path-depth statistics',()=>{
  const reversed=[...entries].reverse();
  assert.throws(()=>reconcileCoverage(reversed,report,receipt()),
    /TEST_COVERAGE_INVENTORY_MANIFEST_MISMATCH/);
  const fakedDepth={...report,byDepth:{...report.byDepth,root:report.byDepth.root+1}};
  assert.throws(()=>reconcileCoverage(entries,fakedDepth,receipt()),
    /TEST_COVERAGE_INVENTORY_MANIFEST_MISMATCH/);
});

test('emits exhaustive file states without laundering NOT_RUN into PASS',()=>{
  const coverage=reconcileCoverage(entries,report,receipt());
  assert.deepEqual(coverage.statusCounts,{
    PASS:subset.length,FAIL:0,SKIP:0,NOT_RUN:entries.length-subset.length,
  });
  assert.equal(coverage.fileStates.length,entries.length);
  assert.equal(coverage.fileStates.filter(e=>e.result==='PASS').length,subset.length);
  assert.equal(coverage.fileStates.filter(e=>e.result==='NOT_RUN').length,
    entries.length-subset.length);
  const byPath=new Map(coverage.fileStates.map(e=>[e.path,e]));
  assert.equal(byPath.size,entries.length);
  for(const entry of entries){
    const reported=byPath.get(entry.path);
    assert.equal(reported.gitBlobSha,entry.blob);
    assert.equal(reported.result,subset.some(e=>e.path===entry.path)?'PASS':'NOT_RUN');
  }
  assert.equal(coverage.statusSemantics,'RECEIPT_ONLY_NO_GLOBAL_CI_INFERENCE');
  assert.equal(coverage.comprehensiveCoverage,false);
});

const unionTarget={platform:'win32',nodeVersion:'v22.23.5'};
const scope='REVIEWED_WINDOWS_BROKER_AND_PRELOGIN_SOURCE_FIXTURES_ONLY';
const authorityScope='REVIEWED_WINDOWS_AUTHORITY_AND_LEDGER_SOURCE_FIXTURES_ONLY';
const mixedScope='REVIEWED_PLATFORM_ACL_AND_SIDECAR_SOURCE_FIXTURES_ONLY';
const unionEntries=['a','b','c','d'].map((name,i)=>({
  path:'test/'+name+'.test.ts',mode:'100644',blob:String(i+1).repeat(40),
}));
const unionInventory=summarizeTestFiles(unionEntries,'a'.repeat(40));
const pin=(i,extra={})=>({path:unionEntries[i].path,gitBlobSha:unionEntries[i].blob,minimum:1,...extra});
const policy=(id,files,extra={})=>({id,scope,schemaVersion:1,...unionTarget,files,...extra});
const pass=f=>({path:f.path,gitBlobSha:f.gitBlobSha,result:'PASS',tests:1,pass:1,
  fail:0,skipped:0,cancelled:0,todo:0});
const laneReceipt=(p,files=p.files.map(pass))=>{
  const counts={PASS:0,FAIL:0,SKIP:0,NOT_RUN:unionEntries.length-files.length};
  for(const f of files)counts[f.result]++;
  return {id:p.id,receipt:{schemaVersion:p.schemaVersion,scope:p.scope,...unionTarget,
    sourceCommitSha:unionInventory.commitSha,sourceManifestSha256:unionInventory.manifestSha256,
    physicalWindowsAcceptance:'NOT_INFERRED',trackedFileCount:unionEntries.length,
    executedFileCount:files.length,notRunFileCount:counts.NOT_RUN,
    passedAssertions:files.reduce((n,f)=>n+(f.pass??0),0),statusCounts:counts,files,
    ...(p.schemaVersion===2?{attemptedFileCount:files.length,acceptance:counts.FAIL?'FAIL':'PASS'}:{})}};
};
const combine=(policies,receipts,target=unionTarget)=>reconcileLaneCoverage(
  unionEntries,unionInventory,target,policies,receipts);
test('union deduplicates overlap and does not aggregate assertion totals across lanes',()=>{
  const a=policy('a',[pin(0),pin(1)]),b=policy('b',[pin(1),pin(2)]);
  const r=combine([a,b],[laneReceipt(b),laneReceipt(a)]);
  assert.deepEqual(r.statusCounts,{PASS:3,FAIL:0,SKIP:0,NOT_RUN:1});
  assert.equal(r.uniqueAttemptedFileCount,3);
  assert.equal(r.requiredLaneAcceptance,'PASS');
  assert.equal(r.comprehensiveCoverage,false);
  assert.equal(r.passedAssertions,undefined);
  assert.deepEqual(r.fileStates[1].lanes,[{id:'a',result:'PASS'},{id:'b',result:'PASS'}]);
  assert.deepEqual(r,combine([b,a],[laneReceipt(a),laneReceipt(b)]));
});
test('missing required lane is incomplete even when another lane passed the same file',()=>{
  const a=policy('a',[pin(0)]),b=policy('b',[pin(0),pin(1)]);
  const r=combine([a,b],[laneReceipt(a)]);
  assert.deepEqual(r.missingLaneIds,['b']);
  assert.equal(r.requiredLaneAcceptance,'INCOMPLETE');
  assert.equal(r.fileStates[0].result,'PASS');
  assert.equal(r.fileStates[1].result,'NOT_RUN');
  assert.equal(r.comprehensiveCoverage,false);
});
test('a failed exact child dominates duplicate PASS and has no trusted assertion counters',()=>{
  const a=policy('a',[pin(0)]),b=policy('b',[pin(0),pin(1)],{schemaVersion:2,scope:authorityScope});
  const bad={path:pin(0).path,gitBlobSha:pin(0).gitBlobSha,result:'FAIL',exitCode:1};
  const failed=laneReceipt(b,[bad,pass(pin(1))]);
  const r=combine([a,b],[laneReceipt(a),failed]);
  assert.equal(r.fileStates[0].result,'FAIL');
  assert.equal(r.requiredLaneAcceptance,'FAIL');
  assert.deepEqual(r.statusCounts,{PASS:1,FAIL:1,SKIP:0,NOT_RUN:2});
  failed.receipt.files[0].pass=1;
  assert.throws(()=>combine([a,b],[laneReceipt(a),failed]),/UNION_FAILED_COUNTERS/);
});
test('named platform skips stay partial even alongside overlapping PASS',()=>{
  const cases=[{name:'present',result:'PASS'},{name:'other OS',result:'SKIP'}];
  const a=policy('a',[pin(0)]),b=policy('b',[pin(0,{minimum:2,caseStates:cases})],{scope:mixedScope});
  const f={...pass(pin(0)),result:'SKIP',tests:2,skipped:1,caseStates:cases.map(c=>({...c}))};
  const r=combine([a,b],[laneReceipt(a),laneReceipt(b,[f])]);
  assert.equal(r.fileStates[0].result,'SKIP');
  assert.equal(r.requiredLaneAcceptance,'PASS_WITH_EXPECTED_PLATFORM_SKIPS');
  f.caseStates[1].name='wrong case';
  assert.throws(()=>combine([a,b],[laneReceipt(a),laneReceipt(b,[f])]),/UNION_CASE_STATES/);
});
test('union rejects different SHA, manifest, OS, full Node version, scope and malformed totals',()=>{
  const a=policy('a',[pin(0)]);
  for(const [key,value] of [
    ['sourceCommitSha','b'.repeat(40)],['sourceManifestSha256','b'.repeat(64)],
    ['platform','linux'],['nodeVersion','v22.23.6'],['scope',authorityScope],
    ['physicalWindowsAcceptance','PASS'],['passedAssertions',2],['executedFileCount',2],
  ]){
    const r=laneReceipt(a);r.receipt[key]=value;
    assert.throws(()=>combine([a],[r]),/TEST_COVERAGE_UNION_/);
  }
  assert.throws(()=>combine([a],[laneReceipt(a),laneReceipt(a)]),/UNION_UNKNOWN_OR_DUPLICATE_RECEIPT/);
  assert.throws(()=>combine([a],[laneReceipt(policy('unknown',[pin(0)]))]),/UNION_UNKNOWN_OR_DUPLICATE_RECEIPT/);
});
test('union rejects policy drift, unapproved substitutions and forged complete file sets',()=>{
  const a=policy('a',[pin(0)]);
  assert.throws(()=>combine([policy('a',[pin(0,{gitBlobSha:'f'.repeat(40)})])],[]),/UNION_POLICY_FILE_INVALID/);
  assert.throws(()=>combine([a],[laneReceipt(a,[pass(pin(1))])]),/UNION_RECEIPT_FILE_SET/);
  assert.throws(()=>combine([a],[laneReceipt(a,[])]),/UNION_RECEIPT_FILE_SET/);
  const all=policy('all',unionEntries.map((_,i)=>pin(i)));
  assert.equal(combine([all],[laneReceipt(all)]).comprehensiveCoverage,true);
  const tampered=unionEntries.map((e,i)=>i===3?{...e,blob:'f'.repeat(40)}:e);
  assert.throws(()=>reconcileLaneCoverage(tampered,unionInventory,unionTarget,[a],[laneReceipt(a)]),/UNION_INVENTORY_MISMATCH/);
});

test('cross-owner, CORE negative and disposable installer scopes require schema v2 and exact target',()=>{
  for(const scope of ["REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY","REVIEWED_WINDOWS_CORE_NEGATIVE_SOURCE_FIXTURES_ONLY","REVIEWED_WINDOWS_DISPOSABLE_INSTALLER_FIXTURES_ONLY"]){
    const p=policy('new-lane',[pin(0)],{scope,schemaVersion:2});
    const r=combine([p],[laneReceipt(p)]);
    assert.equal(r.requiredLaneAcceptance,'PASS');
    assert.equal(r.statusCounts.PASS,1);
    assert.throws(()=>combine([{...p,schemaVersion:1}],[]),/UNION_POLICY_SCHEMA/);
    const failed=laneReceipt(p,[{path:pin(0).path,gitBlobSha:pin(0).gitBlobSha,result:'FAIL'}]);
    assert.equal(combine([p],[failed]).requiredLaneAcceptance,'FAIL');
    assert.equal(combine([p],[]).requiredLaneAcceptance,'INCOMPLETE');
  }
});
