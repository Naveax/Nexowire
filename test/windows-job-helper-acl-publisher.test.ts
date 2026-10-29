import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyWindowsJobHelperBinary} from '../src/agent/windows-job-owner.js';

test('paired forged helper plus checksum is never release-publisher evidence', {
  skip:process.platform!=='win32',timeout:15000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-paired-helper-'));
  try{
    const image=path.join(temp,'windows-job-owner.exe');
    const data=Buffer.from('untrusted synthetic executable; NEVER EXECUTE');
    await fs.writeFile(image,data);
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),
      createHash('sha256').update(data).digest('hex')+'\n');
    // Explicitly demonstrate that the existing checksum-only *developer*
    // gate cannot establish publisher authenticity.
    await verifyWindowsJobHelperBinary(image);
    const result=spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-File',
      path.resolve('scripts/audit-windows-job-helper-trust.ps1'),
      '-HelperPath',image,'-Production'],
      {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
    assert.notEqual(result.status,0,'production file trust must fail closed');
    assert.match((result.stdout??'')+(result.stderr??''),
      /WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED/,
      'paired substitution must not become production authenticity proof');
  }finally {
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('production trust audit is read-only and unsigned source build is BLOCKED', {
  skip:process.platform!=='win32',timeout:15000,
},()=>{
  const args=['-NoProfile','-NonInteractive','-File',
    path.resolve('scripts/audit-windows-job-helper-trust.ps1')];
  const audit=spawnSync('powershell.exe',args,{
    windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  assert.equal(audit.status,0);
  const data=JSON.parse(audit.stdout.trim()) as {
    companionManifestMatches:boolean;productionReady:boolean;
    authenticodeStatus:string;fileAclProtected:boolean;
  };
  assert.equal(data.companionManifestMatches,true);
  assert.equal(data.productionReady,false);
  const strict=spawnSync('powershell.exe',[...args,'-Production'],{
    windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  assert.notEqual(strict.status,0);
  assert.match((strict.stdout??'')+(strict.stderr??''),
    /WINDOWS_JOB_PRODUCTION_TRUST_BLOCKED/);
});
test('trust audit computes SHA-256 when Get-FileHash cmdlet is unavailable', {
  skip:process.platform!=='win32',timeout:15000,
},()=>{
  // The Windows CI runner may not register Microsoft.PowerShell.Utility.
  // Shadow the command with a throwing function to assert this read-only
  // trust audit uses the cryptographic provider rather than the cmdlet.
  const auditScript=path.resolve('scripts/audit-windows-job-helper-trust.ps1');
  const escaped=auditScript.replace(/'/g,"''");
  const command="function Get-FileHash { throw 'TEST_GET_FILE_HASH_NOT_AVAILABLE' }; & '"+escaped+"'";
  const result=spawnSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-Command',command,
  ],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  assert.equal(result.status,0,
    'portable SHA-256 audit failed: '+(result.stderr??'').slice(0,1400));
  const data=JSON.parse(result.stdout.trim()) as {
    companionManifestMatches:boolean;productionReady:boolean;
    helperSha256:string;
  };
  assert.match(data.helperSha256,/^[0-9a-f]{64}$/);
  assert.equal(data.companionManifestMatches,true);
  assert.equal(data.productionReady,false,
    'a source-built helper must never become production-trusted');
});

test('trust audit fails closed when signature and ACL providers are unavailable', {
  skip:process.platform!=='win32',timeout:15000,
},()=>{
  // CI and locked-down service accounts may lack PowerShell.Security.
  // Missing verification evidence must produce explicit NO-GO, not PASS.
  const auditScript=path.resolve('scripts/audit-windows-job-helper-trust.ps1');
  const escaped=auditScript.replace(/'/g,"''");
  const injected=[
    "Import-Module Microsoft.PowerShell.Management",
    "Import-Module Microsoft.PowerShell.Utility",
    "Remove-Module Microsoft.PowerShell.Security -Force -ErrorAction SilentlyContinue",
    "$PSModuleAutoLoadingPreference='None'",
    "& '"+escaped+"'",
  ].join('; ');
  const result=spawnSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-Command',injected,
  ],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  assert.equal(result.status,0,
    'read-only audit should report failed evidence, not crash: '+(result.stderr??'').slice(0,1000));
  const data=JSON.parse(result.stdout.trim()) as {
    productionReady:boolean;provisionalFileTrustChecksPassed:boolean;
    authenticodeStatus:string;publisherValid:boolean;
    authenticodeEvidenceAvailable:boolean;
    aclEvidenceAvailable:boolean;fileAclProtected:boolean;
    parentAclProtected:boolean;broadWriteGrantFound:null|boolean;
    fileOwnerPrivileged:boolean|null;parentOwnerPrivileged:boolean|null;
    nonPrivilegedFileWriteGrantFound:boolean|null;
    nonPrivilegedParentWriteGrantFound:boolean|null;
  };
  assert.equal(data.authenticodeStatus,'UNAVAILABLE');
  assert.equal(data.authenticodeEvidenceAvailable,false);
  assert.equal(data.publisherValid,false);
  assert.equal(data.aclEvidenceAvailable,false);
  assert.equal(data.fileAclProtected,false);
  assert.equal(data.parentAclProtected,false);
  assert.equal(data.broadWriteGrantFound,null,
    'unknown ACL is not evidence that no broad write grant exists');
  assert.equal(data.fileOwnerPrivileged,null);
  assert.equal(data.parentOwnerPrivileged,null);
  assert.equal(data.nonPrivilegedFileWriteGrantFound,null);
  assert.equal(data.nonPrivilegedParentWriteGrantFound,null);
  assert.equal(data.provisionalFileTrustChecksPassed,false);
  assert.equal(data.productionReady,false);
});

test('forged PowerShell Authenticode and ACL functions cannot invent trust evidence', {
  skip:process.platform!=='win32',timeout:18000,
},()=>{
  const audit=path.resolve('scripts/audit-windows-job-helper-trust.ps1').replace(/'/g,"''");
  const cmd=[
    "function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='A'.repeat(40)}} }",
    "function Get-Acl { [pscustomobject]@{AreAccessRulesProtected=$true;Access=@()} }",
    "& '"+audit+"' -ExpectedPublisherThumbprint "+'A'.repeat(40),
  ].join('; ');
  const p=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],
    {encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:8192});
  assert.equal(p.status,0,(p.stderr??'').slice(0,1300));
  const result=JSON.parse(p.stdout.trim()) as {
    authenticodeStatus:string;publisherValid:boolean;
    externallyPinnedPublisherMatches:boolean;productionReady:boolean;
  };
  assert.notEqual(result.authenticodeStatus,'Valid',
    'unqualified caller-supplied Valid fake must never replace native signature');
  assert.equal(result.publisherValid,false);
  assert.equal(result.externallyPinnedPublisherMatches,false);
  assert.equal(result.productionReady,false);
});

test('real Windows-signed surrogate survives copy but replaced manifest or EXE fails trust audit', {
  skip:process.platform!=='win32',timeout:22000,
},async(t)=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-auth-signed-'));
  try{
    const source=path.join(process.env.SystemRoot??'C:\\Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe');
    const helper=path.join(temp,'windows-job-owner.exe');
    await fs.copyFile(source,helper); // signed Windows surrogate, NOT Nexowire helper
    const good=await fs.readFile(helper);
    const pinned=createHash('sha256').update(good).digest('hex');
    const manifest=path.join(temp,'windows-job-owner.sha256');
    await fs.writeFile(manifest,pinned+'\n');
    const base=['-NoProfile','-NonInteractive','-File',
      path.resolve('scripts/audit-windows-job-helper-trust.ps1'),
      '-HelperPath',helper,'-ExpectedReleaseSha256',pinned];
    const run=()=>spawnSync('powershell.exe',base,
      {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
    const original=run();
    assert.equal(original.status,0,(original.stderr??'').slice(0,1500));
    const verified=JSON.parse(original.stdout.trim()) as {
      authenticodeStatus:string;authenticodeEvidenceAvailable:boolean;publisherValid:boolean;
      companionManifestMatches:boolean;externallyPinnedReleaseSha256Matches:boolean;
      productionReady:boolean;
    };
    if (!verified.authenticodeEvidenceAvailable) {
      assert.equal(verified.authenticodeStatus,'UNAVAILABLE');
      assert.equal(verified.publisherValid,false);
      assert.equal(verified.productionReady,false,
        'missing OS evidence must remain production NO-GO');
      t.skip('OS Authenticode provider unavailable; valid-signature surrogate cannot be evaluated on this runner');
      return;
    }
    assert.equal(verified.authenticodeStatus,'Valid',
      'must use the OS to validate a real signature, not a mocked signature');
    assert.equal(verified.publisherValid,true);
    assert.equal(verified.companionManifestMatches,true);
    assert.equal(verified.externallyPinnedReleaseSha256Matches,true);
    assert.equal(verified.productionReady,false,
      'even a valid OS-signed unrelated surrogate must not authorize Nexowire');
    await fs.writeFile(manifest,'0'.repeat(64)+'\n');
    const changedManifest=JSON.parse(run().stdout.trim()) as {companionManifestMatches:boolean};
    assert.equal(changedManifest.companionManifestMatches,false);
    // Restore an attacker-paired digest and change one byte of the signed
    // test copy. The developer checksum can match but Authenticode cannot.
    good.writeUInt8(good.readUInt8(good.length-1)^1,good.length-1);
    await fs.writeFile(helper,good);
    await fs.writeFile(manifest,createHash('sha256').update(good).digest('hex')+'\n');
    const forged=JSON.parse(run().stdout.trim()) as {
      companionManifestMatches:boolean;publisherValid:boolean;
      externallyPinnedReleaseSha256Matches:boolean;productionReady:boolean;
    };
    assert.equal(forged.companionManifestMatches,true);
    assert.equal(forged.externallyPinnedReleaseSha256Matches,false);
    assert.equal(forged.publisherValid,false);
    assert.equal(forged.productionReady,false);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});

test('inherited broad parent-directory write grant is independently production NO-GO', {
  skip:process.platform!=='win32',timeout:18000,
},async(t)=>{
  // Only mutate the DACL on this test-created directory, never ProgramData,
  // installed Nexowire directories, running files or actual service objects.
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-parent-dacl-'));
  try{
    const image=path.join(dir,'windows-job-owner.exe');
    await fs.writeFile(image,Buffer.from('test-only unsigned surrogate; never execute'));
    const hash=createHash('sha256').update(await fs.readFile(image)).digest('hex');
    await fs.writeFile(path.join(dir,'windows-job-owner.sha256'),hash+'\n');
    const grant=spawnSync('icacls.exe',[dir,'/grant','*S-1-5-11:(OI)(CI)M'],
      {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
    assert.equal(grant.status,0,'synthetic DACL fixture setup: '+(grant.stderr??'').slice(0,1000));
    const result=spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-File',
      path.resolve('scripts/audit-windows-job-helper-trust.ps1'),'-HelperPath',image,
    ],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
    assert.equal(result.status,0,(result.stderr??'').slice(0,1300));
    const audit=JSON.parse(result.stdout.trim()) as {
      aclEvidenceAvailable:boolean;parentBroadWriteGrantFound:boolean|null;productionReady:boolean;
      signedReleaseManifestVerified:boolean;runningImageFileIdentityVerified:boolean;
      nonPrivilegedParentWriteGrantFound:boolean|null;provisionalFileTrustChecksPassed:boolean;
    };
    if (!audit.aclEvidenceAvailable) {
      assert.equal(audit.parentBroadWriteGrantFound,null);
      assert.equal(audit.productionReady,false,
        'missing OS ACL evidence must remain production NO-GO');
      t.skip('OS ACL provider unavailable; inherited grant cannot be evaluated on this runner');
      return;
    }
    assert.equal(audit.parentBroadWriteGrantFound,true,
      'synthetic inherited parent Modify grant is replacement/TOCTOU risk');
    assert.equal(audit.nonPrivilegedParentWriteGrantFound,true,
      'low-trust parent write ACE must also fail the general identity gate');
    assert.equal(audit.provisionalFileTrustChecksPassed,false);
    assert.equal(audit.signedReleaseManifestVerified,false);
    assert.equal(audit.runningImageFileIdentityVerified,false);
    assert.equal(audit.productionReady,false);
  }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('read-only audit rejects nonprivileged owner or per-user write grant on disposable fixture', {
  skip: process.platform !== 'win32', timeout: 16000,
}, async (t) => {
  // Creates only a disposable unsigned file. No ACL, task, installed
  // Agent/Broker, service, process token or live Job handle is modified.
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-owner-acl-audit-'));
  try {
    const helper=path.join(temp,'windows-job-owner.exe');
    const bytes=Buffer.from('unsigned user-owned static ACL fixture; do not execute');
    await fs.writeFile(helper,bytes);
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),
      createHash('sha256').update(bytes).digest('hex'));
    const audit=spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-File',
      path.resolve('scripts/audit-windows-job-helper-trust.ps1'),
      '-HelperPath',helper,
    ],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
    assert.equal(audit.status,0,(audit.stderr??'').slice(0,1200));
    const evidence=JSON.parse(audit.stdout.trim()) as {
      aclEvidenceAvailable:boolean;
      fileOwnerPrivileged:boolean|null;parentOwnerPrivileged:boolean|null;
      nonPrivilegedFileWriteGrantFound:boolean|null;
      nonPrivilegedParentWriteGrantFound:boolean|null;
      provisionalFileTrustChecksPassed:boolean;productionReady:boolean;
    };
    assert.equal(evidence.productionReady,false);
    if (!evidence.aclEvidenceAvailable) {
      assert.equal(evidence.fileOwnerPrivileged,null);
      assert.equal(evidence.nonPrivilegedFileWriteGrantFound,null);
      t.skip('ACL provider unavailable: explicit NO-GO retained');
      return;
    }
    const lowTrustOwnerOrWriter=
      evidence.fileOwnerPrivileged===false ||
      evidence.parentOwnerPrivileged===false ||
      evidence.nonPrivilegedFileWriteGrantFound===true ||
      evidence.nonPrivilegedParentWriteGrantFound===true;
    if (!lowTrustOwnerOrWriter) {
      t.skip('test runner produced an administrator-only owner/DACL fixture');
      return;
    }
    assert.equal(evidence.provisionalFileTrustChecksPassed,false,
      'explicit user ACE or owner privilege must not be mislabeled protected trust');
  } finally {
    await fs.rm(temp,{recursive:true,force:true});
  }
});
