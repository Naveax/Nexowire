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
export const RUNTIME_FIXTURES=Object.freeze({
  'test/mcp/ai07-transfer-startup.test.ts':Object.freeze({blob:'80e6a6f84757a9fb9ac768b3908afa92ee37a9be',minimum:5,timeoutMs:180000}),
  'test/ai03/native-effect-startup-boundary.test.ts':Object.freeze({blob:'ac0b8808742debe2d05d7ed76002fa6a959e5b5d',minimum:3,timeoutMs:180000}),
  'test/windows-user-bundle.test.ts':Object.freeze({blob:'c2d4adfbdb4f765a3c345c24e9a2d71c890dd1d5',minimum:4,timeoutMs:180000}),
  'test/ai05/core-broker-install-mode.test.ts':Object.freeze({blob:'4e21a7aabc860495881199ac9805c73cc622065a',minimum:4,timeoutMs:180000}),
  'test/ai05/core-existing-agent-broker.test.ts':Object.freeze({blob:'17fe80b78825299efa4f351ec4399a61728a978a',minimum:4,timeoutMs:180000}),
  'test/ai05/core-native-hotkey-alias.test.ts':Object.freeze({blob:'c79b488372677933dd7210fe501a6c94494821d0',minimum:1,timeoutMs:120000}),
  'test/windows-privileged-runtime-trust.test.ts':Object.freeze({blob:'779fb882a3ef1bfe36ad2e28702c19c87fc4f0f0',minimum:10,timeoutMs:180000}),
  'test/windows-runtime-shared-ancestor-acl.test.ts':Object.freeze({blob:'08d91da02316cdaf78192da8b795dd4f21186b78',minimum:2,timeoutMs:180000}),
  'test/mcp/ai08-native-agent-transfer-boundary.test.ts':Object.freeze({blob:'cd222c215ac2df066021de761b1988150c4abcd3',minimum:2,timeoutMs:240000}),
});
export const GROUPS=Object.freeze({
  runtime:Object.freeze({scope:'REVIEWED_WINDOWS_SIGNED_RUNTIME_INSTALLER_ACL_FIXTURES_ONLY',fixtures:RUNTIME_FIXTURES}),
  core:Object.freeze({scope:'REVIEWED_WINDOWS_CORE_NEGATIVE_SOURCE_FIXTURES_ONLY',fixtures:CORE_FIXTURES}),
  installer:Object.freeze({scope:'REVIEWED_WINDOWS_DISPOSABLE_INSTALLER_FIXTURES_ONLY',fixtures:INSTALLER_FIXTURES}),
});
const coreDependencies=Object.freeze({
  'src/agent/core-console-admission.ts':'2cc476df8c13bf9e7c3e83032dbe5d4e225a5eae',
  'src/agent/privileged-broker-effect-admission.ts':'32df088b3e8d4dfdcaceda5abd8bd9daec188e02',
  'src/agent/core-windows-mutation-dispatch.ts':'e8e34f4b8ff420efce6f78a37b65c48edf3d650b',
  'src/agent/privileged-broker.ts':'6fe4ade7e4f79fe981703717f6d3271d595b99a3',
});
const installerDependencies=Object.freeze({
  'scripts/smoke-windows-user-setup.ts':'1e2c9ab56121e89013c72fb595df02822093b7ce',
  'scripts/build-windows-user-bundle.ts':'3f71be3ce204e25b68fdf94d7bc33035e864f58f',
});
const runtimeDependencies=Object.freeze({
  'src/agent/privileged-broker.ts':'6fe4ade7e4f79fe981703717f6d3271d595b99a3',
  'src/agent/protected-transfer-startup.ts':'0d9077b2e1608c9a5bbf8e7faff31c7c7d739e01',
  'src/installer/protected-transfer-helper-lifecycle.ts':'84f9cce7ee56744308e81b8f838d87f54fb8eba7',
  'src/mcp/http.ts':'5d3cc338c34700f5d0adb0ba8bc9214de3749213',
  'src/mcp/protected-transfer-hub-startup.ts':'bbbdbe94857ae6d44b7fe18e5cb88e7f41b96cef',
  'src/runtime.ts':'463ec7146556c264212520d55ed91685fa390937',
  'src/security/protected-transfer-services-startup.ts':'52abb21d4c2cac592363e7923880b8596d20a61e',
  'src/agent/windows-core-consent-transport.ts':'bcf994f6d23bc139ce43b26dcb77f8e1fdaf9cab',
  'src/agent/windows-core-console-provider.ts':'2e305fbaefa8f3fdcbfe26d98aefc5e4564bd317',
  'scripts/build-windows-user-bundle.ts':'3f71be3ce204e25b68fdf94d7bc33035e864f58f',
  'src/agent/native-agent-lifecycle.ts':'5c054ee34c306f3490a2fabd3b7c8e4ff1b1c382',
  // Reviewed #1285 additive protected transfer path. Retain strict exact pin;
  // no fallback to unreviewed content or earlier receipt.
  'src/agent/native-agent.ts':'ffd22528e2c74111599cbbbd47c68a2d99556fea',
  'src/agent/native-transfer-wire.ts':'5d8091f6d87b21b4b2a4b0cb209a25d2bab574a4',
  'src/agent/native-transfer-publisher.ts':'e920d8a736aacc81882baefea156329b9d580ec5',
  'src/agent/native-transfer-io.ts':'11f887d00a479c5ff7200a269d5231a6120bc921',
  'src/agent/native-atomic-effect-admission.ts':'7799559aa34a311eecde9f2773020a8a49e89b5e',
  'src/agent/remote-mutation-cas.ts':'aaf39646fd125962c1ef4928643e362f32ad934f',
  'src/agent/path-policy.ts':'7c3d07497462fffbe2fcbd2d4b521eb734b72a99',
  'src/protocol/agent.ts':'6bd55d19f898021fd1e70e78045ddba656aaf4e5',
  'src/protocol/capabilities.ts':'f661b6e27794184bacf7dfbcf3f53e7fc5f5919d',
  'test/fixtures/agent-remote-cas-fixture.ts':'6d3e6e680543818d5c859409db291364be3ae1eb',
  'src/agent/windows-core-console-native.ts':'f3b7dddab82bc94075375866b12ee51e0ffb5909',
  'src/hub/hub-boot-lifecycle.ts':'daa88893c1b447b41fcfd8d91f9e5b312552d80c',
  'src/security/windows-privileged-runtime-trust.ts':'2eb3029f9790cd7b94aa7bf87711a2296e3d3df3',
  'src/agent/core-windows-mutation-dispatch.ts':'e8e34f4b8ff420efce6f78a37b65c48edf3d650b',
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
  const deps=group==='core'?coreDependencies:group==='runtime'?runtimeDependencies:installerDependencies;
  for(const [file,pin] of Object.entries(deps)){
    const abs=path.join(root,...file.split('/')),stat=lstatSync(abs);
    const id=spawnSync('git',['rev-parse','HEAD:'+file],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    if(!stat.isFile()||stat.isSymbolicLink()||id.error||id.status!==0||id.stdout.trim()!==pin||blob(readFileSync(abs))!==pin)
      deny('DEPENDENCY_REVIEW_REQUIRED: '+file);
  }
  if((group==='core'||group==='runtime')&&!/export const CORE_EXECUTOR_DISPATCH_ENABLED = false;/.test(readFileSync(path.join(root,'src/agent/core-windows-mutation-dispatch.ts'),'utf8')))
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
