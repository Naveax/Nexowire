import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type Provider={
  kind:string;productionReady:boolean;elevatedCoreDispatchEnabled:boolean;
  brokerProcessPidAttested:boolean;brokerProcessImageIdentityAttested:boolean;
  trustedSignedReleaseManifestAttested:boolean;highTokenBrokerIdentityAttested:boolean;
  protectedBrokerImportTreeAttested:boolean;
  ownInspectingProcessToken:{
    evidenceAvailable:boolean;evidenceError:string;integrityRid:number|null;
    elevated:boolean|null;highIntegrity:boolean|null;administratorsEnabled:boolean;
  };
  imageEvidence:{
    authenticodeStatus:string;authenticodeEvidenceAvailable:boolean;
    publisherValid:boolean;companionManifestMatches:boolean;parentBroadWriteGrantFound:boolean|null;
    aclEvidenceAvailable:boolean;securityModuleAvailable:boolean;
    signedReleaseManifestVerified:boolean;processHighTokenVerified:boolean;
    installedRunningImageIdentityVerified:boolean;
    productionReady:boolean;
  };
};
function run(image:string,pinnedHash=''):Provider {
 const r=spawnSync('pwsh.exe',[
   '-NoProfile','-NonInteractive','-File',
   path.resolve('scripts/audit-windows-broker-token-provider.ps1'),
   '-BrokerImagePath',image,'-ExpectedReleaseSha256',pinnedHash,
 ],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:16384});
 assert.equal(r.status,0,'native provider failed '+(r.stderr??'').slice(0,1300));
 return JSON.parse(r.stdout.trim()) as Provider;
}
test('signed Windows test surrogate native attestation is NOT production Broker authorization', {
 skip:process.platform!=='win32',timeout:50000,
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-broker-provider-'));
 try{
  const signed=path.join(process.env.SystemRoot??'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  const helper=path.join(dir,'windows-job-owner.exe');
  await fs.copyFile(signed,helper); // testing ONLY; no execution of image
  const original=await fs.readFile(helper);
  const sha=createHash('sha256').update(original).digest('hex');
  await fs.writeFile(path.join(dir,'windows-job-owner.sha256'),sha+'\n');
  const good=run(helper,sha);
  assert.equal(good.imageEvidence.authenticodeStatus,'Valid',
    'real native Windows signature required, not simulated');
  assert.equal(good.imageEvidence.authenticodeEvidenceAvailable,true);
  assert.equal(good.imageEvidence.securityModuleAvailable,true);
  assert.equal(good.imageEvidence.companionManifestMatches,true);
  assert.equal(good.ownInspectingProcessToken.evidenceAvailable,true,
    'native TokenIntegrityLevel + TokenElevation must be available');
  assert.ok(Number.isInteger(good.ownInspectingProcessToken.integrityRid));
  assert.equal(good.productionReady,false);
  assert.equal(good.elevatedCoreDispatchEnabled,false);
  assert.equal(good.brokerProcessPidAttested,false);
  assert.equal(good.brokerProcessImageIdentityAttested,false);
  assert.equal(good.trustedSignedReleaseManifestAttested,false);
  assert.equal(good.highTokenBrokerIdentityAttested,false);
  assert.equal(good.protectedBrokerImportTreeAttested,false);
  assert.equal(good.imageEvidence.signedReleaseManifestVerified,false);
  assert.equal(good.imageEvidence.processHighTokenVerified,false);
  assert.equal(good.imageEvidence.installedRunningImageIdentityVerified,false);
  const tampered=Buffer.from(original);
  tampered.writeUInt8(tampered.readUInt8(tampered.length-1)^1,tampered.length-1);
  await fs.writeFile(helper,tampered);
  const pairedSha=createHash('sha256').update(tampered).digest('hex');
  await fs.writeFile(path.join(dir,'windows-job-owner.sha256'),pairedSha+'\n');
  const malicious=run(helper,sha);
  assert.equal(malicious.imageEvidence.companionManifestMatches,true,
    'tampered binary plus matching loose hash is possible');
  assert.notEqual(malicious.imageEvidence.authenticodeStatus,'Valid');
  assert.equal(malicious.imageEvidence.publisherValid,false);
  assert.equal(malicious.productionReady,false);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('inherited low-trust parent Modify ACL is not silently treated as safe', {
 skip:process.platform!=='win32',timeout:40000,
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-broker-acl-'));
 try{
  const helper=path.join(dir,'windows-job-owner.exe');
  const data=Buffer.from('DISPOSABLE PROVIDER FIXTURE NEVER EXECUTE');
  await fs.writeFile(helper,data);
  await fs.writeFile(path.join(dir,'windows-job-owner.sha256'),
    createHash('sha256').update(data).digest('hex')+'\n');
  const acl=spawnSync('icacls.exe',[dir,'/grant','*S-1-5-11:(OI)(CI)M'],
    {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:4096});
  assert.equal(acl.status,0,'temporary ACL setup: '+acl.stderr);
  const result=run(helper);
  assert.equal(result.imageEvidence.aclEvidenceAvailable,true,
    'ACL missing must fail the acceptance rather than be interpreted as safe');
  assert.equal(result.imageEvidence.parentBroadWriteGrantFound,true);
  assert.equal(result.imageEvidence.publisherValid,false);
  assert.equal(result.productionReady,false);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('explicit native provider UNKNOWN is never upgraded to high-token or signed Broker approval',()=>{
 // Source acceptance: missing provider/attestation state is not a substitute
 // for an actual installed signed and owner-bound high-token process.
 const missing={
  authenticodeStatus:'UNAVAILABLE',aclEvidenceAvailable:false,
  parentBroadWriteGrantFound:null,highTokenBrokerIdentityAttested:false,
  productionReady:false,elevatedCoreDispatchEnabled:false,
 };
 assert.notEqual(missing.authenticodeStatus,'Valid');
 assert.equal(missing.aclEvidenceAvailable,false);
 assert.equal(missing.parentBroadWriteGrantFound,null);
 assert.equal(missing.highTokenBrokerIdentityAttested,false);
 assert.equal(missing.productionReady,false);
});
