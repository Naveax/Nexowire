/** Reviewed, disposable hosted Windows fixture tests. No real native CORE activation. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {assertTapSummary} from './assert-tap-summary.mjs';
export const CORE_FIXTURES=Object.freeze({
  'test/core-console-admission.test.ts':Object.freeze({blob:'fba046e725826ae332cf83cc2f3f48acbcb0b526',minimum:20,timeoutMs:240000}),
  'test/privileged-broker-effect-admission.test.ts':Object.freeze({blob:'eb93e7cadc6278e189ab2547afa4be047027b0e0',minimum:29,timeoutMs:300000}),
  'test/core-windows-mutation-dispatch.test.ts':Object.freeze({blob:'08e6bcd4e1d9629407d9fa634956b2377c4cfa3c',minimum:15,timeoutMs:180000}),
});
export const INSTALLER_FIXTURES=Object.freeze({
  'test/windows-public-bootstrap-immutable-sha.test.ts':Object.freeze({blob:'ac7ffe8a39c3a751bc7cdbe2405e48f1a6706d48',minimum:2,timeoutMs:240000}),
  'test/ai05/windows-setup-regressions.test.ts':Object.freeze({blob:'6c97aa80226476d69a7b5c0868b189be0a35d7cf',minimum:8,timeoutMs:480000}),
});
export const GROUPS=Object.freeze({
  core:Object.freeze({scope:'REVIEWED_WINDOWS_CORE_NEGATIVE_SOURCE_FIXTURES_ONLY',fixtures:CORE_FIXTURES}),
  installer:Object.freeze({scope:'REVIEWED_WINDOWS_DISPOSABLE_INSTALLER_FIXTURES_ONLY',fixtures:INSTALLER_FIXTURES}),
});
const coreDependencies=Object.freeze({
  'src/agent/core-console-admission.ts':'2cc476df8c13bf9e7c3e83032dbe5d4e225a5eae',
  'src/agent/privileged-broker-effect-admission.ts':'32df088b3e8d4dfdcaceda5abd8bd9daec188e02',
  'src/agent/core-windows-mutation-dispatch.ts':'e8e34f4b8ff420efce6f78a37b65c48edf3d650b',
  'src/agent/privileged-broker.ts':'481b23c7ba0c9a7b3f5b879828d0fccb12428001',
});
const installerDependencies=Object.freeze({
  'scripts/smoke-windows-user-setup.ts':'1e2c9ab56121e89013c72fb595df02822093b7ce',
  'scripts/build-windows-user-bundle.ts':'3f71be3ce204e25b68fdf94d7bc33035e864f58f',
});
const sha=/^[a-f0-9]{40}$/;
const deny=reason=>{throw Error('WINDOWS_INSTALLER_CORE_FIXTURE_'+reason)};
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
function selected(group){
  if(!Object.hasOwn(GROUPS,group))deny('GROUP');
  return GROUPS[group];
}
export function validateGroupSource(group,file,entry,bytes){
  const plan=selected(group).fixtures,pin=Object.hasOwn(plan,file)?plan[file]:null;
  if(!pin||!entry||entry.path!==file||entry.blob!==pin.blob||!Buffer.isBuffer(bytes)||blob(bytes)!==pin.blob)
    deny('SOURCE_REVIEW_REQUIRED: '+file);
  return pin;
}
export function reconcileGroupResult(group,file,result){
  const plan=selected(group).fixtures;
  if(!Object.hasOwn(plan,file))deny('UNREVIEWED_PATH');
  if(!result||result.error||result.signal!=null||result.status!==0||typeof result.stdout!=='string')deny('PROCESS_FAILED');
  return {path:file,gitBlobSha:plan[file].blob,result:'PASS',...assertTapSummary(result.stdout,plan[file].minimum)};
}
function assertDependencies(group,root){
  const deps=group==='core'?coreDependencies:installerDependencies;
  for(const [file,pin] of Object.entries(deps)){
    const abs=path.join(root,...file.split('/')),stat=lstatSync(abs);
    const id=spawnSync('git',['rev-parse','HEAD:'+file],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    if(!stat.isFile()||stat.isSymbolicLink()||id.error||id.status!==0||id.stdout.trim()!==pin||blob(readFileSync(abs))!==pin)
      deny('DEPENDENCY_REVIEW_REQUIRED: '+file);
  }
  if(group==='core'&&!/export const CORE_EXECUTOR_DISPATCH_ENABLED = false;/.test(readFileSync(path.join(root,'src/agent/core-windows-mutation-dispatch.ts'),'utf8')))
    deny('CORE_MUST_REMAIN_DISABLED');
  if(group==='installer'&&process.env.NEXOWIRE_AI05_RUN_BUNDLE_SMOKE!=='1')deny('BUNDLE_SMOKE_OPT_IN_REQUIRED');
}
export function executeGroup(group,root,expected){
  const plan=selected(group);
  if(process.platform!=='win32'||!sha.test(expected??''))deny('WINDOWS_EXACT_HEAD_REQUIRED');
  const {entries,report}=readTestInventory(root);
  if(report.commitSha!==expected)deny('HEAD_MISMATCH');
  const indexed=new Map(entries.map(e=>[e.path,e]));
  const check=file=>{
    assertDependencies(group,root);
    const abs=path.join(root,...file.split('/')),st=lstatSync(abs);
    if(!st.isFile()||st.isSymbolicLink())deny('NOT_REGULAR_FILE');
    validateGroupSource(group,file,indexed.get(file),readFileSync(abs));
  };
  const paths=Object.keys(plan.fixtures);paths.forEach(check);
  const files=[];
  for(const file of paths){
    check(file);
    const timeoutMs=plan.fixtures[file].timeoutMs,start=Date.now();
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',file],
      {cwd:root,encoding:'utf8',timeout:timeoutMs,maxBuffer:8*1024*1024,windowsHide:true});
    if(result.stdout)process.stderr.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    const elapsedMs=Date.now()-start;
    try{files.push({...reconcileGroupResult(group,file,result),elapsedMs,timeoutMs});}
    catch{
      files.push({path:file,gitBlobSha:plan.fixtures[file].blob,result:'FAIL',
        elapsedMs,timeoutMs,errorCode:result.error?.code??null,exitCode:result.status,signal:result.signal});
    }
  }
  const passed=files.filter(f=>f.result==='PASS'),failed=files.length-passed.length;
  const notRun=entries.length-files.length;
  return {schemaVersion:2,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,
    platform:process.platform,nodeVersion:process.version,trackedFileCount:entries.length,
    attemptedFileCount:files.length,executedFileCount:files.length,notRunFileCount:notRun,
    statusCounts:{PASS:passed.length,FAIL:failed,SKIP:0,NOT_RUN:notRun},
    passedAssertions:passed.reduce((n,f)=>n+f.pass,0),acceptance:failed?'FAIL':'PASS',
    executionSemantics:'FILE_ATTEMPT_COUNTS_NOT_ALL_SUBTESTS_EXECUTED',
    scope:plan.scope,physicalWindowsAcceptance:'NOT_INFERRED',files};
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try{
    if(process.argv.length!==4||process.argv[3]!=='--json')deny('USAGE');
    const r=executeGroup(process.argv[2],path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),process.env.NEXOWIRE_EXPECTED_COMMIT_SHA);
    process.stdout.write(JSON.stringify(r)+'\n');
    if(r.acceptance!=='PASS')process.exitCode=1;
  }catch(e){process.stderr.write((e instanceof Error?e.message:'UNKNOWN')+'\n');process.exitCode=1;}
}
