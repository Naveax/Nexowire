import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
  assessCoreInstalledBrokerSource,
  assessCoreStopRevokeSource,
  type CoreBootstrapEvidence,
  type CoreStopRevokeEvidence,
} from '../scripts/s3-core-bootstrap-delegation-audit.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

/** Independent #17 fixture is deliberately synthetic. No OS access or UAC actions. */
const owner=generateKeyPairSync('ed25519');
const operator=generateKeyPairSync('ed25519');
const outsider=generateKeyPairSync('ed25519');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const recordKeys=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandKeys=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
function detached(value:object,keys:readonly string[],key=owner.privateKey):string {
  const fields=value as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify(Object.fromEntries(
    keys.map(k=>[k,fields[k]])))),key).toString('base64');
}
function acl(...files:string[]):CapturedAclNode[] {
  const all=new Set<string>();
  for(let file of files)while(true){
    all.add(file);
    const upper=path.win32.dirname(file);
    if(upper===file)break;
    file=upper;
  }
  return [...all].map(file=>({
    path:file,ownerSid:'S-1-5-32-544',isReparsePoint:false,
    entries:[
      {principalSid:'S-1-5-18',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-544',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-545',kind:'Allow' as const,fileSystemRights:0x1200a9,inherited:true},
    ],
  }));
}
function fixture():CoreBootstrapEvidence {
  const broker='C:\\QAFixture\\NX\\runtime\\broker.exe';
  const updater='C:\\QAFixture\\NX\\updater\\updater.exe';
  const native='C:\\QAFixture\\NX\\runtime\\native.dll';
  const key='C:\\QAFixture\\NX\\owner\\owner.blob';
  const brokerSha=hash('broker-synthetic'),installerSha=hash('installer-synthetic');
  const updaterSha=hash('updater-synthetic'),keySha=hash('key-synthetic');
  const cert=hash('cert-synthetic');
  const record={
    schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
    ownerAccountId:'qa17-owner',deviceId:'qa17-device',ownerEpoch:41,
    transactionId:'qa17-transaction',brokerVersion:'1.0.5',
    brokerSha256:brokerSha,installerSha256:installerSha,
    updaterSha256:updaterSha,dpapiBlobSha256:keySha,
    taskName:'\\Nexowire\\PrivilegedBroker',approvedAtUnix:1000,
  };
  const command={
    schemaVersion:1 as const,ownerAccountId:'qa17-owner',deviceId:'qa17-device',
    ownerEpoch:41,requestId:'qa17-request-001',
    capability:'core.admin.command' as const,inputSha256:hash('typed-command'),sequence:51,
  };
  return {
    record,recordSignature:detached(record,recordKeys),
    pins:{
      ownerPublicKeyPem:owner.publicKey.export({format:'pem',type:'spki'}).toString(),
      commandPublicKeyPem:operator.publicKey.export({format:'pem',type:'spki'}).toString(),
      ownerAccountId:'qa17-owner',deviceId:'qa17-device',minimumOwnerEpoch:41,
      transactionId:'qa17-transaction',brokerVersion:'1.0.5',
      brokerSha256:brokerSha,installerSha256:installerSha,
      updaterSha256:updaterSha,dpapiBlobSha256:keySha,
      nowUnix:1100,minimumIndependentCommandSequence:50,
      trustedPublisherSubject:'CN=QA Synthetic',
      trustedSignerCertificateSha256:cert,
    },
    physicalConsent:{
      provider:'windows-local-owner-os',sessionType:'physical-console',
      ownerAccountId:'qa17-owner',deviceId:'qa17-device',
      transactionId:'qa17-transaction',approvedInstallerSha256:installerSha,
      signedEnrollmentVerified:true,decision:'approved',remoteUiApprovalOnly:false,
    },
    task:{
      provider:'trusted-windows-task-scheduler',
      taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
      taskRunLevel:'highest',logonType:'service-account',principalSid:'S-1-5-18',
      ownerDeviceId:'qa17-device',actionPath:broker,actionSha256:brokerSha,
      brokerPublisherSubject:'CN=QA Synthetic',brokerCertificateSha256:cert,
      effectiveTokenProvider:'trusted-win32-token',tokenIsElevated:true,
      integrityRid:0x3000,administratorsEnabled:true,administratorsDenyOnly:false,
      nativeRunningImageHandle:true,runningImageSha256:brokerSha,
      processCreationIdentity:'qa17-native-creation-0001',
      taskRegistrationIdentityVerified:true,
    },
    ownerKey:{
      provider:'windows-dpapi-native',protectionScope:'current-user',
      protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
      blobPath:key,blobSha256:keySha,
      boundOwnerAccountId:'qa17-owner',boundDeviceId:'qa17-device',
      boundBrokerSha256:brokerSha,independentEpoch:41,
      unsealedInProtectedBroker:true,exportableToMediumCaller:false,
    },
    recovery:{
      oldBrokerVersion:'1.0.4',oldBrokerSha256:hash('old-broker'),
      oldRollbackSignatureVerified:true,oldRollbackProtected:true,
      externalJournalVerified:true,pendingUnknownMutation:false,
      currentInstalledImageSha256:brokerSha,
    },
    protectedImportPaths:[broker,updater,native],
    aclNodes:acl(broker,updater,native,key),
    command,commandSignature:detached(command,commandKeys,operator.privateKey),
    revoked:false,
  };
}
function denied(change:(e:CoreBootstrapEvidence)=>void,reason:RegExp):void {
  const e=fixture();change(e);
  assert.throws(()=>assessCoreInstalledBrokerSource(e),reason);
}
function revocation():CoreStopRevokeEvidence {
  return {
    operation:'revoke',ownerAccountId:'qa17-owner',deviceId:'qa17-device',
    priorEpoch:41,independentEpoch:42,independentWitnessVerified:true,
    taskState:'disabled',taskReadbackVerified:true,
    brokerImageHash:hash('broker-synthetic'),
    expectedBrokerImageHash:hash('broker-synthetic'),
    dpapiKeyAvailable:false,pendingUnknownMutation:false,
  };
}

test('#17 even all synthetic signed evidence cannot grant installed high-privilege CORE execution',()=>{
  const result=assessCoreInstalledBrokerSource(fixture());
  assert.equal(result.productionAccepted,false);
  assert.equal(result.elevatedCommandMayExecute,false);
  assert.equal(result.status,'source_only_not_deployed');
  assert.equal(result.initialUac,'one_local_os_approval_required_for_actual_install');
  assert.equal(result.perCommandUac,'not_required_only_after_real_broker_acceptance');
});

test('#17 owner signer, command signer, transaction hash and independent epoch pin reject substitutions',()=>{
  denied(e=>{e.pins.ownerPublicKeyPem=outsider.publicKey.export({format:'pem',type:'spki'}).toString()},
    /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
  denied(e=>{e.pins.commandPublicKeyPem=outsider.publicKey.export({format:'pem',type:'spki'}).toString()},
    /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
  for(const mutate of [
    (e:CoreBootstrapEvidence)=>{e.record.installerSha256=hash('forged-installer')},
    (e:CoreBootstrapEvidence)=>{e.record.ownerEpoch=40},
    (e:CoreBootstrapEvidence)=>{e.record.deviceId='foreign-device'},
    (e:CoreBootstrapEvidence)=>{e.pins.minimumOwnerEpoch=42},
    (e:CoreBootstrapEvidence)=>{e.command.ownerEpoch=42},
    (e:CoreBootstrapEvidence)=>{e.command.deviceId='other-device'},
    (e:CoreBootstrapEvidence)=>{e.command.sequence=49},
  ])denied(mutate,/S3_CORE_DELEGATION_/);
});

test('#17 local UAC refusal or forged consent.exe sighting cannot become a privilege grant',()=>{
  for(const patch of [
    {decision:'denied'},{decision:'pending'},{decision:'unknown'},
    {provider:'consent.exe'},{provider:'remote-browser'},
    {sessionType:'remote-browser'},{remoteUiApprovalOnly:true},
    {signedEnrollmentVerified:false},
  ]){
    denied(e=>Object.assign(e.physicalConsent,patch),
      /S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/);
  }
});

test('#17 medium/deny-only token, task spoof, unsigned image and DLL updater manipulation all refuse',()=>{
  const mutations=[
    {tokenIsElevated:false},{integrityRid:0x2000},
    {administratorsEnabled:false},{administratorsDenyOnly:true},
    {principalSid:'S-1-5-11'},{taskRunLevel:'least'},
    {logonType:'interactive'},{taskState:'ready'},
    {nativeRunningImageHandle:false},{taskRegistrationIdentityVerified:false},
    {brokerCertificateSha256:hash('counterfeit-cert')},
    {runningImageSha256:hash('replaced-image')},
    {actionSha256:hash('other-service')},
    {processCreationIdentity:'pid'},
  ];
  for(const patch of mutations){
    denied(e=>Object.assign(e.task,patch),
      /S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/);
  }
  denied(e=>{e.ownerKey.exportableToMediumCaller=true},
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  denied(e=>{e.ownerKey.independentEpoch=40},
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  denied(e=>{e.aclNodes=e.aclNodes.map(n=>n.path==='C:\\QAFixture'?{
    ...n,entries:[...n.entries,{
      principalSid:'S-1-5-11',kind:'Allow' as const,
      fileSystemRights:0x1301bf,inherited:true,
    }],
  }:n)},
    /S3_CORE_DELEGATION_ACL_INSECURE/);
  denied(e=>{e.aclNodes=e.aclNodes.filter(n=>n.path!=='C:\\QAFixture')},
    /S3_CORE_DELEGATION_ACL_MISSING_PARENT_OR_IMPORT/);
  denied(e=>{e.recovery.oldRollbackProtected=false},
    /S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
});

test('#17 lost mutation ACK, unsigned rollback, owner revocation block synthetic admission',()=>{
  denied(e=>{e.recovery.pendingUnknownMutation=true},
    /S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
  denied(e=>{e.recovery.oldRollbackSignatureVerified=false},
    /S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
  denied(e=>{e.recovery.externalJournalVerified=false},
    /S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
  denied(e=>{e.revoked=true},/S3_CORE_DELEGATION_OWNER_GRANT_REVOKED/);
});

test('#17 stop/revoke require observed task state, monotonically witnessed epoch and disabled DPAPI key',()=>{
  const accepted=assessCoreStopRevokeSource(revocation());
  assert.equal(accepted.status,'source_only_revocation_readback');
  assert.equal(accepted.commandAllowed,false);
  assert.equal(accepted.productionAccepted,false);
  for(const patch of [
    {independentEpoch:41},{independentEpoch:40},
    {independentWitnessVerified:false},{taskReadbackVerified:false},
    {pendingUnknownMutation:true},{brokerImageHash:hash('unknown-image')},
    {ownerAccountId:' '},{deviceId:'?'},
  ]){
    assert.throws(()=>assessCoreStopRevokeSource({...revocation(),...patch}),
      /S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/);
  }
  for(const patch of [
    {taskState:'running'},{taskState:'stopped'},
    {taskState:'unknown'},{dpapiKeyAvailable:true},
  ]){
    assert.throws(()=>assessCoreStopRevokeSource({
      ...revocation(),...patch,
    } as CoreStopRevokeEvidence),/S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/);
  }
  const stopped:CoreStopRevokeEvidence={
    ...revocation(),operation:'stop',taskState:'stopped',
    dpapiKeyAvailable:true,
  };
  assert.equal(assessCoreStopRevokeSource(stopped).commandAllowed,false);
  for(const taskState of ['running','disabled','unknown'] as const){
    assert.throws(()=>assessCoreStopRevokeSource({...stopped,taskState}),
      /S3_CORE_DELEGATION_TASK_STILL_RUNNING_OR_UNKNOWN/);
  }
});
