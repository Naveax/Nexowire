/**
 * SHA-bound, source-only manual review queue for all tracked TS test files.
 *
 * This is a TEXTUAL HEURISTIC ONLY, never OS safety classification or proof
 * of execution. Every non-allowlisted file remains BLOCKED until reviewed.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {createTestExecutionPlan} from './test-execution-plan.mjs';

const SHA=/^[a-f0-9]{40}$/, SHA256=/^[a-f0-9]{64}$/;
function deny(x){throw new Error('TEST_REVIEW_TRIAGE_'+x)}
const SIGNAL_RULES=Object.freeze({
  process_execution:/\b(?:spawnSync|execFileSync|execSync|child_process|spawn|execFile|Start-Process|ProcessStartInfo)\b/i,
  network_or_listener:/\b(?:createServer|WebSocket|fetch|listen|connect|node:net|node:http|node:https|node:tls|node:dns|node:dgram)\b|(?:https?|wss?):\/\//i,
  local_filesystem:/\b(?:mkdtemp|writeFileSync|writeFile|readFile|rmSync|mkdir|symlink|node:fs)\b/i,
  sqlite_or_database:/\b(?:sqlite|DatabaseSync|better-sqlite3|WAL)\b/i,
  privileged_windows:/\b(?:DPAPI|SYSTEM|ScheduledTask|schtasks|RunAs|PowerShell|UAC|ACL|winreg|kernel32|job object|Broker)\b/i,
  environment:/\b(?:process\.env|USERPROFILE|NODE_OPTIONS|HOME|ProgramData)\b/i,
  native_process:/\b(?:ffi|node-gyp|LoadLibrary|CreateProcess|\.node)\b/i,
  runtime_module_loading:/\b(?:require)\s*\(|\bimport\s*\(/i,
});
export const TEXT_SIGNAL_NAMES=Object.freeze(Object.keys(SIGNAL_RULES));

function hashGitBlob(bytes) {
  return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
}
export function sourceTextHints(input) {
  if(typeof input!=='string')deny('INPUT_MUST_BE_TEXT');
  return TEXT_SIGNAL_NAMES.filter(name=>SIGNAL_RULES[name].test(input));
}
function reviewBand(signals) {
  if(signals.some(s=>['process_execution','network_or_listener','sqlite_or_database',
    'privileged_windows','native_process','runtime_module_loading'].includes(s)))
    return 'SPECIALIST_REVIEW_REQUIRED';
  if(signals.length)return 'IO_OR_ENV_REVIEW_REQUIRED';
  return 'STATIC_HINTS_INSUFFICIENT_REVIEW_REQUIRED';
}

/**
 * Validate the complete reviewed execution plan and SHA-bound test contents.
 * Text matching can generate false positives and false negatives; no band
 * authorizes test execution.
 */
export function triageTrackedTests(entries,inventory,plan,readSource) {
  if(!Array.isArray(entries)||!inventory||!plan||typeof readSource!=='function'||
     !SHA.test(inventory.commitSha)||!SHA256.test(inventory.manifestSha256)||
     plan.sourceCommitSha!==inventory.commitSha||
     plan.sourceManifestSha256!==inventory.manifestSha256||
     plan.trackedFileCount!==entries.length||
     inventory.trackedTsTestFiles!==entries.length||
     plan.policy!=='DENY_UNREVIEWED_TEST_EXECUTION'||
     plan.executionPerformed!==false||
     plan.physicalWindowsAcceptance!=='NOT_INFERRED'||
     !Array.isArray(plan.reviewedPortableShards)||
     !Array.isArray(plan.notReviewedFiles))deny('INVALID_SOURCE_OR_PLAN');
  const reviewed=new Map();
  for(const group of plan.reviewedPortableShards) {
    if(!Array.isArray(group.files))deny('INVALID_REVIEWED_SHARD');
    for(const f of group.files) {
      if(reviewed.has(f.path)||!SHA.test(f.gitBlobSha))deny('DUPLICATE_REVIEWED_FILE');
      reviewed.set(f.path,f.gitBlobSha);
    }
  }
  if(reviewed.size!==plan.reviewedPortableFileCount)deny('REVIEWED_COUNT_MISMATCH');
  const denied=new Map();
  for(const f of plan.notReviewedFiles) {
    if(denied.has(f.path)||!SHA.test(f.gitBlobSha)||
       f.reviewStatus!=='NOT_REVIEWED_NO_EXECUTION')deny('INVALID_DENIED_RECORD');
    denied.set(f.path,f.gitBlobSha);
  }
  if(denied.size!==plan.notReviewedFileCount||
     denied.size+reviewed.size!==entries.length)deny('DENIED_COUNT_MISMATCH');
  const signalsCounts=Object.fromEntries(TEXT_SIGNAL_NAMES.map(x=>[x,0]));
  const bands={SPECIALIST_REVIEW_REQUIRED:0,IO_OR_ENV_REVIEW_REQUIRED:0,
    STATIC_HINTS_INSUFFICIENT_REVIEW_REQUIRED:0};
  const seen=new Set(),reviewQueue=[];
  for(const f of entries) {
    if(!f||typeof f.path!=='string'||!SHA.test(f.blob)||
       !/^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(f.path)||
       seen.has(f.path))deny('INVALID_TRACKED_TEST');
    seen.add(f.path);
    if(reviewed.get(f.path)!==f.blob && denied.get(f.path)!==f.blob)
      deny('FILE_NOT_EXACTLY_PARTITIONED');
    if(reviewed.has(f.path)&&denied.has(f.path))deny('OVERLAPPING_REVIEW_PARTITIONS');
    let bytes;
    try {bytes=readSource(f.path);}catch{deny('SOURCE_READ_FAILURE')}
    if(!Buffer.isBuffer(bytes)||hashGitBlob(bytes)!==f.blob)
      deny('WORKTREE_GIT_BLOB_MISMATCH');
    if(reviewed.has(f.path))continue;
    const signals=sourceTextHints(bytes.toString('utf8'));
    for(const s of signals)signalsCounts[s]++;
    const hintBand=reviewBand(signals);bands[hintBand]++;
    reviewQueue.push({
      path:f.path,gitBlobSha:f.blob,textualSignals:signals,
      reviewBand:hintBand,admission:'NOT_APPROVED_NO_EXECUTION',
    });
  }
  if(reviewQueue.length!==denied.size)deny('QUEUE_NOT_COMPLETE');
  reviewQueue.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {
    schemaVersion:1,sourceCommitSha:inventory.commitSha,
    sourceManifestSha256:inventory.manifestSha256,
    trackedTestFiles:entries.length,
    explicitlyReviewedFiles:reviewed.size,
    queuedManualReviewFiles:reviewQueue.length,
    bandCounts:bands,textualSignalFileCounts:signalsCounts,
    manualReviewQueue:reviewQueue,
    reviewSemantics:'TEXTUAL_HEURISTIC_NOT_SAFETY_CLASSIFICATION',
    noAutomaticExecution:true,
    physicalWindowsAcceptance:'NOT_INFERRED',
  };
}
export function readTestReviewTriage(root,expectedSha) {
  const {entries,report}=readTestInventory(root);
  if(expectedSha!==null&&(!SHA.test(expectedSha)||expectedSha!==report.commitSha))
    deny('EXPECTED_HEAD_SHA_MISMATCH');
  const plan=createTestExecutionPlan(entries,report,2);
  const base=path.resolve(root)+path.sep;
  return triageTrackedTests(entries,report,plan,relative=>{
    const absolute=path.resolve(root,...relative.split('/'));
    if(!absolute.startsWith(base))deny('UNSAFE_READ_PATH');
    return readFileSync(absolute);
  });
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try {
    const args=process.argv.slice(2);
    if(args.length!==1||!['--json','--summary'].includes(args[0]))deny('USAGE');
    const expected=process.env.NEXOWIRE_EXPECTED_COMMIT_SHA??null;
    if(process.env.CI==='true'&&expected===null)deny('EXPECTED_HEAD_REQUIRED_IN_CI');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const report=readTestReviewTriage(root,expected);
    if(args[0]==='--summary') {
      const {manualReviewQueue,...summary}=report;
      process.stdout.write(JSON.stringify({...summary,examplePendingPaths:
        manualReviewQueue.slice(0,8).map(r=>r.path)})+'\n');
    }else process.stdout.write(JSON.stringify(report)+'\n');
  }catch(error){
    process.stderr.write((error instanceof Error?error.message:'TEST_REVIEW_TRIAGE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
