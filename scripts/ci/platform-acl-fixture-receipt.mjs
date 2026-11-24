/**
 * Exact-source platform fixture receipts. Expected OS skips remain SKIP;
 * an accepted matrix job must not be mistaken for whole-file PASS.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {assertTapSummary} from './assert-tap-summary.mjs';

export const MIXED_FILE='test/privileged-broker-task-control-acl.test.ts';
export const MIXED_CASES=Object.freeze([
  'Broker startup verifies protected ACLs, while emergency stop remains possible',
  'elevated Broker install verifies protected parent before persisting any secret or task',
  'Broker start preflight source chain detects parent and launcher changes during ACL audit',
  'Non-Windows Broker lifecycle mutations reject before invoking ScheduledTasks',
  'Unauthorized Broker root override is rejected before task lookup',
  'Read-only Windows ACL verifier rejects a temporary user-owned launcher',
]);
const shared=Object.freeze({[MIXED_FILE]:Object.freeze({
  blob:'950070b2e8c8599ed0b67f88dae219ff699e8ccf',minimum:6,mixed:true,
})});
export const PLATFORM_FIXTURES=Object.freeze({
  win32:Object.freeze({...shared,
    'test/windows-local-listener-owner.test.ts':Object.freeze({blob:'d9fd6e154772ec1bb5573b92852f5fc8db211eea',minimum:3}),
    'test/windows-runtime-acl-audit.test.ts':Object.freeze({blob:'2aaecabe2f6cfabb33c3df6321ac70090b473571',minimum:3}),
    'test/windows-generic-acl-readonly-audit.test.ts':Object.freeze({blob:'9afc63a923e0f98bc0eea1892c50465eefe856fb',minimum:3}),
    'test/windows-private-acl-generic.test.ts':Object.freeze({blob:'c507f18bd6296c28c009600ae611f40ed22eee58',minimum:2}),
  }),
  linux:Object.freeze({...shared,
    // The Windows fixture silently returns on symlink EPERM. Only the Linux
    // path is admitted here; its symlink assertion cannot take that return.
    'test/guardian-sqlite-sidecar-preflight.test.ts':Object.freeze({blob:'9b53426569986946e664c5d21838f46f7b295848',minimum:9}),
  }),
});
const SHA=/^[0-9a-f]{40}$/;
const TIMEOUT=180000;
function deny(code){throw Error('PLATFORM_ACL_FIXTURE_'+code);}
export function expectedMixedStates(platform){
  if(!Object.hasOwn(PLATFORM_FIXTURES,platform))deny('PLATFORM');
  return MIXED_CASES.map((name,i)=>({name,result:
    (platform==='win32'?i===3:i===4||i===5)?'SKIP':'PASS'}));
}

/** Exactly six flat Node TAP cases, no unknown or moved SKIP. */
export function reconcileMixedTap(tap,platform){
  if(typeof tap!=='string')deny('TAP_TYPE');
  const expected=expectedMixedStates(platform);
  const lines=tap.split(/\r?\n/);
  const cases=[];
  const footer=Object.create(null);
  let planCount=0;
  for(const line of lines){
    if(/^not ok\b/.test(line))deny('TAP_FAILED');
    if(/^ok\b/.test(line)){
      const m=/^ok ([1-9]\d*) - (.*?)( # SKIP)?$/.exec(line);
      if(!m||Number(m[1])!==cases.length+1||m[2].includes(' # TODO'))deny('TAP_CASE');
      cases.push({name:m[2],result:m[3]?'SKIP':'PASS'});
    }
    if(/^1\.\./.test(line)){
      if(line!=='1..6'||++planCount!==1)deny('TAP_PLAN');
    }
    const m=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9]\d*)$/.exec(line);
    if(m){
      if(Object.hasOwn(footer,m[1])||!Number.isSafeInteger(Number(m[2])))deny('TAP_FOOTER');
      footer[m[1]]=Number(m[2]);
    }
  }
  if(planCount!==1||cases.length!==expected.length||
     cases.some((x,i)=>x.name!==expected[i].name||x.result!==expected[i].result))
    deny('UNEXPECTED_CASE_OR_SKIP');
  const skipped=expected.filter(x=>x.result==='SKIP').length;
  const wanted={tests:6,pass:6-skipped,fail:0,cancelled:0,skipped,todo:0};
  for(const [key,value] of Object.entries(wanted))
    if(footer[key]!==value)deny('TAP_FOOTER');
  return {...wanted,result:'SKIP',caseStates:cases};
}
export function reconcilePlatformResult(file,result,platform){
  if(!Object.hasOwn(PLATFORM_FIXTURES,platform)||
     !Object.hasOwn(PLATFORM_FIXTURES[platform],file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||
     typeof result.stdout!=='string')deny('PROCESS_FAILED');
  const pin=PLATFORM_FIXTURES[platform][file];
  const counts=pin.mixed?reconcileMixedTap(result.stdout,platform):
    {...assertTapSummary(result.stdout,pin.minimum),result:'PASS'};
  return {path:file,gitBlobSha:pin.blob,...counts};
}
export function verifyPlatformFixtureBytes(file,entry,bytes,platform){
  const plan=Object.hasOwn(PLATFORM_FIXTURES,platform)?PLATFORM_FIXTURES[platform]:null;
  const pin=plan&&Object.hasOwn(plan,file)?plan[file]:null;
  if(!pin||!SHA.test(pin.blob))deny('UNREVIEWED_PATH');
  if(!entry||entry.path!==file||entry.blob!==pin.blob||!Buffer.isBuffer(bytes))
    deny('SOURCE_REVIEW_REQUIRED: '+file);
  if(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==pin.blob)
    deny('WORKTREE_BLOB_MISMATCH: '+file);
}
export function executePlatformFixtures(root,expected){
  const platform=process.platform;
  if(!Object.hasOwn(PLATFORM_FIXTURES,platform))deny('PLATFORM');
  if(!SHA.test(expected??''))deny('EXPECTED_HEAD_REQUIRED');
  const {entries,report}=readTestInventory(root);
  if(report.commitSha!==expected)deny('HEAD_MISMATCH');
  const plan=PLATFORM_FIXTURES[platform];
  const tracked=new Map(entries.map(e=>[e.path,e]));
  const check=file=>{
    const abs=path.join(root,...file.split('/'));
    const stat=lstatSync(abs);
    if(!stat.isFile()||stat.isSymbolicLink())deny('NOT_REGULAR_FILE');
    verifyPlatformFixtureBytes(file,tracked.get(file),readFileSync(abs),platform);
  };
  const selected=Object.keys(plan);
  selected.forEach(check);
  const files=[];
  for(const file of selected){
    check(file);
    const started=Date.now();
    const r=spawnSync(process.execPath,[
      '--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',file,
    ],{cwd:root,encoding:'utf8',timeout:TIMEOUT,maxBuffer:2*1024*1024,windowsHide:true});
    const elapsedMs=Date.now()-started;
    if(r.stdout)process.stderr.write(r.stdout);
    if(r.stderr)process.stderr.write(r.stderr);
    try{files.push({...reconcilePlatformResult(file,r,platform),elapsedMs,timeoutMs:TIMEOUT});}
    catch(error){
      process.stderr.write(JSON.stringify({sourceCommitSha:report.commitSha,path:file,
        result:'FAIL',errorCode:r.error?.code??null,exitCode:r.status,
        signal:r.signal,elapsedMs,timeoutMs:TIMEOUT})+'\n');
      throw error;
    }
  }
  const pass=files.filter(f=>f.result==='PASS').length;
  const skip=files.filter(f=>f.result==='SKIP').length;
  const notRun=entries.length-files.length;
  return {schemaVersion:1,sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,platform,nodeVersion:process.version,
    trackedFileCount:entries.length,executedFileCount:files.length,
    fullyPassedFileCount:pass,notRunFileCount:notRun,
    statusCounts:{PASS:pass,FAIL:0,SKIP:skip,NOT_RUN:notRun},
    passedAssertions:files.reduce((n,f)=>n+f.pass,0),
    skippedAssertions:files.reduce((n,f)=>n+f.skipped,0),
    scope:'REVIEWED_PLATFORM_ACL_AND_SIDECAR_SOURCE_FIXTURES_ONLY',
    physicalWindowsAcceptance:'NOT_INFERRED',files};
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--json')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    process.stdout.write(JSON.stringify(executePlatformFixtures(root,
      process.env.NEXOWIRE_EXPECTED_COMMIT_SHA))+'\n');
  }catch(error){
    process.stderr.write((error instanceof Error?error.message:'PLATFORM_ACL_FIXTURE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
