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

export const REVIEWED_CROSS_OWNER_FIXTURES=Object.freeze({
  'test/hub-boot-handoff-receipt.test.ts':Object.freeze({blob:'b43b45de2b6c85177ac7f0e15a66c3d321661d45',minimum:4,timeoutMs:180000}),
  'test/system-hub-controlled-cutover.test.ts':Object.freeze({blob:'494b60fc0bd67fe5832fd72e282e641ab9f072f4',minimum:11,timeoutMs:180000}),
  'test/ai03/system-dpapi-acceptance.test.ts':Object.freeze({blob:'aa4f935e814fa05af230383acd9a43e465d6eaa8',minimum:4,timeoutMs:360000}),
  'test/ai04/transactional-handoff-recovery-required.test.ts':Object.freeze({blob:'d2ca34974c160c94936a9e0c6697ccde5506cae6',minimum:3,timeoutMs:180000}),
  'test/ai04/recovery-script-rollback-boundaries.test.ts':Object.freeze({blob:'1facff206c85c1bb75cb60b17bc2f27bab89ac63',minimum:13,timeoutMs:180000}),
  'test/ai05/system-stage-plan-windows.test.ts':Object.freeze({blob:'e5b648e3b4bbbaa71108f5e345bff82d8775b4a9',minimum:2,timeoutMs:300000}),
  'test/windows-installer-command-root-trust.test.ts':Object.freeze({blob:'a1ab244910a6e8df0e5cc61b003c9e7d2136bdc7',minimum:3,timeoutMs:180000}),
  'test/windows-user-bundle-local-payload.test.ts':Object.freeze({blob:'39df7e3cf229b417440e12e8e78a45fe5034bab7',minimum:2,timeoutMs:180000}),
});
const SHA=/^[0-9a-f]{40}$/;
const MAX_BUFFER=2*1024*1024;
function deny(reason){throw Error('WINDOWS_CROSS_OWNER_FIXTURE_'+reason);}

export function validateFixtureSource(file,entry,bytes){
  const reviewed=Object.hasOwn(REVIEWED_CROSS_OWNER_FIXTURES,file)?REVIEWED_CROSS_OWNER_FIXTURES[file]:null;
  if(!reviewed)deny('UNREVIEWED_PATH');
  if(!SHA.test(reviewed.blob))deny('INVALID_REVIEW_PIN: '+file);
  if(!entry||entry.path!==file||entry.blob!==reviewed.blob||!Buffer.isBuffer(bytes))
    deny('SOURCE_REVIEW_REQUIRED: '+file);
  const actual=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(actual!==reviewed.blob)deny('WORKTREE_BLOB_MISMATCH: '+file);
  return reviewed;
}
export function reconcileFixtureResult(file,result){
  if(!Object.hasOwn(REVIEWED_CROSS_OWNER_FIXTURES,file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||
     typeof result.stdout!=='string')deny('PROCESS_FAILED');
  const counters=assertTapSummary(result.stdout,REVIEWED_CROSS_OWNER_FIXTURES[file].minimum);
  return {path:file,gitBlobSha:REVIEWED_CROSS_OWNER_FIXTURES[file].blob,result:'PASS',...counters};
}

/** Source admission failures abort; independent child failures are recorded
 * and never prevent later reviewed files from supplying their own evidence.
 * This helper is also exercised with synthetic results in contract tests.
 */
export function collectReviewedFixtureOutcomes(check,runOne){
  const paths=Object.keys(REVIEWED_CROSS_OWNER_FIXTURES);
  paths.forEach(check);
  const files=[];
  for(const file of paths){
    check(file);
    const {result,elapsedMs}=runOne(file);
    try{
      files.push({...reconcileFixtureResult(file,result),elapsedMs,timeoutMs:REVIEWED_CROSS_OWNER_FIXTURES[file].timeoutMs});
    }catch(error){
      files.push({path:file,gitBlobSha:REVIEWED_CROSS_OWNER_FIXTURES[file].blob,
        result:'FAIL',errorCode:result?.error?.code??null,exitCode:result?.status??null,
        signal:result?.signal??null,elapsedMs,timeoutMs:REVIEWED_CROSS_OWNER_FIXTURES[file].timeoutMs,
        reason:error instanceof Error&&error.message.startsWith('WINDOWS_CROSS_OWNER_FIXTURE_')
          ?'PROCESS_FAILED':'TAP_CONTRACT_FAILED'});
    }
  }
  return files;
}

export function summarizeReviewedFixtureOutcomes(files,trackedFileCount){
  const paths=Object.keys(REVIEWED_CROSS_OWNER_FIXTURES);
  if(!Array.isArray(files)||files.length!==paths.length||
     !Number.isSafeInteger(trackedFileCount)||trackedFileCount<paths.length||
     files.some((f,i)=>!f||f.path!==paths[i]||
       f.gitBlobSha!==REVIEWED_CROSS_OWNER_FIXTURES[paths[i]].blob||
       !['PASS','FAIL'].includes(f.result)))deny('INVALID_OUTCOME_SET');
  const passed=files.filter(f=>f.result==='PASS');
  for(const f of passed){
    if(!Number.isSafeInteger(f.pass)||f.pass<REVIEWED_CROSS_OWNER_FIXTURES[f.path].minimum||
       f.tests!==f.pass||f.fail!==0||f.skipped!==0||f.cancelled!==0||f.todo!==0)
      deny('INVALID_PASS_COUNTERS');
  }
  const failed=files.length-passed.length;
  return {acceptance:failed?'FAIL':'PASS',attemptedFileCount:files.length,
    executedFileCount:files.length,notRunFileCount:trackedFileCount-files.length,
    executionSemantics:'FILE_ATTEMPT_COUNTS_NOT_ALL_SUBTESTS_EXECUTED',
    statusCounts:{PASS:passed.length,FAIL:failed,SKIP:0,NOT_RUN:trackedFileCount-files.length},
    passedAssertions:passed.reduce((sum,f)=>sum+f.pass,0)};
}


const reviewedDependencies=Object.freeze({
  'scripts/ai03-system-dpapi-acceptance.ps1':'446a1f31466b9ee8b941be20175dc42ab01d366d',
  'scripts/Build-Nexowire-SystemHubStage.ps1':'612445bfa2bb74037223ee67d03c1150c0e4b622',
  'scripts/build-windows-user-bundle.ts':'3f71be3ce204e25b68fdf94d7bc33035e864f58f',
  'scripts/ai04-controlled-system-hub-cutover.ts':'8bfc5fbf83e2f85e4a93748b61f8ffcac547035a',
});
function assertReviewedDependencies(root){
  for(const [file,pin] of Object.entries(reviewedDependencies)){
    const identity=spawnSync('git',['rev-parse','HEAD:'+file],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    const clean=spawnSync('git',['diff','--no-ext-diff','--quiet','HEAD','--',file],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    const st=lstatSync(path.join(root,...file.split('/')));
    if(identity.error||identity.status!==0||identity.stdout.trim()!==pin||
       clean.error||clean.status!==0||!st.isFile()||st.isSymbolicLink())
      deny('DEPENDENCY_REVIEW_REQUIRED: '+file);
  }
}

export function executeReviewedWindowsFixtures(root,expected){
  if(process.platform!=='win32')deny('WINDOWS_REQUIRED');
  if(!SHA.test(expected??''))deny('EXPECTED_HEAD_REQUIRED');
  const {entries,report}=readTestInventory(root);
  if(report.commitSha!==expected)deny('HEAD_MISMATCH');
  assertReviewedDependencies(root);
  const indexed=new Map(entries.map(e=>[e.path,e]));
  const checked=file=>{
    assertReviewedDependencies(root);
    const abs=path.join(root,...file.split('/'));
    const stat=lstatSync(abs);
    if(!stat.isFile()||stat.isSymbolicLink())deny('NOT_REGULAR_FILE');
    validateFixtureSource(file,indexed.get(file),readFileSync(abs));
  };
  const files=collectReviewedFixtureOutcomes(checked,file=>{
    const started=Date.now();
    const result=spawnSync(process.execPath,[
      '--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',file,
    ],{cwd:root,encoding:'utf8',timeout:REVIEWED_CROSS_OWNER_FIXTURES[file].timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true});
    const elapsedMs=Date.now()-started;
    if(result.stdout)process.stderr.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    return {result,elapsedMs};
  });
  return {schemaVersion:2,sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,platform:process.platform,
    nodeVersion:process.version,trackedFileCount:entries.length,
    ...summarizeReviewedFixtureOutcomes(files,entries.length),
    scope:'REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY',
    physicalWindowsAcceptance:'NOT_INFERRED',files};
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--json')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const receipt=executeReviewedWindowsFixtures(root,process.env.NEXOWIRE_EXPECTED_COMMIT_SHA);
    process.stdout.write(JSON.stringify(receipt)+'\n');
    if(receipt.acceptance!=='PASS')process.exitCode=1;
  }catch(error){
    process.stderr.write((error instanceof Error?error.message:'WINDOWS_CROSS_OWNER_FIXTURE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
