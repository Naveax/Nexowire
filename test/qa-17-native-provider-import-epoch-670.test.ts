import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * QA #17, source-only acceptance of the #670 native read-only provider.
 * NEVER tests a running Broker, UAC, a service, an actual high-token grant
 * or any user/VM resource. Windows test files live in a disposable directory.
 */
const SHA='a'.repeat(64),OTHER='b'.repeat(64);
const WHEN='2026-10-21T13:00:00.000Z';
const requestId='00000000-0000-4000-8000-000000000017';
const vmId='2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791';

type NativeResult={
  kind:string;
  productionReady:boolean;
  elevatedCoreDispatchEnabled:boolean;
  brokerProcessPidAttested:boolean;
  brokerProcessImageIdentityAttested:boolean;
  brokerOwnerDeviceEpochAttested:boolean;
  protectedBrokerImportTreeAttested:boolean;
  trustedSignedReleaseManifestAttested:boolean;
  highTokenBrokerIdentityAttested:boolean;
  ownInspectingProcessToken:{
    evidenceAvailable:boolean;evidenceError:string;
    integrityRid:number|null;elevated:boolean|null;
    highIntegrity:boolean|null;administratorsEnabled:boolean;
  };
  imageEvidence:{
    authenticodeStatus:string;authenticodeEvidenceAvailable:boolean;
    securityModuleAvailable:boolean;publisherValid:boolean;
    externallyPinnedPublisherMatches:boolean;
    externallyPinnedReleaseSha256Matches:boolean;
    aclEvidenceAvailable:boolean;
    broadWriteGrantFound:boolean|null;
    parentBroadWriteGrantFound:boolean|null;
    fileAclProtected:boolean;parentAclProtected:boolean;
    companionManifestMatches:boolean;
    signedReleaseManifestVerified:boolean;
    processHighTokenVerified:boolean;
    installedRunningImageIdentityVerified:boolean;
    productionReady:boolean;
  };
};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function request(mode:'CORE'|'ROOT'='CORE'){
  return {
    type:'core-broker.execute',version:1,requestId,
    ownerAccountId:'owner-17',deviceId:'device-17',
    ownerEpoch:31,credentialBinding:SHA,mode,
    action:'core.shell.exec',
    issuedAt:'2026-10-21T12:59:40.000Z',
    expiresAt:'2026-10-21T13:00:20.000Z',
    shell:{executable:'C:/Windows/System32/whoami.exe',arguments:[]},
  };
}
function context(mode:'CORE'|'ROOT'='CORE'):CoreBrokerContext{
  return{
    now:new Date(WHEN),ownerAccountId:'owner-17',deviceId:'device-17',
    credentialBinding:SHA,authoritativeOwnerEpoch:31,ownerRevoked:false,
    enrollment:{
      deviceId:'device-17',ownerAccountId:'owner-17',
      ownerEpoch:31,credentialBinding:SHA,
      enrollmentId:'00000000-0000-4000-8000-000000000018',
      mode,activatedAt:'2026-10-21T12:55:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:10:00.000Z':null,
      ownerSignedGrantDigest:OTHER,brokerInstalledImageSha256:SHA,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,
      administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,
      runningImageIdentityMatched:true,
      expectedBrokerImageSha256:SHA,
      imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,
      importedModulesAclProtected:true,
      updaterPathsAclProtected:true,
      processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,
    enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,
    requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,
    approvedVmIds:[vmId],
    stopProcessIdentityVerified:true,
  };
}
function noPrivilegedOutcome(result:ReturnType<typeof evaluateCoreBrokerExecution>):void{
  assert.equal(result.privilegedExecutionOccurred,false);
  assert.equal(result.verifiedEffect,false);
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.requiresPerCommandUac,false);
}
function simulatedNative():NativeResult {
  return {
    kind:'windows_core_broker_provider_readonly_v1',
    productionReady:false,elevatedCoreDispatchEnabled:false,
    brokerProcessPidAttested:false,
    brokerProcessImageIdentityAttested:false,
    brokerOwnerDeviceEpochAttested:false,
    protectedBrokerImportTreeAttested:false,
    trustedSignedReleaseManifestAttested:false,
    highTokenBrokerIdentityAttested:false,
    ownInspectingProcessToken:{
      evidenceAvailable:true,evidenceError:'',
      integrityRid:0x3000,elevated:true,highIntegrity:true,
      administratorsEnabled:true,
    },
    imageEvidence:{
      authenticodeStatus:'Valid',authenticodeEvidenceAvailable:true,
      securityModuleAvailable:true,publisherValid:true,
      externallyPinnedPublisherMatches:true,
      externallyPinnedReleaseSha256Matches:true,
      aclEvidenceAvailable:true,
      broadWriteGrantFound:false,parentBroadWriteGrantFound:false,
      fileAclProtected:true,parentAclProtected:true,
      companionManifestMatches:true,signedReleaseManifestVerified:false,
      processHighTokenVerified:false,installedRunningImageIdentityVerified:false,
      productionReady:false,
    },
  };
}
/** Fail-closed projection of the actual #670 result fields, never a native witness. */
function admissionFromNative(probe:NativeResult):CoreBrokerContext {
  const c=context();
  const t=c.trustedRuntime;
  const f=probe.imageEvidence;
  const aclGood=f.aclEvidenceAvailable===true &&
    f.fileAclProtected===true && f.parentAclProtected===true &&
    f.broadWriteGrantFound===false && f.parentBroadWriteGrantFound===false;
  const signed=f.securityModuleAvailable===true &&
    f.authenticodeEvidenceAvailable===true &&
    f.authenticodeStatus==='Valid' && f.publisherValid===true &&
    f.externallyPinnedPublisherMatches===true &&
    f.externallyPinnedReleaseSha256Matches===true;
  const brokerToken=probe.highTokenBrokerIdentityAttested===true &&
    probe.brokerProcessPidAttested===true &&
    probe.brokerProcessImageIdentityAttested===true &&
    probe.brokerOwnerDeviceEpochAttested===true;
  t.imageAuthenticodePublisherPinned=signed;
  t.brokerExeAndParentAclProtected=aclGood;
  t.importedModulesAclProtected=probe.protectedBrokerImportTreeAttested===true;
  t.updaterPathsAclProtected=probe.protectedBrokerImportTreeAttested===true;
  t.brokerProcessHighIntegrity=brokerToken;
  t.administratorsTokenEnabled=brokerToken;
  t.runningImageIdentityMatched=probe.brokerProcessImageIdentityAttested===true;
  t.brokerAuthenticatedAndVersionMatched=brokerToken;
  t.signedReleaseAndRollbackManifestVerified=
    probe.trustedSignedReleaseManifestAttested===true &&
    f.signedReleaseManifestVerified===true;
  t.processHandleDuplicationBoundaryProtected=false;
  return c;
}
function runNative(image:string,sha=''):NativeResult{
  const r=spawnSync('pwsh.exe',[
    '-NoProfile','-NonInteractive','-File',
    path.resolve('scripts/audit-windows-broker-token-provider.ps1'),
    '-BrokerImagePath',image,'-ExpectedReleaseSha256',sha,
  ],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:16384});
  assert.equal(r.status,0,(r.stderr??'').slice(0,1500));
  return JSON.parse(r.stdout.trim()) as NativeResult;
}

test('#17 no fabricated Broker HIGH: even an elevated *inspecting* token cannot prove running Broker',()=>{
  const probe=simulatedNative();
  assert.equal(probe.ownInspectingProcessToken.highIntegrity,true);
  assert.equal(probe.ownInspectingProcessToken.elevated,true);
  const c=admissionFromNative(probe);
  assert.equal(c.trustedRuntime.brokerProcessHighIntegrity,false);
  assert.equal(c.trustedRuntime.administratorsTokenEnabled,false);
  assert.equal(c.trustedRuntime.runningImageIdentityMatched,false);
  assert.equal(c.trustedRuntime.importedModulesAclProtected,false);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const out=evaluateCoreBrokerExecution(request(),c);
  assert.equal(out.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
  noPrivilegedOutcome(out);
});

test('#17 native publisher and ACL UNAVAILABLE must stay unknown/denied, not fabricate Valid or safe ACE',()=>{
  const changes:Array<[(p:NativeResult)=>void,string]>= [
    [p=>{p.imageEvidence.authenticodeStatus='UNAVAILABLE';p.imageEvidence.authenticodeEvidenceAvailable=false},'missing signer provider'],
    [p=>{p.imageEvidence.securityModuleAvailable=false},'missing Microsoft.PowerShell.Security module'],
    [p=>{p.imageEvidence.externallyPinnedPublisherMatches=false},'untrusted publisher pin'],
    [p=>{p.imageEvidence.aclEvidenceAvailable=false;p.imageEvidence.broadWriteGrantFound=null;p.imageEvidence.parentBroadWriteGrantFound=null},'ACL provider UNAVAILABLE'],
    [p=>{p.imageEvidence.aclEvidenceAvailable=false;p.imageEvidence.parentBroadWriteGrantFound=false},'falsely reported safe ACL with provider offline'],
    [p=>{p.imageEvidence.parentBroadWriteGrantFound=true},'writeable parent'],
    [p=>{p.imageEvidence.broadWriteGrantFound=true},'writeable image'],
  ];
  for(const [change,name] of changes){
    const p=simulatedNative();change(p);
    const c=admissionFromNative(p);
    if(name.includes('ACL')||name.includes('parent')||name.includes('image')){
      assert.equal(c.trustedRuntime.brokerExeAndParentAclProtected,false,name);
    }else{
      assert.equal(c.trustedRuntime.imageAuthenticodePublisherPinned,false,name);
    }
    const result=evaluateCoreBrokerExecution(request(),c);
    assert.equal(result.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',name);
    noPrivilegedOutcome(result);
  }
});

test('#17 queued CORE delegation must be evaluated against CURRENT owner revoke/re-pair/epoch',()=>{
  for(const mode of ['CORE','ROOT'] as const){
    const pending=request(mode);
    const c=context(mode);
    assert.equal(evaluateCoreBrokerExecution(pending,c).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
    c.ownerRevoked=true;
    const revoked=evaluateCoreBrokerExecution(pending,c);
    assert.equal(revoked.reason,'GRANT_REVOKED');
    noPrivilegedOutcome(revoked);
    c.ownerRevoked=false;
    c.authoritativeOwnerEpoch=32;
    assert.equal(evaluateCoreBrokerExecution(pending,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
    c.authoritativeOwnerEpoch=31;
    c.credentialBinding=OTHER;
    assert.equal(evaluateCoreBrokerExecution(pending,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
    c.credentialBinding=SHA;
    c.enrollment={...c.enrollment!,ownerEpoch:30};
    assert.equal(evaluateCoreBrokerExecution(pending,c).reason,'MISSING_SIGNED_ENROLLMENT');
  }
});

test('#17 reveal revoked owner inside reservation callback without misrepresenting the dispatch-disabled boundary',()=>{
  const c=context();
  c.requestAlreadyReserved=()=>{c.ownerRevoked=true;c.authoritativeOwnerEpoch=32;return false};
  const out=evaluateCoreBrokerExecution(request(),c);
  // Production dispatch is disabled, but a future executor MUST externally
  // fence/recheck owner epoch *after* reservation and before side effect.
  assert.equal(out.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  noPrivilegedOutcome(out);
  assert.equal(evaluateCoreBrokerExecution(request(),c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
});

test('#17 replaced previously signed imported DLL must invalidate original release digest and never become Broker proof', {
  skip:process.platform!=='win32',timeout:100000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-import-'));
  try{
    const systemSigned=path.join(process.env.SystemRoot??'C:/Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe');
    const original=await fs.readFile(systemSigned);
    const brokerDir=path.join(temp,'runtime'),importDir=path.join(temp,'imports');
    await fs.mkdir(brokerDir);await fs.mkdir(importDir);
    const broker=path.join(brokerDir,'windows-job-owner.exe');
    const imported=path.join(importDir,'native-import.dll');
    await fs.copyFile(systemSigned,broker);
    await fs.copyFile(systemSigned,imported); // genuine signed bytes, NEVER loaded/executed
    const originalSha=digest(original);
    await fs.writeFile(path.join(brokerDir,'windows-job-owner.sha256'),originalSha+'\n');
    await fs.writeFile(path.join(importDir,'windows-job-owner.sha256'),originalSha+'\n');
    const baseline=runNative(broker,originalSha);
    assert.equal(baseline.imageEvidence.authenticodeStatus,'Valid',
      'read-only native Windows Authenticode must be functional');
    assert.equal(baseline.imageEvidence.externallyPinnedReleaseSha256Matches,true);
    assert.equal(baseline.protectedBrokerImportTreeAttested,false);
    const importBefore=runNative(imported,originalSha);
    assert.equal(importBefore.imageEvidence.externallyPinnedReleaseSha256Matches,true);
    const modified=Buffer.from(original);
    modified[modified.length-1] = modified[modified.length-1]! ^ 1;
    await fs.writeFile(imported,modified);
    await fs.writeFile(path.join(importDir,'windows-job-owner.sha256'),digest(modified)+'\n');
    assert.notEqual(digest(modified),originalSha,'replacement must differ from original signed import');
    const inspectedImport=runNative(imported,originalSha);
    assert.equal(inspectedImport.imageEvidence.companionManifestMatches,true,
      'attacker can replace a loose hash alongside modified DLL bytes');
    assert.equal(inspectedImport.imageEvidence.externallyPinnedReleaseSha256Matches,false);
    assert.notEqual(inspectedImport.imageEvidence.authenticodeStatus,'Valid');
    const intactBroker=runNative(broker,originalSha);
    assert.equal(intactBroker.imageEvidence.authenticodeStatus,'Valid');
    assert.equal(intactBroker.protectedBrokerImportTreeAttested,false,
      'checking only a signed EXE cannot attest a replaced imported DLL');
    assert.equal(intactBroker.highTokenBrokerIdentityAttested,false);
    assert.equal(intactBroker.productionReady,false);
    const source=admissionFromNative(intactBroker);
    assert.equal(source.trustedRuntime.importedModulesAclProtected,false);
    const out=evaluateCoreBrokerExecution(request(),source);
    assert.equal(out.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
    noPrivilegedOutcome(out);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});

test('#17 read-only native provider never upgrades current pwsh token into high-token Broker', {
  skip:process.platform!=='win32',timeout:40000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-token-'));
  try{
    const source=path.join(process.env.SystemRoot??'C:/Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe');
    const image=path.join(temp,'windows-job-owner.exe');
    await fs.copyFile(source,image);
    const bytes=await fs.readFile(image),pin=digest(bytes);
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),pin+'\n');
    const report=runNative(image,pin);
    assert.equal(report.productionReady,false);
    assert.equal(report.elevatedCoreDispatchEnabled,false);
    assert.equal(report.highTokenBrokerIdentityAttested,false);
    assert.equal(report.brokerProcessPidAttested,false);
    assert.equal(report.brokerProcessImageIdentityAttested,false);
    assert.equal(report.brokerOwnerDeviceEpochAttested,false);
    assert.equal(report.protectedBrokerImportTreeAttested,false);
    assert.equal(report.trustedSignedReleaseManifestAttested,false);
    if(!report.ownInspectingProcessToken.evidenceAvailable){
      assert.equal(report.ownInspectingProcessToken.highIntegrity,null,
        'unavailable token inspection is not a fabricated HIGH result');
      assert.notEqual(report.ownInspectingProcessToken.evidenceError,'');
    }
    const out=evaluateCoreBrokerExecution(request(),admissionFromNative(report));
    assert.equal(out.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
    noPrivilegedOutcome(out);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});
