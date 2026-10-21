import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBrokerRuntimeIdentity,
  type BrokerRuntimeWitnessContext,
} from '../src/security/core-broker-process-witness.js';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/** Independent QA #17 for #700. Synthetic identity != physical Broker proof. */
const SHA='a'.repeat(64);
const OTHER='b'.repeat(64);
const BASE={
  pid:49222,creationFiletime:'134092000001239777',
  volumeSerialHex:'a0b1c2d3',fileIdHex:'a0'.repeat(16),
  runningImageSha256:SHA,ownerEpoch:17,deviceId:'qa17-device',
};
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function witness():BrokerRuntimeWitnessContext{
  return{
    trustedObservationSource:'signed-local-high-token-broker',
    observedProcess:{...BASE},
    expectedDeviceId:BASE.deviceId,currentOwnerEpoch:BASE.ownerEpoch,
    signedPublisherPinned:true,signedReleaseAndRollbackManifestVerified:true,
    protectedExeAndAncestorAclVerified:true,
    protectedImportsAndUpdaterTreeVerified:true,
    imageHandleFileIdentityVerified:true,
    processHandleDaclRejectsLowPrivDupHandle:true,
    tokenHighAndEnabledAdministratorsVerified:true,
    pendingMutationUnknown:false,ledgerAvailable:true,
  };
}
function blocked(r:ReturnType<typeof assessBrokerRuntimeIdentity>):void{
  assert.equal(r.actualHighIntegrityBrokerAccepted,false);
  assert.equal(r.ownerCoreRootElevatedDispatchEnabled,false);
  assert.equal(r.pidOnlyTaskkillAllowed,false);
  assert.equal(r.productionReady,false);
  assert.equal(r.effectVerified,false);
  assert.equal(r.retrySafe,false);
}
function queueContext():CoreBrokerContext{
  return{
    now:new Date('2026-10-21T13:00:00.000Z'),
    deviceId:'qa17-device',ownerAccountId:'qa17-owner',
    credentialBinding:SHA,authoritativeOwnerEpoch:17,ownerRevoked:false,
    enrollment:{
      deviceId:'qa17-device',ownerAccountId:'qa17-owner',
      ownerEpoch:17,credentialBinding:SHA,
      enrollmentId:'00000000-0000-4000-8000-000000000018',
      mode:'CORE',activatedAt:'2026-10-21T12:45:00.000Z',
      expiresAt:null,ownerSignedGrantDigest:OTHER,
      brokerInstalledImageSha256:SHA,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,runningImageIdentityMatched:true,
      expectedBrokerImageSha256:SHA,imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,
      processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,
    requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[],
    stopProcessIdentityVerified:true,
  };
}
const request={
  type:'core-broker.execute',version:1,
  requestId:'00000000-0000-4000-8000-000000000017',
  deviceId:'qa17-device',ownerAccountId:'qa17-owner',
  ownerEpoch:17,credentialBinding:SHA,mode:'CORE',action:'core.shell.exec',
  issuedAt:'2026-10-21T12:59:40.000Z',
  expiresAt:'2026-10-21T13:00:20.000Z',
  shell:{executable:'C:/Windows/System32/whoami.exe',arguments:[]},
};

test('#17 exact PID plus FILETIME, volume and file ID are required; no PID-only taskkill',()=>{
  const negative:Array<[unknown,string]>=[
    [{...BASE,creationFiletime:'134092000001239778'},'PID_REUSED_OR_CREATION_TIME_MISMATCH'],
    [{...BASE,pid:BASE.pid+1},'PID_REUSED_OR_CREATION_TIME_MISMATCH'],
    [{...BASE,volumeSerialHex:'deadbeef'},'RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID'],
    [{...BASE,fileIdHex:'b0'.repeat(16)},'RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID'],
    [{...BASE,runningImageSha256:OTHER},'RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID'],
    [{...BASE,creationFiletime:undefined},'NATIVE_PROCESS_EVIDENCE_UNAVAILABLE'],
  ];
  for(const [observed,reason] of negative){
    const c=witness();c.observedProcess=observed;
    const r=assessBrokerRuntimeIdentity(BASE,c);
    assert.equal(r.reason,reason);
    blocked(r);
  }
  const good=assessBrokerRuntimeIdentity(BASE,witness());
  assert.equal(good.reason,'PRODUCTION_EXECUTOR_NOT_INSTALLED');
  blocked(good);
});

test('#17 forged HIGH, provider UNAVAILABLE and no signed service identity never create Broker authority',()=>{
  for(const [field,reason] of [
    ['tokenHighAndEnabledAdministratorsVerified','HIGH_TOKEN_BROKER_UNVERIFIED'],
    ['protectedImportsAndUpdaterTreeVerified','FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED'],
    ['signedPublisherPinned','SIGNED_RELEASE_OR_IMAGE_TRUST_UNVERIFIED'],
    ['imageHandleFileIdentityVerified','SIGNED_RELEASE_OR_IMAGE_TRUST_UNVERIFIED'],
    ['processHandleDaclRejectsLowPrivDupHandle','PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED'],
  ] as const){
    const c=witness();c[field]=false;
    const r=assessBrokerRuntimeIdentity(BASE,c);
    assert.equal(r.reason,reason,field);blocked(r);
  }
  const unavailable=witness();unavailable.trustedObservationSource='unverified';
  assert.equal(assessBrokerRuntimeIdentity(BASE,unavailable).reason,'OBSERVATION_SOURCE_UNVERIFIED');
  const lost=witness();lost.pendingMutationUnknown=true;
  const pending=assessBrokerRuntimeIdentity(BASE,lost);
  assert.equal(pending.reason,'PENDING_EFFECT_UNKNOWN_NO_REPLAY');
  assert.equal(pending.status,'unknown');blocked(pending);
});

test('#17 CORE revoked after queue or re-pair loses authority despite stale request and fake all-green token',()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const c=queueContext();
  assert.equal(evaluateCoreBrokerExecution(request,c).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  c.ownerRevoked=true;
  const revoked=evaluateCoreBrokerExecution(request,c);
  assert.equal(revoked.reason,'GRANT_REVOKED');
  assert.equal(revoked.privilegedExecutionOccurred,false);
  assert.equal(revoked.automaticallyRetryable,false);
  c.ownerRevoked=false;c.authoritativeOwnerEpoch=18;
  assert.equal(evaluateCoreBrokerExecution(request,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  const w=witness();w.currentOwnerEpoch=18;
  assert.equal(assessBrokerRuntimeIdentity(BASE,w).reason,'OWNER_DEVICE_EPOCH_INVALID');
  c.authoritativeOwnerEpoch=17;c.credentialBinding=OTHER;
  assert.equal(evaluateCoreBrokerExecution(request,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
});

test('#17 revocation inside durable reservation exposes mandatory post-reservation epoch fence',()=>{
  const c=queueContext();
  c.requestAlreadyReserved=()=>{
    c.ownerRevoked=true;c.authoritativeOwnerEpoch=18;
    return false;
  };
  const observed=evaluateCoreBrokerExecution(request,c);
  // Source gate reads epoch before reservation. Disabled dispatch avoids
  // side effects; a future real executor must recheck external epoch AFTER CAS.
  assert.equal(observed.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(observed.privilegedExecutionOccurred,false);
  assert.equal(evaluateCoreBrokerExecution(request,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
});

type NativeProvider={
  productionReady:boolean;elevatedCoreDispatchEnabled:boolean;
  ownInspectingProcessIdentity:{
    pid:number;creationFiletime:string|null;creationEvidenceAvailable:boolean;
  };
  ownInspectingProcessToken:{evidenceAvailable:boolean;highIntegrity:boolean|null};
  brokerProcessPidAttested:boolean;brokerProcessCreationFiletimeAttested:boolean;
  brokerProcessImageIdentityAttested:boolean;highTokenBrokerIdentityAttested:boolean;
  protectedBrokerImportTreeAttested:boolean;
  imageEvidence:{
    authenticodeStatus:string;publisherValid:boolean;
    externallyPinnedReleaseSha256Matches:boolean;
    companionManifestMatches:boolean;
    authenticodeEvidenceAvailable:boolean;
    aclEvidenceAvailable:boolean;
    parentBroadWriteGrantFound:boolean|null;
  };
};
function native(image:string,pin:string):NativeProvider{
  const r=spawnSync('pwsh.exe',[
    '-NoProfile','-NonInteractive','-File',
    path.resolve('scripts/audit-windows-broker-token-provider.ps1'),
    '-BrokerImagePath',image,'-ExpectedReleaseSha256',pin,
  ],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024});
  assert.equal(r.status,0,(r.stderr??'').slice(0,1600));
  return JSON.parse(r.stdout.trim()) as NativeProvider;
}
type TreeResult={
  productionReady:boolean;elevatedCoreDispatchEnabled:boolean;
  allInspectedPathsHaveAclEvidence:boolean;
  protectedCompleteImageTreeAttested:boolean;
  importListIndependentlyEnumerated:boolean;
  inspectedEntries:Array<{path:string;evidenceAvailable:boolean;broadLowTrustWriteFound:boolean|null}>;
};
function tree(root:string,exe:string,updater:string,imports:string[]):TreeResult{
  const r=spawnSync('pwsh.exe',[
    '-NoProfile','-NonInteractive','-File',
    path.resolve('scripts/audit-core-broker-protected-tree.ps1'),
    '-ProtectedInstallRoot',root,
    '-LauncherPath',exe,'-UpdaterPath',updater,'-ImportedModulePaths',...imports,
  ],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024});
  assert.equal(r.status,0,(r.stderr??'').slice(0,1600));
  return JSON.parse(r.stdout.trim()) as TreeResult;
}

test('#17 real Windows provider rejects forged Valid and replaced signed import, even when loose manifest is updated',{
  skip:process.platform!=='win32',timeout:85000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-700-import-'));
  try{
    const signed=path.join(process.env.SystemRoot??'C:/Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe');
    const original=await fs.readFile(signed);
    const pin=digest(original);
    const exe=path.join(temp,'windows-job-owner.exe');
    const imp=path.join(temp,'signed-import.dll');
    const updater=path.join(temp,'updater.exe');
    await Promise.all([fs.writeFile(exe,original),fs.writeFile(imp,original),fs.writeFile(updater,original)]);
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),pin+'\n');
    const clean=native(exe,pin);
    assert.equal(clean.imageEvidence.authenticodeStatus,'Valid');
    assert.equal(clean.imageEvidence.externallyPinnedReleaseSha256Matches,true);
    assert.equal(clean.brokerProcessPidAttested,false);
    assert.equal(clean.brokerProcessCreationFiletimeAttested,false);
    assert.equal(clean.highTokenBrokerIdentityAttested,false);
    assert.equal(clean.productionReady,false);
    // An intact signed EXE is not independently enumerated import evidence.
    const before=tree(temp,exe,updater,[imp]);
    assert.equal(before.importListIndependentlyEnumerated,false);
    assert.equal(before.protectedCompleteImageTreeAttested,false);
    assert.equal(before.productionReady,false);
    const modified=Buffer.from(original);
    modified[modified.length-1] = modified[modified.length-1]! ^ 1;
    await fs.writeFile(imp,modified);
    const newHash=digest(modified);
    assert.notEqual(newHash,pin);
    // The loosely maintained digest can be updated by a low-trust writer.
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),newHash+'\n');
    const swapped=native(imp,pin);
    assert.equal(swapped.imageEvidence.companionManifestMatches,true);
    assert.notEqual(swapped.imageEvidence.authenticodeStatus,'Valid');
    assert.equal(swapped.imageEvidence.externallyPinnedReleaseSha256Matches,false);
    assert.equal(swapped.imageEvidence.publisherValid,false);
    assert.equal(swapped.productionReady,false);
    const untouched=native(exe,pin);
    assert.equal(untouched.imageEvidence.authenticodeStatus,'Valid');
    assert.equal(untouched.protectedBrokerImportTreeAttested,false);
    assert.equal(untouched.highTokenBrokerIdentityAttested,false);
    const after=tree(temp,exe,updater,[imp]);
    assert.equal(after.importListIndependentlyEnumerated,false);
    assert.equal(after.protectedCompleteImageTreeAttested,false);
    assert.equal(after.productionReady,false);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});

test('#17 native provider UNAVAILABLE and caller-forged Valid never grant HIGH or a clean ACL',{
  skip:process.platform!=='win32',timeout:45000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-700-unavailable-'));
  try{
    const exe=path.join(temp,'windows-job-owner.exe');
    await fs.writeFile(exe,Buffer.from('DISPOSABLE UNSIGNED TEST FIXTURE; NEVER EXECUTE'));
    const hash=digest(await fs.readFile(exe));
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),hash+'\n');
    const escaped=(s:string)=>s.replace(/'/g,"''");
    const command=[
      "function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}} }",
      "function Get-Acl { [pscustomobject]@{AreAccessRulesProtected=$true;Access=@()} }",
      "& '"+escaped(path.resolve('scripts/audit-windows-job-helper-trust.ps1'))+"' -HelperPath '"+escaped(exe)+"' -ExpectedReleaseSha256 '"+hash+"'",
    ].join('; ');
    const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],
      {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
    assert.equal(result.status,0,(result.stderr??'').slice(0,1600));
    const report=JSON.parse(result.stdout.trim()) as {
      authenticodeStatus:string;publisherValid:boolean;
      authenticodeEvidenceAvailable:boolean;aclEvidenceAvailable:boolean;
      broadWriteGrantFound:boolean|null;parentBroadWriteGrantFound:boolean|null;
      productionReady:boolean;provisionalFileTrustChecksPassed:boolean;
    };
    assert.notEqual(report.authenticodeStatus,'Valid');
    assert.equal(report.publisherValid,false);
    assert.equal(report.provisionalFileTrustChecksPassed,false);
    assert.equal(report.productionReady,false);
    if(!report.aclEvidenceAvailable){
      assert.equal(report.broadWriteGrantFound,null);
      assert.equal(report.parentBroadWriteGrantFound,null);
    }
    const missing=path.join(temp,'imports','provider-unavailable.dll');
    const evidence=tree(temp,exe,exe,[missing]);
    assert.equal(evidence.allInspectedPathsHaveAclEvidence,false);
    assert.equal(evidence.protectedCompleteImageTreeAttested,false);
    assert.equal(evidence.productionReady,false);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});

test('#17 native GetProcessTimes FILETIME proves inspecting PowerShell only, never installed Broker',{
  skip:process.platform!=='win32',timeout:35000,
},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-700-filetime-'));
  try{
    const image=path.join(temp,'windows-job-owner.exe');
    const signed=path.join(process.env.SystemRoot??'C:/Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe');
    await fs.copyFile(signed,image);
    const pin=digest(await fs.readFile(image));
    await fs.writeFile(path.join(temp,'windows-job-owner.sha256'),pin+'\n');
    const result=native(image,pin);
    const self=result.ownInspectingProcessIdentity;
    assert.equal(self.creationEvidenceAvailable,true);
    assert.ok(self.pid>0);
    assert.match(self.creationFiletime??'',/^[1-9][0-9]{10,19}$/);
    assert.equal(result.brokerProcessPidAttested,false);
    assert.equal(result.brokerProcessCreationFiletimeAttested,false);
    assert.equal(result.brokerProcessImageIdentityAttested,false);
    assert.equal(result.highTokenBrokerIdentityAttested,false);
    assert.equal(result.productionReady,false);
    assert.equal(result.elevatedCoreDispatchEnabled,false);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});
