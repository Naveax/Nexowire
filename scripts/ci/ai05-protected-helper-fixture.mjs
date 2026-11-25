import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs,constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWindowsTransferHelperArtifactStore,installedTransferHelperPath,readVerifiedTransferHelperBinding,runTransferHelperLifecycle,TRANSFER_HELPER_ROOT} from './dist/src/installer/protected-transfer-helper-lifecycle.js';
import {verifyWindowsPrivateAcl,protectedWindowsAclEnvironment} from './dist/src/security/windows-programdata-acl.js';

assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.RUNNER_OS,'Windows');
assert.deepEqual(process.execArgv,[]);
assert.match(path.basename(path.dirname(fileURLToPath(import.meta.url))),/^Nexowire-AI05-CI-[a-f0-9]{32}$/);
assert.equal(TRANSFER_HELPER_ROOT,'C:\\ProgramData\\Nexowire-TransferRuntime');
await assert.rejects(fs.lstat(TRANSFER_HELPER_ROOT),{code:'ENOENT'});

const run=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=async file=>hash(await fs.readFile(file));
const signature=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
$s=Get-AuthenticodeSignature -LiteralPath $env:NEXOWIRE_PROTECTED_ACL_TARGET
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'FIXTURE_SIGNER_INVALID'}
$h=[Security.Cryptography.SHA256]::Create()
try{[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
`;
async function observePin(file){
  const signed=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(signature,'utf16le').toString('base64')
  ],{cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(file),windowsHide:true,timeout:30000});
  assert.equal(signed.stderr.trim(),'');
  const signerSha256=signed.stdout.trim();assert.match(signerSha256,/^[a-f0-9]{64}$/);
  return {sha256:await digest(file),signerSha256};
}
// Observed fixture pins are NOT authorized Nexowire release pins. Neither
// Windows compiler executable is ever launched from the helper namespace.
const framework='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const originalA=path.join(framework,'csc.exe'),originalB=path.join(framework,'vbc.exe');
for(const file of [originalA,originalB]){
  const st=await fs.lstat(file);
  console.log(JSON.stringify({scope:'OS_FIXTURE_SOURCE_DIAGNOSTIC',name:path.basename(file),nlink:st.nlink,size:st.size,isFile:st.isFile(),canonical:(await fs.realpath(file)).toLowerCase()===file.toLowerCase()}));
}
const a=await observePin(originalA),b=await observePin(originalB);
assert.notEqual(a.sha256,b.sha256);
const codeRoot=path.dirname(fileURLToPath(import.meta.url));
const runtimeFiles=['node.exe','package.json','fixture.mjs','dist/src/installer/protected-transfer-helper-lifecycle.js','dist/src/security/windows-programdata-acl.js','dist/src/security/windows-privileged-runtime-trust.js'];
const witness=new Map(await Promise.all(runtimeFiles.map(async p=>[p,await digest(path.join(codeRoot,p))])));
const store=createWindowsTransferHelperArtifactStore(async()=>{
  for(const [p,expected] of witness)assert.equal(await digest(path.join(codeRoot,p)),expected);
});
// Synthetic independent selection authority; actual Windows filesystem,
// ACL and signature adapter. Not a production owner/STOP/revoke witness.
let selected={revision:'0',pin:null},held=false,commits=0;
const authority={
  async withExclusiveQuiescedDeployment(req,effect){
    assert(!held);held=true;try{return await effect();}finally{held=false;}
  },
  async readSelection(){assert(held);return selected;},
  async commitSelection(req){
    assert(held);assert.deepEqual(req.expected,selected);
    selected={revision:String(Number(selected.revision)+1),pin:req.desired};commits++;return 'COMMITTED';
  }
};
const operation=(operation,desired,sourcePath)=>runTransferHelperLifecycle({
  requestId:randomUUID(),operation,expected:selected,desired,...(sourcePath===undefined?{}:{sourcePath})
},authority,store);
const binding=()=>authority.withExclusiveQuiescedDeployment(null,()=>readVerifiedTransferHelperBinding(authority,store));
const data=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nx-ai05-data-'));
const sourceA=path.join(data,'inert-a.exe'),sourceB=path.join(data,'inert-b.exe');
const dbPath=path.join(data,'state.sqlite');
const db=new DatabaseSync(dbPath);
try{
  // Windows inbox binaries may be component-store hardlinks. Copy exact
  // signed bytes to unique plain files; never loosen the production nlink gate.
  await fs.copyFile(originalA,sourceA,constants.COPYFILE_EXCL);
  await fs.copyFile(originalB,sourceB,constants.COPYFILE_EXCL);
  for(const [file,expected] of [[sourceA,a],[sourceB,b]]){
    const st=await fs.lstat(file);
    assert.equal(st.nlink,1,'offline fixture must have exactly one file link');
    assert.equal((await fs.realpath(file)).toLowerCase(),file.toLowerCase());
    assert.deepEqual(await observePin(file),expected,'copied fixture must keep exact binary and signer pins');
  }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE owner(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO owner VALUES(1,'fixture-owner');");
  await fs.writeFile(path.join(data,'identity-envelope.bin'),Buffer.from('synthetic encrypted identity sentinel'));
  await fs.writeFile(path.join(data,'receipt.json'),JSON.stringify({status:'UNKNOWN',noReplay:true}));
  const names=['state.sqlite','state.sqlite-wal','state.sqlite-shm','identity-envelope.bin','receipt.json'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(names.map(async p=>[p,await digest(path.join(data,p))])));
  const before=await snapshot();
  const wrong={...a,signerSha256:a.signerSha256==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)};
  await assert.rejects(operation('clean-install',wrong,sourceA),/TRANSFER_HELPER_SIGNATURE_INVALID/);
  await assert.rejects(fs.lstat(TRANSFER_HELPER_ROOT),{code:'ENOENT'});
  assert.equal(commits,0);

  await operation('clean-install',a,sourceA);
  verifyWindowsPrivateAcl(TRANSFER_HELPER_ROOT);
  verifyWindowsPrivateAcl(installedTransferHelperPath(a));
  assert.equal((await binding()).flushHelperSha256,a.sha256);
  assert.deepEqual(await snapshot(),before);

  await operation('upgrade',b,sourceB);
  verifyWindowsPrivateAcl(installedTransferHelperPath(b));
  assert.equal(await digest(installedTransferHelperPath(a)),a.sha256);
  assert.equal((await binding()).flushHelperSha256,b.sha256);
  assert.deepEqual(await snapshot(),before);

  await operation('rollback',a);
  assert.equal((await binding()).flushHelperSha256,a.sha256);
  assert.equal(await digest(installedTransferHelperPath(b)),b.sha256);
  assert.deepEqual(await snapshot(),before);

  await operation('uninstall',null);
  await assert.rejects(binding(),/TRANSFER_HELPER_NOT_SELECTED/);
  assert.equal(commits,4);
  assert.equal(await digest(installedTransferHelperPath(a)),a.sha256);
  assert.equal(await digest(installedTransferHelperPath(b)),b.sha256);
  assert.deepEqual(await snapshot(),before);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  assert.equal(db.prepare('SELECT value FROM owner WHERE id=1').get().value,'fixture-owner');
  assert.deepEqual((await fs.readdir(TRANSFER_HELPER_ROOT)).sort(),[path.basename(installedTransferHelperPath(a)),path.basename(installedTransferHelperPath(b))].sort());
  for(const p of [a,b]){
    const file=installedTransferHelperPath(p);
    assert.equal((await fs.lstat(file)).nlink,1);
    await fs.unlink(file);
  }
  await fs.rmdir(TRANSFER_HELPER_ROOT);
  console.log(JSON.stringify({scope:'HOSTED_WINDOWS_INERT_SIGNED_ARTIFACT_FIXTURE',node:process.versions.node,operations:4,wrongSignerDenied:true,aclVerified:true,sqliteWalShmAndSentinelsPreserved:true,sqliteQuickCheck:'ok',syntheticSelectionAuthority:true,nexowireHelperSigned:false,helperExecuted:false,productionAcceptance:false}));
}finally{
  db.close();
  await fs.rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
