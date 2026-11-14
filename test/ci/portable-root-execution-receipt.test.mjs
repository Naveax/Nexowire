import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APPROVED_ROOT_TEST_FILES,commandForApprovedRootFile,createPortableRootReceipt}
  from '../../scripts/ci/portable-root-execution-receipt.mjs';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const EXPECTED=[
  'test/version.test.ts',
  'test/release-tag.test.ts',
  'test/ai07-physical-cutover-gate.test.ts',
];
const PASS_TAP=[
  'TAP version 13','1..2','# tests 2','# pass 2','# fail 0',
  '# cancelled 0','# skipped 0','# todo 0','',
].join('\n');

test('fixed root allowlist binds to exact checked-in test inventory',()=>{
  assert.deepEqual(APPROVED_ROOT_TEST_FILES,EXPECTED);
  const {entries}=readTestInventory(root);
  const tracked=new Set(entries.map(x=>x.path));
  for(const file of EXPECTED){
    assert.ok(tracked.has(file));
    assert.deepEqual(commandForApprovedRootFile(file),[
      '--test','--test-reporter=tap','--import','tsx',
      '--test-concurrency=1',file,
    ]);
  }
  assert.throws(()=>commandForApprovedRootFile('test/agent-native-remote-cas-live.test.ts'),
    /PORTABLE_ROOT_RECEIPT_FILE_NOT_APPROVED/);
});

test('only successful exact-file TAP subprocesses produce a source-bound receipt',()=>{
  const calls=[];
  const runner=(exe,args,options)=>{
    calls.push({exe,args,options});
    return {status:0,stdout:PASS_TAP,stderr:''};
  };
  const receipt=createPortableRootReceipt(root,runner);
  assert.equal(calls.length,3);
  for(let i=0;i<calls.length;i++){
    assert.equal(calls[i].exe,process.execPath);
    assert.equal(calls[i].options.cwd,root);
    assert.equal(calls[i].options.timeout,420000);
    assert.equal(calls[i].args.at(-1),EXPECTED[i]);
    assert.ok(calls[i].args.includes('--test-reporter=tap'));
  }
  const inventory=readTestInventory(root).report;
  assert.equal(receipt.sourceCommitSha,inventory.commitSha);
  assert.equal(receipt.sourceManifestSha256,inventory.manifestSha256);
  assert.equal(receipt.executedFileCount,3);
  assert.equal(receipt.testsPassed,6);
  assert.equal(receipt.fail,0);
  assert.equal(receipt.skipped,0);
  assert.equal(receipt.scope,'ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES');
  assert.equal(receipt.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.deepEqual(receipt.files.map(f=>f.path),EXPECTED);
  assert.ok(receipt.files.every(f=>/^[a-f0-9]{40}$/.test(f.gitBlobSha)));
});

test('nonzero, timed out, partial and skipped subprocesses fail closed',()=>{
  const variants=[
    {status:1,stdout:PASS_TAP},
    {status:null,stdout:PASS_TAP,error:{code:'ETIMEDOUT'}},
    {status:0,stdout:'# tests 2\n# pass 2\n'},
    {status:0,stdout:PASS_TAP.replace('# skipped 0','# skipped 1')},
    {status:0,stdout:PASS_TAP.replace('# pass 2','# pass 1')},
    {status:0,stdout:PASS_TAP+ '# tests 2\n'},
    {status:0,stdout:''},
  ];
  for(const failure of variants){
    const runner=()=>failure;
    assert.throws(()=>createPortableRootReceipt(root,runner),
      /PORTABLE_ROOT_RECEIPT_(?:PROCESS_FAILED|TAP_NOT_ACCEPTED)/);
  }
});
