/**
 * Reviewed, disposable Windows source tests only. Not physical acceptance.
 * No task mutations or production credentials; no caller-selected test paths.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {assertTapSummary} from './assert-tap-summary.mjs';

export const REVIEWED_STORAGE_FIXTURES=Object.freeze({
  'test/agent-operation-journal.test.ts':Object.freeze({blob:'e8db5f0ac93641145266518593e28a55bead90d2',minimum:12}),
  'test/guardian-sqlite-crash-recovery.test.ts':Object.freeze({blob:'c34bed39cb341da1c77601a05a5b0926bf7b94c3',minimum:2}),
  'test/ai06-sqlite-task-absence.test.ts':Object.freeze({blob:'4ddbd0ca392b7b2172a8cac1751fcf6f3372f441',minimum:2}),
  'test/journal-unknown-save-sticky.test.ts':Object.freeze({blob:'987c663a5337c0a48541e4d4f3b02cb5e20912d3',minimum:6}),
  'test/journal-save-admission.test.ts':Object.freeze({blob:'61d2c9b2b24c4336b109f2c8955e086661b2e0bc',minimum:2}),
  'test/journal-save-identity-integrity.test.ts':Object.freeze({blob:'a10929da4921564ac2eb3e39806883cc75470a27',minimum:2}),
  'test/system-hub-cutover-recovery.test.ts':Object.freeze({blob:'3327f05964007ac47eb86755fad207f1e81fc',minimum:3}),
});
const SHA=/^[0-9a-f]{40}$/;
const TIMEOUT_MS=180000;
const MAX_BUFFER=2*1024*1024;
function deny(reason){throw Error('WINDOWS_STORAGE_FIXTURE_'+reason);}

export function validateFixtureSource(file,entry,bytes){
  const reviewed=Object.hasOwn(REVIEWED_STORAGE_FIXTURES,file)?REVIEWED_STORAGE_FIXTURES[file]:null;
  if(!reviewed)deny('UNREVIEWED_PATH');
  if(!entry||entry.path!==file||entry.blob!==reviewed.blob||!Buffer.isBuffer(bytes))
    deny('SOURCE_REVIEW_REQUIRED');
  const actual=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(actual!==reviewed.blob)deny('WORKTREE_BLOB_MISMATCH');
  return reviewed;
}
export function reconcileFixtureResult(file,result){
  if(!Object.hasOwn(REVIEWED_STORAGE_FIXTURES,file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||
     typeof result.stdout!=='string')deny('PROCESS_FAILED');
  const counters=assertTapSummary(result.stdout,REVIEWED_STORAGE_FIXTURES[file].minimum);
  return {path:file,gitBlobSha:REVIEWED_STORAGE_FIXTURES[file].blob,result:'PASS',...counters};
}

export function executeReviewedWindowsFixtures(root,expected){
  if(process.platform!=='win32')deny('WINDOWS_REQUIRED');
  if(!SHA.test(expected??''))deny('EXPECTED_HEAD_REQUIRED');
  const {entries,report}=readTestInventory(root);
  if(report.commitSha!==expected)deny('HEAD_MISMATCH');
  const indexed=new Map(entries.map(e=>[e.path,e]));
  const checked=file=>{
    const abs=path.join(root,...file.split('/'));
    const stat=lstatSync(abs);
    if(!stat.isFile()||stat.isSymbolicLink())deny('NOT_REGULAR_FILE');
    validateFixtureSource(file,indexed.get(file),readFileSync(abs));
  };
  const paths=Object.keys(REVIEWED_STORAGE_FIXTURES);
  // Validate all before launching anything; re-check immediately before launch.
  paths.forEach(checked);
  const files=[];
  for(const file of paths){
    checked(file);
    const started=Date.now();
    const result=spawnSync(process.execPath,[
      '--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',file,
    ],{cwd:root,encoding:'utf8',timeout:TIMEOUT_MS,maxBuffer:MAX_BUFFER,windowsHide:true});
    const elapsedMs=Date.now()-started;
    if(result.stdout)process.stderr.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    try{
      files.push({...reconcileFixtureResult(file,result),elapsedMs,timeoutMs:TIMEOUT_MS});
    }catch(error){
      // Failure metadata only; never print an input secret or environment.
      process.stderr.write(JSON.stringify({sourceCommitSha:report.commitSha,path:file,
        result:'FAIL',errorCode:result.error?.code??null,exitCode:result.status,
        signal:result.signal,elapsedMs,timeoutMs:TIMEOUT_MS})+'\n');
      throw error;
    }
  }
  const executed=files.length;
  return {schemaVersion:1,sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,platform:process.platform,
    nodeVersion:process.version,trackedFileCount:entries.length,
    executedFileCount:executed,notRunFileCount:entries.length-executed,
    statusCounts:{PASS:executed,FAIL:0,SKIP:0,NOT_RUN:entries.length-executed},
    passedAssertions:files.reduce((sum,f)=>sum+f.pass,0),
    scope:'REVIEWED_WINDOWS_STORAGE_AND_RECOVERY_SOURCE_FIXTURES_ONLY',
    physicalWindowsAcceptance:'NOT_INFERRED',files};
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--json')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    process.stdout.write(JSON.stringify(executeReviewedWindowsFixtures(root,
      process.env.NEXOWIRE_EXPECTED_COMMIT_SHA))+'\n');
  }catch(error){
    process.stderr.write((error instanceof Error?error.message:'WINDOWS_STORAGE_FIXTURE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
