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

export const REVIEWED_BROKER_FIXTURES=Object.freeze({
  'test/privileged-broker-root-boundary.test.ts':Object.freeze({blob:'5ece7b2d5668bd26279ea809b831c1831c54c17f',minimum:4}),
  'test/privileged-broker-shell-trust.test.ts':Object.freeze({blob:'c3879222455f63db7cc099862e837af7a4c29c1f',minimum:4}),
  'test/privileged-broker-elevation-shell-trust.test.ts':Object.freeze({blob:'b090af47ad77a8b8303ddb13afa201f7b8b6f0fd',minimum:3}),
  'test/privileged-broker-task-control-identity.test.ts':Object.freeze({blob:'dffaf30e54ff07e0316f2ac32ffad44db1ab7809',minimum:2}),
  'test/windows-prelogin-handoff.test.ts':Object.freeze({blob:'c01f2c1b83262d3b096c1612ea98a4d488b9a3cc',minimum:7}),
  'test/windows-uac-shell-trust.test.ts':Object.freeze({blob:'f58ea473c633c3fe91571da59f4a915f1bb661a2',minimum:3}),
});
const SHA=/^[0-9a-f]{40}$/;
const TIMEOUT_MS=180000;
const MAX_BUFFER=2*1024*1024;
function deny(reason){throw Error('WINDOWS_BROKER_FIXTURE_'+reason);}

export function validateFixtureSource(file,entry,bytes){
  const reviewed=Object.hasOwn(REVIEWED_BROKER_FIXTURES,file)?REVIEWED_BROKER_FIXTURES[file]:null;
  if(!reviewed)deny('UNREVIEWED_PATH');
  if(!entry||entry.path!==file||entry.blob!==reviewed.blob||!Buffer.isBuffer(bytes))
    deny('SOURCE_REVIEW_REQUIRED');
  const actual=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(actual!==reviewed.blob)deny('WORKTREE_BLOB_MISMATCH');
  return reviewed;
}
export function reconcileFixtureResult(file,result){
  if(!Object.hasOwn(REVIEWED_BROKER_FIXTURES,file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||
     typeof result.stdout!=='string')deny('PROCESS_FAILED');
  const counters=assertTapSummary(result.stdout,REVIEWED_BROKER_FIXTURES[file].minimum);
  return {path:file,gitBlobSha:REVIEWED_BROKER_FIXTURES[file].blob,result:'PASS',...counters};
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
  const paths=Object.keys(REVIEWED_BROKER_FIXTURES);
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
    scope:'REVIEWED_WINDOWS_BROKER_AND_PRELOGIN_SOURCE_FIXTURES_ONLY',
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
    process.stderr.write((error instanceof Error?error.message:'WINDOWS_BROKER_FIXTURE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
