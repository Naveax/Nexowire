import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {readTestInventory} from './test-inventory.mjs';
const tests={
 'test/ai05/protected-transfer-helper-lifecycle.test.ts':['bf56b8102ad4f3642cb784072668a21d68066693',15],
 'test/ai05/transfer-flush-artifact.test.ts':['904bfd0fd2ca88f0d27471ba54ba9444a64e3823',4]
};
const pins={
 '.gitattributes':'c039ea0d6cdd0a0551d278dc728c257973164c5b',
 'src/installer/protected-transfer-helper-lifecycle.ts':'84f9cce7ee56744308e81b8f838d87f54fb8eba7',
 'src/agent/protected-transfer-startup.ts':'0d9077b2e1608c9a5bbf8e7faff31c7c7d739e01',
 'src/security/windows-programdata-acl.ts':'55d5814efd87f66e3ff553b415c42f37e23fce12',
 'src/security/windows-privileged-runtime-trust.ts':'2eb3029f9790cd7b94aa7bf87711a2296e3d3df3',
 'native/windows-transfer-volume-flush.cs':'7a62bf6c027544dfceb14f3ca939d7d76eb2ced9',
 'scripts/Build-Nexowire-TransferFlushArtifact.ps1':'bece860ec43b79eeb7542f01b0cd531f024f50a5',
 'scripts/ci/ai05-protected-helper-fixture.mjs':'77a69630b006ada8ee047e09128306144f2a75f3',
 'scripts/ci/ai05-protected-helper-fixture.ps1':'9e7efe172bc7d0601c97dc4adbc6852d9d9c1138',
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
const crlfFiles=new Set(['scripts/Build-Nexowire-TransferFlushArtifact.ps1','scripts/ci/ai05-protected-helper-fixture.ps1']);
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
// Use the reviewed Windows PowerShell 5.1 host and its system-only module
// path, not the PowerShell 7 module path inherited by a default Actions step.
const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const moduleRoot='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
childEnv.PSModulePath=moduleRoot;
const dir='ai08-installer-receipts';mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,nodeVersion:process.version,platform:process.platform,runId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,scope:'HOSTED_INSTALLER_LIFECYCLE_ONLY',pins,files:[],signedStorageFixture:'NOT_RUN',productionAcceptance:false};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
const probe=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',
 "$ErrorActionPreference='Stop'; Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop; $c=Get-Command Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -ErrorAction Stop; if($c.ModuleName -ne 'Microsoft.PowerShell.Security'){throw 'SIGNATURE_MODULE_MISMATCH'}; [Console]::WriteLine('WINDOWS_SYSTEM_SIGNATURE_MODULE_READY')"],
 {env:childEnv,encoding:'utf8',timeout:30000,windowsHide:true});
receipt.signatureModulePreflight=probe.status===0&&!probe.error&&!probe.signal&&!probe.stderr?.trim()&&probe.stdout?.trim()==='WINDOWS_SYSTEM_SIGNATURE_MODULE_READY'?'PASS':'FAIL';
save();
if(receipt.signatureModulePreflight!=='PASS'){process.stderr.write(probe.stderr??'');console.log(JSON.stringify(receipt));throw Error('WINDOWS_SYSTEM_SIGNATURE_MODULE_UNAVAILABLE');}
for(const [file,[blob,expected]] of Object.entries(tests)){
 check();
 const r={file,blob,expected,status:'FAIL'};receipt.files.push(r);
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',file],{env:childEnv,encoding:'utf8',timeout:480000,maxBuffer:8*1024*1024,windowsHide:true});
 const tap=child.stdout??'';writeFileSync(path.join(dir,path.basename(file)+'.tap'),tap);process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
 r.tapSha256=sha(tap);
 try{if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');r.counts=assertTapSummary(tap,expected);if(r.counts.tests!==expected)throw Error('EXACT_COUNT_MISMATCH');r.status='PASS';}catch(e){r.failure=e.message;}
 save();
}
if(receipt.files.every(f=>f.status==='PASS')){
 check();
 const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File','scripts/ci/ai05-protected-helper-fixture.ps1'],{env:childEnv,encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024,windowsHide:true});
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
console.log(JSON.stringify(receipt));
if(receipt.files.some(f=>f.status!=='PASS')||receipt.signedStorageFixture!=='PASS')process.exitCode=1;
