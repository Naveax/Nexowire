import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {APPROVED_ROOT_TEST_FILES,REVIEWED_ROOT_GIT_BLOBS,assertReviewedRootGitBlobs,assertExpectedCommit,commandForApprovedRootFile,createPortableRootReceipt}
  from '../../scripts/ci/portable-root-execution-receipt.mjs';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const EXPECTED=[
  'test/version.test.ts',
  'test/release-tag.test.ts',
  'test/release-publication-policy.test.ts',
  'test/release-attestation-policy.test.ts',
  'test/ai07-physical-cutover-gate.test.ts',
  'test/capability-policy.test.ts',
  'test/device-routing-policy-store.test.ts',
  'test/agent-protocol.test.ts',
  'test/product-usage-policy.test.ts',
  'test/product-transport-policy.test.ts',
  'test/task-os-sandbox-policy-p07.test.ts',
  'test/bridge-guardian-policy.test.ts',
  'test/product-pairing.test.ts',
  'test/daily-quota-proposal.test.ts',
  'test/product-usage-ledger.test.ts',
  'test/progress-supervisor.test.ts',
  'test/guardian-key-enrollment-proof.test.ts',
  'test/guardian-signed-receipt.test.ts',
  'test/private-display-plan.test.ts',
  'test/owner-public-wss-p256-migration-proposal.test.ts',
  'test/agent-request-cache.test.ts',
  'test/owner-public-wss-stream-flow-staging.test.ts',
'test/scale-elastic-capacity-model.test.ts',
  'test/scale-s5-cost-envelope.test.ts',
  'test/scale-s5-resource-reconciliation.test.ts',
  'test/scale-s5-durable-object-cost.test.ts',
  'test/scale-s5-chunk-receipt-audit.test.ts',
  'test/scale-transport-metrics.test.ts',
  'test/scale-s5-provider-meter-evidence.test.ts',
  'test/security-tokens.test.ts',
  'test/scale-s5-staging-acceptance.test.ts',
  'test/core-elevation-effective-truth-matrix.test.ts',
  'test/core-console-enrollment-policy.test.ts',
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

test('reviewed Git blob pins deny modified test source and unknown approval before execution',()=>{
  const {entries}=readTestInventory(root);
  assert.doesNotThrow(()=>assertReviewedRootGitBlobs(entries));
  assert.equal(Object.keys(REVIEWED_ROOT_GIT_BLOBS).length,APPROVED_ROOT_TEST_FILES.length);
  for(const file of ['test/version.test.ts','test/release-attestation-policy.test.ts']){
    const changed=entries.map(e=>e.path===file?{...e,blob:'0'.repeat(40)}:e);
    assert.throws(()=>assertReviewedRootGitBlobs(changed),
      /PORTABLE_ROOT_RECEIPT_REVIEWED_SOURCE_BLOB_CHANGED/);
  }
  const absent=entries.filter(e=>e.path!=='test/version.test.ts');
  assert.throws(()=>assertReviewedRootGitBlobs(absent),
    /PORTABLE_ROOT_RECEIPT_REVIEWED_SOURCE_BLOB_CHANGED/);
});

test('a filename-allowlisted but unreviewed Git checkout cannot spawn any test process',()=>{
  const temp=mkdtempSync(path.join(tmpdir(),'nexowire-reviewed-blob-preexec-'));
  try{
    mkdirSync(path.join(temp,'test'));
    for(const file of APPROVED_ROOT_TEST_FILES)
      writeFileSync(path.join(temp,file),'import test from "node:test"; test("unreviewed",()=>{});\n');
    const git=(...args)=>execFileSync('git',args,{
      cwd:temp,encoding:'utf8',windowsHide:true,timeout:12000,
    });
    git('init','-q');
    git('add','--','test');
    git('-c','user.name=Nexowire Test','-c','user.email=ci@example.invalid',
      'commit','-qm','synthetic unreviewed checkout');
    let processes=0;
    assert.throws(()=>createPortableRootReceipt(temp,()=>{
      processes++;
      return {status:0,stdout:PASS_TAP,stderr:''};
    }),/PORTABLE_ROOT_RECEIPT_REVIEWED_SOURCE_BLOB_CHANGED/);
    assert.equal(processes,0,'Git blob review must precede the first runner call');
  } finally {
    rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('only successful exact-file TAP subprocesses produce a source-bound receipt',()=>{
  const calls=[];
  const runner=(exe,args,options)=>{
    calls.push({exe,args,options});
    return {status:0,stdout:PASS_TAP,stderr:''};
  };
  const receipt=createPortableRootReceipt(root,runner);
  assert.equal(calls.length,33);
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
  assert.equal(receipt.executedFileCount,33);
  assert.equal(receipt.testsPassed,66);
  assert.equal(receipt.fail,0);
  assert.equal(receipt.skipped,0);
  assert.equal(receipt.scope,'ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES');
  assert.equal(receipt.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.deepEqual(receipt.files.map(f=>f.path),EXPECTED);
  assert.ok(receipt.files.every(f=>/^[a-f0-9]{40}$/.test(f.gitBlobSha)));
});

test('PR SHA expected-head mismatch is rejected before executing any test process',()=>{
  const sha=readTestInventory(root).report.commitSha;
  assert.doesNotThrow(()=>assertExpectedCommit(sha,sha));
  assert.throws(()=>assertExpectedCommit(sha,'a'.repeat(40)),
    /PORTABLE_ROOT_RECEIPT_EXPECTED_HEAD_SHA_MISMATCH/);
  assert.throws(()=>assertExpectedCommit(sha,undefined),
    /PORTABLE_ROOT_RECEIPT_EXPECTED_HEAD_SHA_MISMATCH/);
  let executed=false;
  assert.throws(()=>createPortableRootReceipt(root,()=>{executed=true;},'a'.repeat(40)),
    /PORTABLE_ROOT_RECEIPT_EXPECTED_HEAD_SHA_MISMATCH/);
  assert.equal(executed,false);
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
