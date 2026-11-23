import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES,REVIEWED_ROOT_GIT_BLOBS} from './portable-root-execution-receipt.mjs';

function deny(reason) {throw new Error('TEST_COVERAGE_' + reason)}
const sha=/^[0-9a-f]{40}$/;
const manifest=/^[0-9a-f]{64}$/;
const safeInt=x=>Number.isSafeInteger(x)&&x>=0;

/**
 * Cross-check a separately produced execution receipt against immutable Git
 * test inventory. This is reconciliation, not proof of independent execution.
 */
export function reconcileCoverage(entries,inventory,receipt) {
  if (!Array.isArray(entries) || !inventory || !receipt ||
      inventory.schemaVersion!==1 || receipt.schemaVersion!==1 ||
      !sha.test(inventory.commitSha) || !manifest.test(inventory.manifestSha256) ||
      receipt.sourceCommitSha!==inventory.commitSha ||
      receipt.sourceManifestSha256!==inventory.manifestSha256)
    deny('SOURCE_MISMATCH');
  if (!safeInt(inventory.trackedTsTestFiles) ||
      inventory.trackedTsTestFiles!==entries.length ||
      receipt.scope!=='ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES' ||
      receipt.physicalWindowsAcceptance!=='NOT_INFERRED' ||
      receipt.fail!==0 || receipt.skipped!==0 || receipt.todo!==0 ||
      receipt.cancelled!==0 ||
      !Array.isArray(receipt.files) || !safeInt(receipt.executedFileCount) ||
      receipt.executedFileCount!==receipt.files.length ||
      !safeInt(receipt.testsPassed)) deny('INVALID_RECEIPT');
  const tracked=new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path!=='string' || !sha.test(entry.blob) ||
        tracked.has(entry.path)) deny('INVALID_INVENTORY');
    tracked.set(entry.path,entry.blob);
  }
  // This receipt format promises reviewed portable-root execution only.
  // A matching Git manifest is insufficient: an unapproved tracked test must
  // never acquire PASS evidence merely by being included in a forged receipt.
  const approved=new Set(APPROVED_ROOT_TEST_FILES);
  if(approved.size!==APPROVED_ROOT_TEST_FILES.length ||
     Object.keys(REVIEWED_ROOT_GIT_BLOBS).length!==approved.size ||
     [...approved].some(file=>!Object.hasOwn(REVIEWED_ROOT_GIT_BLOBS,file)))
    deny('REVIEWED_ALLOWLIST_INVALID');
  const executed=new Set();
  let passed=0;
  for(const f of receipt.files) {
    if(!f || typeof f.path!=='string' || !tracked.has(f.path) ||
       executed.has(f.path) || f.gitBlobSha!==tracked.get(f.path))
      deny('FILE_NOT_BOUND_TO_SOURCE');
    if(!approved.has(f.path) ||
       !Object.hasOwn(REVIEWED_ROOT_GIT_BLOBS,f.path) ||
       f.gitBlobSha!==REVIEWED_ROOT_GIT_BLOBS[f.path])
      deny('UNAPPROVED_ROOT_FILE');
    if(f.result!=='PASS' || !safeInt(f.tests) || f.tests===0 ||
       !safeInt(f.pass) || f.pass!==f.tests ||
       f.fail!==0 || f.skipped!==0 || f.todo!==0 || f.cancelled!==0)
      deny('FILE_COUNTERS_INVALID');
    executed.add(f.path);
    passed+=f.pass;
  }
  if(passed!==receipt.testsPassed)deny('TOTAL_COUNTERS_INVALID');
  const notRun=entries.map(e=>e.path).filter(p=>!executed.has(p));
  return {
    schemaVersion:1, sourceCommitSha:inventory.commitSha,
    sourceManifestSha256:inventory.manifestSha256,
    trackedFileCount:entries.length, executedFileCount:executed.size,
    notRunFileCount:notRun.length, passedAssertions:passed,
    executedFiles:[...executed].sort(),notRunFiles:notRun.sort(),
    scope:'RECEIPT_RECONCILIATION_ONLY',
    comprehensiveCoverage:executed.size===entries.length,
    physicalWindowsAcceptance:'NOT_INFERRED',
  };
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    if(process.argv.length!==4||process.argv[2]!=='--receipt')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const {entries,report}=readTestInventory(root);
    if(process.env.CI==='true' && !Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA'))
      deny('EXPECTED_HEAD_SHA_REQUIRED_IN_CI');
    if(Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA')&&
       process.env.NEXOWIRE_EXPECTED_COMMIT_SHA!==report.commitSha)
      deny('EXPECTED_HEAD_SHA_MISMATCH');
    const receipt=JSON.parse(readFileSync(process.argv[3],'utf8').replace(/^\uFEFF/,''));
    process.stdout.write(JSON.stringify(reconcileCoverage(entries,report,receipt))+'\n');
  } catch(e) {
    process.stderr.write((e instanceof Error?e.message:'TEST_COVERAGE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
