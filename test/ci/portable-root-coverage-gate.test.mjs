import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES} from '../../scripts/ci/portable-root-execution-receipt.mjs';
import {runPortableRootCoverageGate} from '../../scripts/ci/portable-root-coverage-gate.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=readTestInventory(root).report;
const fixtureTap=[
  'TAP version 13','1..2','# tests 2','# pass 2','# fail 0',
  '# cancelled 0','# skipped 0','# todo 0','',
].join('\n');

test('real receipt runner injection is reconciled against all tracked Git files',()=>{
  const calls=[];
  const runner=(bin,args,options)=>{
    calls.push({bin,args,options});
    return {status:0,stdout:fixtureTap,stderr:''};
  };
  const proof=runPortableRootCoverageGate(root,runner,source.commitSha);
  assert.equal(calls.length,APPROVED_ROOT_TEST_FILES.length);
  assert.equal(proof.sourceCommitSha,source.commitSha);
  assert.equal(proof.sourceManifestSha256,source.manifestSha256);
  assert.equal(proof.executedFileCount,APPROVED_ROOT_TEST_FILES.length);
  assert.equal(proof.notRunFileCount,source.trackedTsTestFiles-APPROVED_ROOT_TEST_FILES.length);
  assert.equal(proof.testsPassed,2*APPROVED_ROOT_TEST_FILES.length);
  assert.equal(proof.coverage.notRunFiles.length,proof.notRunFileCount);
  assert.equal(proof.coverage.comprehensiveCoverage,false);
  assert.equal(proof.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.deepEqual(proof.coverage.executedFiles,[...APPROVED_ROOT_TEST_FILES].sort());
  assert.deepEqual(proof.executionReceipt.files.map(f=>f.path),APPROVED_ROOT_TEST_FILES);
  for (const call of calls) {
    assert.equal(call.bin,process.execPath);
    assert.equal(call.options.cwd,root);
    assert.equal(call.args[0],'--test');
    assert.equal(call.args[1],'--test-reporter=tap');
  }
});
test('wrong expected HEAD denies every subprocess before running',()=>{
  let calls=0;
  assert.throws(()=>runPortableRootCoverageGate(root,()=>{
    calls++;return {status:0,stdout:fixtureTap,stderr:''};
  },'0'.repeat(40)),/PORTABLE_ROOT_RECEIPT_EXPECTED_HEAD_SHA_MISMATCH/);
  assert.equal(calls,0);
});
test('partial, skipped and failing TAP evidence cannot claim coverage',()=>{
  for(const result of [
    {status:1,stdout:fixtureTap,stderr:''},
    {status:0,stdout:'TAP version 13\n1..2\n# tests 2\n# pass 2\n',stderr:''},
    {status:0,stdout:fixtureTap.replace('# skipped 0','# skipped 1'),stderr:''},
  ]) {
    assert.throws(()=>runPortableRootCoverageGate(root,()=>result,source.commitSha),
      /PORTABLE_ROOT_RECEIPT_/);
  }
});
test('CI CLI fails closed when exact expected HEAD is missing',()=>{
  const script=path.join(root,'scripts/ci/portable-root-coverage-gate.mjs');
  const env={...process.env,CI:'true'};
  delete env.NEXOWIRE_EXPECTED_COMMIT_SHA;
  const result=spawnSync(process.execPath,[script,'--json'],{
    cwd:root,env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/PORTABLE_ROOT_COVERAGE_GATE_EXPECTED_HEAD_SHA_REQUIRED_IN_CI/);
});
test('CLI forbids nonexplicit execution flags',()=>{
  const script=path.join(root,'scripts/ci/portable-root-coverage-gate.mjs');
  const result=spawnSync(process.execPath,[script,'--all'],{
    cwd:root,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/PORTABLE_ROOT_COVERAGE_GATE_USAGE/);
});
