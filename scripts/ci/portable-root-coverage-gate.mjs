/**
 * Execute the exact reviewed portable test allowlist, then reconcile the
 * file-by-file TAP receipt to the complete immutable Git test inventory.
 * No shell glob, implicit test selection, production write or OS privilege.
 */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES,createPortableRootReceipt} from './portable-root-execution-receipt.mjs';
import {reconcileCoverage} from './test-execution-coverage.mjs';

function deny(reason) { throw new Error('PORTABLE_ROOT_COVERAGE_GATE_' + reason); }

export function runPortableRootCoverageGate(root,runner=spawnSync,expectedCommitSha=null) {
  const {entries,report}=readTestInventory(root);
  const receipt=createPortableRootReceipt(root,runner,expectedCommitSha);
  const coverage=reconcileCoverage(entries,report,receipt);
  const expected=new Set(APPROVED_ROOT_TEST_FILES);
  const actual=new Set(receipt.files.map(f=>f.path));
  if(expected.size!==APPROVED_ROOT_TEST_FILES.length ||
     actual.size!==expected.size ||
     receipt.executedFileCount!==expected.size ||
     coverage.executedFileCount!==expected.size ||
     coverage.trackedFileCount!==report.trackedTsTestFiles ||
     coverage.notRunFileCount!==entries.length-expected.size ||
     coverage.sourceCommitSha!==report.commitSha ||
     coverage.sourceManifestSha256!==report.manifestSha256 ||
     coverage.passedAssertions!==receipt.testsPassed ||
     coverage.physicalWindowsAcceptance!=='NOT_INFERRED' ||
     [...expected].some(f=>!actual.has(f)))
    deny('RECONCILIATION_DIVERGENCE');
  return {
    schemaVersion:1,
    sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,
    trackedFileCount:coverage.trackedFileCount,
    executedFileCount:coverage.executedFileCount,
    notRunFileCount:coverage.notRunFileCount,
    testsPassed:receipt.testsPassed,
    executionScope:'EXACT_REVIEWED_PORTABLE_ROOT_FILES_ONLY',
    physicalWindowsAcceptance:'NOT_INFERRED',
    executionReceipt:receipt,
    coverage,
  };
}

const invoked=process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    if(process.argv.length!==3 || process.argv[2]!=='--json')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const expected=process.env.NEXOWIRE_EXPECTED_COMMIT_SHA??null;
    if(process.env.CI==='true' && expected===null)
      deny('EXPECTED_HEAD_SHA_REQUIRED_IN_CI');
    const result=runPortableRootCoverageGate(root,spawnSync,expected);
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(e) {
    process.stderr.write((e instanceof Error?e.message:'PORTABLE_ROOT_COVERAGE_GATE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
