/**
 * Execute exactly the reviewed pure root-level tests and report TAP-verified
 * file-by-file evidence. No shell globs, dynamic test selection or production
 * Windows actions. This is not coverage of the full tracked test inventory.
 */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {assertTapSummary} from './assert-tap-summary.mjs';

export const APPROVED_ROOT_TEST_FILES=Object.freeze([
  'test/version.test.ts',
  'test/release-tag.test.ts',
  'test/ai07-physical-cutover-gate.test.ts',
]);
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

/**
 * The runner injection exists for isolated negative unit tests. Production CLI
 * always calls the real Node spawnSync and emits a receipt only after all files
 * exit zero with full zero-SKIP TAP footer acceptance.
 */
export function createPortableRootReceipt(repoRoot, runner=spawnSync, expectedCommitSha=null) {
  const {entries,report}=readTestInventory(repoRoot);
  if(expectedCommitSha!==null) assertExpectedCommit(report.commitSha,expectedCommitSha);
  const known=new Map(entries.map(entry=>[entry.path,entry]));
  const files=[];
  let testsPassed=0;
  for(const file of APPROVED_ROOT_TEST_FILES) {
    if(!/^test\/[^/]+\.test\.ts$/.test(file) || !known.has(file))
      deny('SOURCE_ALLOWLIST_NOT_TRACKED');
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
