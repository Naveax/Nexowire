import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {readTestInventory} from './test-inventory.mjs';
const tests={
 'test/ai05/protected-transfer-helper-lifecycle.test.ts':['bf56b8102ad4f3642cb784072668a21d68066693',15],
 'test/ai05/transfer-flush-artifact.test.ts':['fe6591365f963c790ab99148807efde82231ed6b',4],
 'test/ai04/signed-sqlite-rollback-review.test.ts':['9d2a97d813232c3bb541398b50a056aeed1810f1',5],
 'test/ai05/signed-sqlite-helper-review.test.ts':['5c6eaf4cf8797b35d389b50f0909d435d7b66002',1]
};
const pins={
 '.gitattributes':'c039ea0d6cdd0a0551d278dc728c257973164c5b',
 'src/installer/protected-transfer-helper-lifecycle.ts':'84f9cce7ee56744308e81b8f838d87f54fb8eba7',
 'src/agent/protected-transfer-startup.ts':'76ca0caa424020f18aff4a22af63d92be3e89191',
 'src/security/windows-programdata-acl.ts':'55d5814efd87f66e3ff553b415c42f37e23fce12',
 'src/security/windows-privileged-runtime-trust.ts':'2eb3029f9790cd7b94aa7bf87711a2296e3d3df3',
 'native/windows-transfer-volume-flush.cs':'7a62bf6c027544dfceb14f3ca939d7d76eb2ced9',
 'scripts/Build-Nexowire-TransferFlushArtifact.ps1':'bece860ec43b79eeb7542f01b0cd531f024f50a5',
 'scripts/ci/ai05-protected-helper-fixture.mjs':'b501bb91a8b7fca1ba8a6cb050715a1187813a5c',
 'scripts/ci/ai05-protected-helper-fixture.ps1':'cbad1e0433724f37422b0ae83285e9947c5cf7c7',
 'scripts/ci/ai05-test-signed-native-helper.ps1':'7362223ac095b9860862917862cf7c5869b541d0',
 'scripts/ai02-signed-sqlite-rollback-review.ts':'0be381cafd8c99fbb99e1bb082752b0f0a563bbe',
 'scripts/ai05-signed-sqlite-helper-review.ts':'e3e86f3225bec8699490a7e435024d3f778ced96',
 'src/security/protected-helper-rollback-guard.ts':'6bef386ac025cb543a8381c6ba59787b427d3967',
 'src/security/core-runtime-package-manifest.ts':'5f432bfe8cfe2f83095c0b4ad1698a0da367e083',
 'scripts/ai04-state-snapshot-proof.ts':'20c9dd4f295fdcd2843bacc7028cbba099cb0e59',
 ...Object.fromEntries(Object.entries(tests).map(([f,[b]])=>[f,b]))
};
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const sha=(b,algo='sha256')=>createHash(algo).update(b).digest('hex');
const hash=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
 process.versions.node.split('.')[0]!==process.env.NX_EXPECTED_NODE||!/^\d+$/.test(process.env.NX_JOB_ID??'')||
 !/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw Error('HOSTED_EXACT_WINDOWS_REQUIRED');
const {report,entries}=readTestInventory(process.cwd());
if(report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||git('rev-parse','HEAD')!==report.commitSha)throw Error('HEAD_MISMATCH');
const crlfFiles=new Set(['scripts/Build-Nexowire-TransferFlushArtifact.ps1','scripts/ci/ai05-protected-helper-fixture.ps1','scripts/ci/ai05-test-signed-native-helper.ps1']);
function check(){for(const [f,b] of Object.entries(pins)){
 const st=lstatSync(f);
 if(!st.isFile()||st.isSymbolicLink()||git('rev-parse','HEAD:'+f)!==b)throw Error('PIN_MISMATCH:'+f);
 const actual=readFileSync(f);
 if(crlfFiles.has(f)){
  // The exact pinned .gitattributes mandates CRLF for PowerShell. Compare
  // raw checkout bytes to the sole allowed materialization of the pinned
  // LF Git blob, rather than silently normalizing untrusted working bytes.
  if(hash(readFileSync('.gitattributes'))!==pins['.gitattributes']||
     git('check-attr','eol','--',f)!==f+': eol: crlf')throw Error('EOL_POLICY_MISMATCH:'+f);
  const canonical=execFileSync('git',['cat-file','blob',b],{maxBuffer:8*1024*1024});
  const text=canonical.toString('utf8');
  if(hash(canonical)!==b||!Buffer.from(text,'utf8').equals(canonical)||text.includes('\r')||
     !actual.equals(Buffer.from(text.replaceAll('\n','\r\n'),'utf8')))throw Error('CRLF_CHECKOUT_MISMATCH:'+f);
 }else if(hash(actual)!==b)throw Error('PIN_MISMATCH:'+f);
}}
check();
for(const [f,[b]] of Object.entries(tests))if(!entries.some(e=>e.path===f&&e.blob===b))throw Error('INVENTORY_MISMATCH:'+f);
const dir='ai08-installer-receipts';mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,nodeVersion:process.version,platform:process.platform,runId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,scope:'HOSTED_INSTALLER_LIFECYCLE_ONLY',pins,files:[],signedStorageFixture:'NOT_RUN',testSignedNativeFixture:'NOT_RUN',productionAcceptance:false};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
for(const [file,[blob,expected]] of Object.entries(tests)){
 check();
 const r={file,blob,expected,status:'FAIL'};receipt.files.push(r);
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',file],{encoding:'utf8',timeout:480000,maxBuffer:8*1024*1024,windowsHide:true});
 const tap=child.stdout??'';writeFileSync(path.join(dir,path.basename(file)+'.tap'),tap);process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
 r.tapSha256=sha(tap);
 try{if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');r.counts=assertTapSummary(tap,expected);if(r.counts.tests!==expected)throw Error('EXACT_COUNT_MISMATCH');r.status='PASS';}catch(e){r.failure=e.message;}
 save();
}
if(receipt.files.every(f=>f.status==='PASS')){
 check();
 const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File','scripts/ci/ai05-protected-helper-fixture.ps1'],{encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024,windowsHide:true});
 const log=child.stdout??'';writeFileSync(path.join(dir,'signed-storage.log'),log);process.stdout.write(log);if(child.stderr)process.stderr.write(child.stderr);
 receipt.signedStorageFixture='FAIL';receipt.signedStorageLogSha256=sha(log);
 try{
  if(child.error||child.signal||child.status!==0)throw Error('SIGNED_STORAGE_PROCESS_FAILED');
  const found=log.split(/\r?\n/).filter(l=>l.startsWith('{"scope":"HOSTED_WINDOWS_INERT_SIGNED_ARTIFACT_FIXTURE"'));
  if(found.length!==1)throw Error('SIGNED_STORAGE_RECEIPT_MISSING_OR_DUPLICATE');
  const f=JSON.parse(found[0]);if(f.node!==process.versions.node||f.operations!==4||f.wrongSignerDenied!==true||f.aclVerified!==true||
   f.sqliteWalShmAndSentinelsPreserved!==true||f.sqliteQuickCheck!=='ok'||f.syntheticSelectionAuthority!==true||f.nexowireHelperSigned!==false||f.helperExecuted!==false||f.productionAcceptance!==false)throw Error('SIGNED_STORAGE_RECEIPT_MISMATCH');
  check();receipt.signedStorageFixture='PASS';receipt.storage=f;
 }catch(e){receipt.storageFailure=e.message;}
 save();
}
if(receipt.signedStorageFixture==='PASS'){
 check();
 const phaseLog=path.resolve(dir,'test-signed-native.phases.log');
 writeFileSync(phaseLog,'',{flag:'wx'});
 const started=performance.now();
 const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File','scripts/ci/ai05-test-signed-native-helper.ps1'],{encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024,windowsHide:true,env:{...process.env,AI05_NATIVE_PHASE_LOG:phaseLog}});
 const phases=readFileSync(phaseLog,'utf8');
 const stderr=child.stderr??'';
 writeFileSync(path.join(dir,'test-signed-native.stderr.log'),stderr);
 receipt.testSignedNativeProcess={status:child.status,signal:child.signal,errorCode:child.error?.code??null,elapsedMs:Math.round(performance.now()-started),stderrSha256:sha(stderr),phaseLogSha256:sha(phases),lastPhase:phases.trim().split(/\r?\n/).at(-1)??null};
 console.log(JSON.stringify({scope:'HOSTED_WINDOWS_NATIVE_PROCESS_DIAGNOSTIC',...receipt.testSignedNativeProcess}));
 process.stdout.write(phases);
 const log=child.stdout??'';writeFileSync(path.join(dir,'test-signed-native.log'),log);process.stdout.write(log);if(child.stderr)process.stderr.write(child.stderr);
 receipt.testSignedNativeFixture='FAIL';receipt.testSignedNativeLogSha256=sha(log);
 try{
  if(child.error||child.signal||child.status!==0)throw Error('TEST_SIGNED_NATIVE_PROCESS_FAILED:'+(child.error?.code??child.signal??child.status));
  if(!/ COMPLETE\r?\n$/.test(phases))throw Error('TEST_SIGNED_NATIVE_PHASE_INCOMPLETE');
  const find=scope=>{const rows=log.split(/\r?\n/).filter(l=>l.startsWith('{"scope":"'+scope+'"'));if(rows.length!==1)throw Error('TEST_SIGNED_NATIVE_RECEIPT_MISSING_OR_DUPLICATE');return JSON.parse(rows[0]);};
  const f=find('HOSTED_WINDOWS_TEST_SIGNED_NEXOWIRE_HELPER_FIXTURE'),cleanup=find('HOSTED_WINDOWS_TEST_SIGNING_CLEANUP');
  if(f.node!==process.versions.node||f.operations!==4||f.wrongSignerDenied!==true||f.aclVerified!==true||
   f.sqliteWalShmAndSentinelsPreserved!==true||f.sqliteQuickCheck!=='ok'||f.syntheticSelectionAuthority!==true||
   f.nexowireHelperSigned!==true||f.fixtureSignature!==true||f.productionSigner!==false||f.helperExecuted!==false||f.productionAcceptance!==false||
   cleanup.testTrustRemoved!==true||cleanup.privateKeysRemoved!==true||cleanup.buildFilesRemoved!==true||cleanup.productionSigner!==false)
   throw Error('TEST_SIGNED_NATIVE_RECEIPT_MISMATCH');
  check();receipt.testSignedNativeFixture='PASS';receipt.testSignedNative=f;receipt.testSigningCleanup=cleanup;
 }catch(e){receipt.testSignedNativeFailure=e.message;}
 save();
}
console.log(JSON.stringify(receipt));
if(receipt.files.some(f=>f.status!=='PASS')||receipt.signedStorageFixture!=='PASS'||receipt.testSignedNativeFixture!=='PASS')process.exitCode=1;
