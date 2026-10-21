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

test('forged caller PowerShell signature/ACL functions are ignored; only native provider evidence counts', {
  skip:process.platform!=='win32',timeout:15000,
},()=>{
  // CI and locked-down service accounts may lack PowerShell.Security.
  // Missing verification evidence must produce explicit NO-GO, not PASS.
  const auditScript=path.resolve('scripts/audit-windows-job-helper-trust.ps1');
  const escaped=auditScript.replace(/'/g,"''");
  const injected=[
    "function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}} }",
    "function Get-Acl { [pscustomobject]@{AreAccessRulesProtected=$true;Access=@()} }",
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
  };
  assert.notEqual(data.authenticodeStatus,'Valid',
    'caller-local forged valid Authenticode must not shadow OS provider');
  assert.equal(data.publisherValid,false);
  // Real Windows native provider may be present or genuinely UNAVAILABLE.
  // In either case no shadowed function may turn this into approval.
  if (!data.aclEvidenceAvailable) {
    assert.equal(data.fileAclProtected,false);
    assert.equal(data.parentAclProtected,false);
    assert.equal(data.broadWriteGrantFound,null,
      'unknown ACL is not proof that broad write is absent');
  }
  assert.equal(data.provisionalFileTrustChecksPassed,false);
  assert.equal(data.productionReady,false);
});
