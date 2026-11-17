/**
 * Commit-bound, fail-closed CI test execution *plan*. This does not execute
 * tests. Unreviewed files cannot silently become runnable CI jobs.
 */
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory, summarizeTestFiles} from './test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES} from './portable-root-execution-receipt.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const MAX_SHARDS = 8;
const APPROVAL = Object.freeze([...APPROVED_ROOT_TEST_FILES].sort());
const REVIEWED_GIT_BLOBS = Object.freeze({
  'test/version.test.ts':'c06489c8b3b877b061ed89d06872347e67cc9940',
  'test/release-tag.test.ts':'7855f8cdcda3c29f8035358e25777f7f4904d857',
  'test/ai07-physical-cutover-gate.test.ts':'7e92c75c744575f1b4acbf5e8054b6bc7fbb88a9',
  'test/capability-policy.test.ts':'60bb307b4121304a24a7bde63218139139f769f4',
  'test/device-routing-policy-store.test.ts':'f1a39bbec8d0d7623ebef5e72a9d0e185e62ce49',
  'test/agent-protocol.test.ts':'6eeaec135201e8bb6a7ab08382098223b6e05747',
  'test/product-usage-policy.test.ts':'708d91d1f79c4a6f1be8d3c2b342fc6e01a83a37',
  'test/product-transport-policy.test.ts':'47fa693c290a7a57408bfa7d477cd1a982b26f14',
  'test/task-os-sandbox-policy-p07.test.ts':'387ce6e5351678d5c19afb5f293d2083d8d54829',
  'test/bridge-guardian-policy.test.ts':'e45398adeaa4b3840889027e532013e4f69aa23a',
  'test/product-pairing.test.ts':'1d2f8738bb4eebeac1094231644e496280f15492',
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
  'test/scale-s5-resource-reconciliation.test.ts':'bd60b7b10bc22be4219155b165e401de34b4d277',
  'test/scale-s5-durable-object-cost.test.ts':'b483dddfb16d683fed0b5fa898ce446bcf992618',
  'test/scale-s5-chunk-receipt-audit.test.ts':'1b70d6bc7112d2e21c2ebdf165a237a68fe51848',
  'test/scale-transport-metrics.test.ts':'7a5cf2d1fac5cdff68f33367bef682edb972c092',
  'test/scale-s5-provider-meter-evidence.test.ts':'4950286aea128fa34aa279dfc2cd17a12e190297',
  'test/security-tokens.test.ts':'92ea5c61df1c707f2970e1305a34b56d5cf7b8e0',
  'test/scale-s5-staging-acceptance.test.ts':'b381c0cc734d7a29f650bf922beb168074817e3d',
  'test/core-elevation-effective-truth-matrix.test.ts':'09d970538d6ce22b20edb25c9da1fcbed8929c4c',
});

function fail(reason) { throw new Error('TEST_EXECUTION_PLAN_' + reason); }

/**
 * An execution plan contains reviewed portable-root files only. Everything
 * else is EXPLICITLY NOT REVIEWED, never implicitly classified as safe.
 * Git blobs are bound to the original inventory and no tests are spawned.
 */
export function createTestExecutionPlan(entries, inventory, shards=2) {
  if (!Array.isArray(entries) || !inventory ||
      inventory.schemaVersion!==1 || !SHA.test(inventory.commitSha) ||
      !HEX.test(inventory.manifestSha256) ||
      !Number.isSafeInteger(inventory.trackedTsTestFiles) ||
      inventory.trackedTsTestFiles!==entries.length || entries.length===0)
    fail('INVALID_SOURCE');
  if (!Number.isSafeInteger(shards) || shards<1 ||
      shards>Math.min(MAX_SHARDS, APPROVAL.length))
    fail('INVALID_SHARDS');
  let actual;
  try { actual=summarizeTestFiles(entries, inventory.commitSha); }
  catch { fail('UNTRUSTED_TEST_ENTRIES'); }
  if (actual.manifestSha256!==inventory.manifestSha256 ||
      actual.trackedTsTestFiles!==inventory.trackedTsTestFiles)
    fail('SOURCE_MANIFEST_MISMATCH');

  const known=new Map();
  for (const entry of entries) {
    if (known.has(entry.path)) fail('DUPLICATE_TEST_FILE');
    known.set(entry.path,entry);
  }
  if (APPROVAL.length!==new Set(APPROVAL).size) fail('DUPLICATE_APPROVAL');
  const selected=APPROVAL.map(file => {
    const entry=known.get(file);
    if (!entry || !/^test\/[^/]+\.test\.ts$/.test(file))
      fail('APPROVED_FILE_NOT_TRACKED');
    if (!Object.hasOwn(REVIEWED_GIT_BLOBS,file) ||
        entry.blob!==REVIEWED_GIT_BLOBS[file])
      fail('REVIEWED_SOURCE_BLOB_CHANGED');
    return {path:file,gitBlobSha:entry.blob};
  });
  const selectedSet=new Set(APPROVAL);
  const unreviewed=entries.filter(e=>!selectedSet.has(e.path)).map(e=>({
    path:e.path,gitBlobSha:e.blob,reviewStatus:'NOT_REVIEWED_NO_EXECUTION',
  }));
  const groups=Array.from({length:shards},(_,i)=>({
    shardIndex:i+1,shardCount:shards,
    reviewStatus:'EXPLICIT_PORTABLE_ROOT_APPROVAL',
    files:[],
  }));
  selected.forEach((entry,i)=>groups[i%shards].files.push(entry));
  return {
    schemaVersion:1,sourceCommitSha:inventory.commitSha,
    sourceManifestSha256:inventory.manifestSha256,
    trackedFileCount:entries.length,
    reviewedPortableFileCount:selected.length,
    notReviewedFileCount:unreviewed.length,
    reviewedPortableShards:groups,
    notReviewedFiles:unreviewed,
    allTrackedFilesApproved:unreviewed.length===0,
    executionPerformed:false,executionCoverage:'NOT_MEASURED',
    physicalWindowsAcceptance:'NOT_INFERRED',
    policy:'DENY_UNREVIEWED_TEST_EXECUTION',
  };
}
const invoked=process.argv[1]&&
  pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    const args=process.argv.slice(2);
    const allowed=args.every(a=>a==='--json'||a==='--assert-all-reviewed'||/^--shards=[1-8]$/.test(a));
    const shardArgs=args.filter(x=>x.startsWith('--shards='));
    if(!allowed || shardArgs.length>1 || args.filter(x=>x==='--json').length>1 ||
       args.filter(x=>x==='--assert-all-reviewed').length>1)
      fail('USAGE');
    const shardCount=shardArgs.length?Number(shardArgs[0].split('=')[1]):2;
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const {entries,report}=readTestInventory(root);
    if(process.env.CI==='true' && !Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA'))
      fail('CI_EXPECTED_SOURCE_REQUIRED');
    if(Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA') &&
       process.env.NEXOWIRE_EXPECTED_COMMIT_SHA!==report.commitSha)
      fail('EXPECTED_SOURCE_MISMATCH');
    const plan=createTestExecutionPlan(entries,report,shardCount);
    if(args.includes('--assert-all-reviewed') && !plan.allTrackedFilesApproved)
      fail('UNREVIEWED_FILES_' + plan.notReviewedFileCount);
    process.stdout.write(JSON.stringify(plan)+'\n');
  }catch(error) {
    process.stderr.write((error instanceof Error?error.message:'TEST_EXECUTION_PLAN_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
