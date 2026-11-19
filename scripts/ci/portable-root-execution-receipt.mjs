/**
 * Execute exactly the reviewed pure root-level tests and report TAP-verified
 * file-by-file evidence. No shell globs, dynamic test selection or production
 * Windows actions. This is not coverage of the full tracked test inventory.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {assertTapSummary} from './assert-tap-summary.mjs';

export const APPROVED_ROOT_TEST_FILES=Object.freeze([
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
  'test/github-app-manifest.test.ts',
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
  'test/scale-worker-capacity-overflow.test.ts',
  'test/scale-s5-resource-reconciliation.test.ts',
  'test/scale-s5-durable-object-cost.test.ts',
  'test/scale-s5-chunk-receipt-audit.test.ts',
  'test/scale-transport-metrics.test.ts',
  'test/scale-s5-provider-meter-evidence.test.ts',
  'test/security-tokens.test.ts',
  'test/scale-s5-staging-acceptance.test.ts',
  'test/core-elevation-effective-truth-matrix.test.ts',
  'test/core-console-enrollment-policy.test.ts',
]);

export const REVIEWED_ROOT_GIT_BLOBS = Object.freeze({
  'test/version.test.ts':'c06489c8b3b877b061ed89d06872347e67cc9940',
  'test/release-tag.test.ts':'7855f8cdcda3c29f8035358e25777f7f4904d857',
  'test/release-publication-policy.test.ts':'d12ab1f03b7ffff8fc6d75552ada812d16b46436',
  'test/release-attestation-policy.test.ts':'e1f12b6bceb5d437a8b46e194c953e83bc6aa923',
  'test/ai07-physical-cutover-gate.test.ts':'7e92c75c744575f1b4acbf5e8054b6bc7fbb88a9',
  'test/capability-policy.test.ts':'60bb307b4121304a24a7bde63218139139f769f4',
  'test/device-routing-policy-store.test.ts':'f1a39bbec8d0d7623ebef5e72a9d0e185e62ce49',
  'test/agent-protocol.test.ts':'6eeaec135201e8bb6a7ab08382098223b6e05747',
  'test/product-usage-policy.test.ts':'708d91d1f79c4a6f1be8d3c2b342fc6e01a83a37',
  'test/product-transport-policy.test.ts':'47fa693c290a7a57408bfa7d477cd1a982b26f14',
  'test/task-os-sandbox-policy-p07.test.ts':'387ce6e5351678d5c19afb5f293d2083d8d54829',
  'test/bridge-guardian-policy.test.ts':'e45398adeaa4b3840889027e532013e4f69aa23a',
  'test/product-pairing.test.ts':'1d2f8738bb4eebeac1094231644e496280f15492',
  'test/github-app-manifest.test.ts':'2c6608e65c6b86fc0064edbb9540ffa6143f8a5c',
  'test/daily-quota-proposal.test.ts':'2f4abf418858d3bfd507d9e6f7593c18a767f455',
  'test/product-usage-ledger.test.ts':'970a9502cadd2e1df37839e866646fba471db8cc',
  'test/progress-supervisor.test.ts':'a6f62bbc58657585d516e36f7caf26fa36acce7b',
  'test/guardian-key-enrollment-proof.test.ts':'f9d52ebbcbcd7d5667069c1f3fd27e9a35d09588',
  'test/guardian-signed-receipt.test.ts':'9eddfb2267a6a7defe2a8e69c43cd6c96ebb17d8',
  'test/private-display-plan.test.ts':'84e416cfc6f8ca183ba6400a362e80ef2325ea6d',
  'test/owner-public-wss-p256-migration-proposal.test.ts':'e3b95ef518676022766d1edefda55ef729835717',
  'test/agent-request-cache.test.ts':'745865fb0a79aa4b271d703f4b924bb601cff9a5',
  'test/owner-public-wss-stream-flow-staging.test.ts':'a6c5d85e137e30237de8e3e3a72362f37b388751',
'test/scale-elastic-capacity-model.test.ts':'ce9012cd2048eef83c31535f8b35a4fd8ddcbbaf',
  'test/scale-s5-cost-envelope.test.ts':'4bbf0f7949be9c86c48fda1a7ce1470adc64b868',
  'test/scale-worker-capacity-overflow.test.ts':'5a9e16fb2aad7fd3dbce9ff34989d7affa51664f',
  'test/scale-s5-resource-reconciliation.test.ts':'bd60b7b10bc22be4219155b165e401de34b4d277',
  'test/scale-s5-durable-object-cost.test.ts':'b483dddfb16d683fed0b5fa898ce446bcf992618',
  'test/scale-s5-chunk-receipt-audit.test.ts':'1b70d6bc7112d2e21c2ebdf165a237a68fe51848',
  'test/scale-transport-metrics.test.ts':'7a5cf2d1fac5cdff68f33367bef682edb972c092',
  'test/scale-s5-provider-meter-evidence.test.ts':'4950286aea128fa34aa279dfc2cd17a12e190297',
  'test/security-tokens.test.ts':'92ea5c61df1c707f2970e1305a34b56d5cf7b8e0',
  'test/scale-s5-staging-acceptance.test.ts':'b381c0cc734d7a29f650bf922beb168074817e3d',
  'test/core-elevation-effective-truth-matrix.test.ts':'09d970538d6ce22b20edb25c9da1fcbed8929c4c',
  'test/core-console-enrollment-policy.test.ts':'416167d7389f722d378f6fcd2b9ed61da813713b',
});
const MAX_TEST_MILLIS=7*60*1000;
const MAX_LOG_BYTES=2*1024*1024;

function deny(code) {
  throw new Error('PORTABLE_ROOT_RECEIPT_'+code);
}

export function assertExpectedCommit(actual, expected) {
  if(!/^[a-f0-9]{40}$/.test(expected??'') || actual!==expected)
    deny('EXPECTED_HEAD_SHA_MISMATCH');
}

/** The only permissible process arguments, with each file run separately. */
export function commandForApprovedRootFile(file) {
  if(!APPROVED_ROOT_TEST_FILES.includes(file))
    deny('FILE_NOT_APPROVED');
  return ['--test','--test-reporter=tap','--import','tsx',
    '--test-concurrency=1',file];
}

/** Every explicitly approved test must match its independently reviewed Git blob. */
export function assertReviewedRootGitBlobs(entries) {
  if(!Array.isArray(entries) ||
     Object.keys(REVIEWED_ROOT_GIT_BLOBS).length!==APPROVED_ROOT_TEST_FILES.length ||
     new Set(APPROVED_ROOT_TEST_FILES).size!==APPROVED_ROOT_TEST_FILES.length)
    deny('REVIEWED_SOURCE_ALLOWLIST_INVALID');
  const byPath=new Map();
  for (const entry of entries) {
    if(!entry || typeof entry.path!=='string' || byPath.has(entry.path))
      deny('REVIEWED_SOURCE_INVENTORY_INVALID');
    byPath.set(entry.path,entry.blob);
  }
  for(const file of APPROVED_ROOT_TEST_FILES) {
    if(!/^test\/[^/]+\.test\.ts$/.test(file) ||
       !Object.hasOwn(REVIEWED_ROOT_GIT_BLOBS,file) ||
       byPath.get(file)!==REVIEWED_ROOT_GIT_BLOBS[file])
      deny('REVIEWED_SOURCE_BLOB_CHANGED');
  }
}

/**
 * The reviewed Git tree must also match bytes on disk. An index/HEAD match
 * alone does not attest a checkout after a concurrent modification.
 */
export function assertReviewedRootWorktreeBytes(file,bytes) {
  if(!APPROVED_ROOT_TEST_FILES.includes(file))deny('FILE_NOT_APPROVED');
  if(!Buffer.isBuffer(bytes))deny('WORKTREE_BYTES_REQUIRED');
  const actual=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(actual!==REVIEWED_ROOT_GIT_BLOBS[file])deny('WORKTREE_BLOB_CHANGED');
}

function assertOnDiskApprovedSource(repoRoot,file,readBytes) {
  const abs=path.resolve(repoRoot,...file.split('/'));
  const stat=lstatSync(abs);
  if(!stat.isFile()||stat.isSymbolicLink())deny('WORKTREE_NOT_REGULAR');
  assertReviewedRootWorktreeBytes(file,readBytes(abs));
}

/**
 * The runner injection exists for isolated negative unit tests. Production CLI
 * always calls the real Node spawnSync and emits a receipt only after all files
 * exit zero with full zero-SKIP TAP footer acceptance.
 */
export function createPortableRootReceipt(repoRoot, runner=spawnSync, expectedCommitSha=null, readBytes=readFileSync) {
  const {entries,report}=readTestInventory(repoRoot);
  if(expectedCommitSha!==null) assertExpectedCommit(report.commitSha,expectedCommitSha);
  // Fail BEFORE the first child process if any approved file changed since
  // its explicit source review. A filename allowlist alone is insufficient.
  assertReviewedRootGitBlobs(entries);
  const known=new Map(entries.map(entry=>[entry.path,entry]));
  // Check all approved on-disk sources before the first subprocess; also
  // check again immediately before each individual test launches.
  for(const file of APPROVED_ROOT_TEST_FILES){
    if(!known.has(file))deny('SOURCE_ALLOWLIST_NOT_TRACKED');
    assertOnDiskApprovedSource(repoRoot,file,readBytes);
  }
  const files=[];
  let testsPassed=0;
  for(const file of APPROVED_ROOT_TEST_FILES) {
    if(!/^test\/[^/]+\.test\.ts$/.test(file) || !known.has(file))
      deny('SOURCE_ALLOWLIST_NOT_TRACKED');
    assertOnDiskApprovedSource(repoRoot,file,readBytes);
    const args=commandForApprovedRootFile(file);
    const execution=runner(process.execPath,args,{
      cwd:repoRoot,encoding:'utf8',windowsHide:true,
      timeout:MAX_TEST_MILLIS,maxBuffer:MAX_LOG_BYTES,
    });
    if(!execution || execution.error || execution.status!==0 ||
        typeof execution.stdout!=='string')
      deny('PROCESS_FAILED_'+file.replaceAll('/','_'));
    let counters;
    try {
      counters=assertTapSummary(execution.stdout,1);
    }catch{
      deny('TAP_NOT_ACCEPTED_'+file.replaceAll('/','_'));
    }
    testsPassed+=counters.pass;
    const source=known.get(file);
    files.push({
      path:file,
      gitBlobSha:source.blob,
      tests:counters.tests,
      pass:counters.pass,
      fail:counters.fail,
      skipped:counters.skipped,
      todo:counters.todo,
      cancelled:counters.cancelled,
      result:'PASS',
    });
  }
  return {
    schemaVersion:1,
    sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,
    nodeVersion:process.version,
    platform:process.platform,
    executedFileCount:files.length,
    testsPassed,
    fail:0,
    skipped:0,
    todo:0,
    cancelled:0,
    scope:'ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES',
    physicalWindowsAcceptance:'NOT_INFERRED',
    files,
  };
}

const invoked=process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    if(process.argv.length!==3 || process.argv[2]!=='--json')
      deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const expected=process.env.NEXOWIRE_EXPECTED_COMMIT_SHA??null;
    if(process.env.CI==='true' && expected===null)
      deny('EXPECTED_HEAD_SHA_REQUIRED_IN_CI');
    const receipt=createPortableRootReceipt(root,spawnSync,expected);
    process.stdout.write(JSON.stringify(receipt)+'\n');
  }catch(error){
    process.stderr.write((error instanceof Error?error.message:'PORTABLE_ROOT_RECEIPT_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
