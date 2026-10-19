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
