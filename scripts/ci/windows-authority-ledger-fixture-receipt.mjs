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

export const REVIEWED_AUTHORITY_LEDGER_FIXTURES=Object.freeze({
  'test/idempotency-journal-concurrency.test.ts':Object.freeze({blob:'f8b86d4405a0ebd4f0b5b3eccd04dc5ab93c0e02',minimum:1}),
  'test/guardian-sqlite-replay-ledger.test.ts':Object.freeze({blob:'85a8958f7b4480ff4f4e9011a1f07e5337eb16dc',minimum:14}),
  'test/guardian-sqlite-signed-command.test.ts':Object.freeze({blob:'3ef6a0da300300847784745b76764f4d1bc3fe15',minimum:3}),
  'test/privileged-broker-denial.test.ts':Object.freeze({blob:'c8daa89bb4233f9f2b4cc186aa1a8dd94ea7425f',minimum:2}),
  'test/privileged-broker-health.test.ts':Object.freeze({blob:'1e1965b21fab810896dcbcecc60ddbeb56e0a683',minimum:1}),
  'test/windows-programdata-acl.test.ts':Object.freeze({blob:'c137ace0c2f00386e785f033adaa638bf436a40a',minimum:12}),
  'test/windows-uac-status.test.ts':Object.freeze({blob:'ce60dada49a8f9e6cad6c1afe2f5e645115e2d2d',minimum:6}),
});
const SHA=/^[0-9a-f]{40}$/;
const TIMEOUT_MS=180000;
const MAX_BUFFER=2*1024*1024;
function deny(reason){throw Error('WINDOWS_AUTHORITY_LEDGER_FIXTURE_'+reason);}

export function validateFixtureSource(file,entry,bytes){
  const reviewed=Object.hasOwn(REVIEWED_AUTHORITY_LEDGER_FIXTURES,file)?REVIEWED_AUTHORITY_LEDGER_FIXTURES[file]:null;
  if(!reviewed)deny('UNREVIEWED_PATH');
  if(!SHA.test(reviewed.blob))deny('INVALID_REVIEW_PIN: '+file);
  if(!entry||entry.path!==file||entry.blob!==reviewed.blob||!Buffer.isBuffer(bytes))
    deny('SOURCE_REVIEW_REQUIRED: '+file);
  const actual=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(actual!==reviewed.blob)deny('WORKTREE_BLOB_MISMATCH: '+file);
  return reviewed;
}
export function reconcileFixtureResult(file,result){
  if(!Object.hasOwn(REVIEWED_AUTHORITY_LEDGER_FIXTURES,file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||
     typeof result.stdout!=='string')deny('PROCESS_FAILED');
  const counters=assertTapSummary(result.stdout,REVIEWED_AUTHORITY_LEDGER_FIXTURES[file].minimum);
  return {path:file,gitBlobSha:REVIEWED_AUTHORITY_LEDGER_FIXTURES[file].blob,result:'PASS',...counters};
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
  const paths=Object.keys(REVIEWED_AUTHORITY_LEDGER_FIXTURES);
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
    scope:'REVIEWED_WINDOWS_AUTHORITY_AND_LEDGER_SOURCE_FIXTURES_ONLY',
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
    process.stderr.write((error instanceof Error?error.message:'WINDOWS_AUTHORITY_LEDGER_FIXTURE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
