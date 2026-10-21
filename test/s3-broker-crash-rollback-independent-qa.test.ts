import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, type KeyObject} from 'node:crypto';
import path from 'node:path';
import {
  assessS3CrashRecovery, CRASH_PHASES,
  type S3CrashRecord, type S3RecoveryPins,
} from '../scripts/s3-crash-recovery-assessment.js';
import {
  assessScopedBrokerTrust,
  type BrokerEvidenceInput, type BrokerSignatureInspector,
} from '../scripts/s3-hyperv-broker-trust.js';
import {
  assessCoreInstalledBrokerSource, assessCoreStopRevokeSource,
  type CoreBootstrapEvidence, type CoreStopRevokeEvidence,
} from '../scripts/s3-core-bootstrap-delegation-audit.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

/**
 * Independent adversarial SOURCE tests against #551 + #632 functions.
 * All records, keys, ACLs and Windows identities below are SYNTHETIC.
 * NEVER start an installer/service/VM, use DPAPI, touch UAC or mutate ACLs.
 */
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const brokerSigner=generateKeyPairSync('ed25519');
const enrollmentSigner=generateKeyPairSync('ed25519');
const ownerSigner=generateKeyPairSync('ed25519');
const commandSigner=generateKeyPairSync('ed25519');
const cert=hash('fixture-authenticode-cert-not-real');
const publisher='CN=Fixture Publisher';
const vm='bbfe85b2-ed70-46dc-aa0a-df496a508c0b';
const brokerFields=['schemaVersion','role','version','minAgentVersion','maxAgentVersion',
  'minHubVersion','maxHubVersion','publisher','brokerSha256','helperSha256','updaterSha256'];
const enrollFields=['schemaVersion','ownerAccountId','deviceId','vmId',
  'brokerVersion','epoch','expiresAtUnix'];
const ownerFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
function detached(record:object,fields:readonly string[],key:KeyObject):string{
  const data=record as Record<string,unknown>;
  const canonical=JSON.stringify(Object.fromEntries(fields.map(k=>[k,data[k]])));
  return sign(null,Buffer.from(canonical),key).toString('base64');
}
function protectedAcl(...paths:string[]):CapturedAclNode[]{
  const covered=new Set<string>();
  for(let current of paths){
    while(true){
      covered.add(current);
      const next=path.win32.dirname(current);
      if(next===current)break;
      current=next;
    }
  }
  return [...covered].map(filename=>({
    path:filename,ownerSid:'S-1-5-32-544',isReparsePoint:false,
    entries:[
      {principalSid:'S-1-5-18',kind:'Allow' as const,
        fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-544',kind:'Allow' as const,
        fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-545',kind:'Allow' as const,
        fileSystemRights:0x1200a9,inherited:true},
    ],
  }));
}
function brokerFixture():BrokerEvidenceInput{
  const binaries={
    broker:Buffer.from('BROKER-28'),helper:Buffer.from('HELPER-28'),
    updater:Buffer.from('UPDATER-28'),
  };
  const manifest={
    schemaVersion:1 as const,role:'nexowire-scoped-hyperv-broker' as const,
    version:'1.0.5',minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
    minHubVersion:'1.0.5',maxHubVersion:'1.0.6',publisher,
    brokerSha256:hash(binaries.broker),helperSha256:hash(binaries.helper),
    updaterSha256:hash(binaries.updater),
  };
  const enrollment={
    schemaVersion:1 as const,ownerAccountId:'owner-28',deviceId:'device-28',
    vmId:vm,brokerVersion:'1.0.5',epoch:14,expiresAtUnix:1800000300,
  };
  const root='C:\\ProtectedFixture\\Nexowire';
  const paths={
    broker:root+'\\runtime\\broker.exe',
    helper:root+'\\helper\\helper.exe',
    updater:root+'\\updater\\updater.exe',
  };
  return {
    manifest,manifestSignature:detached(manifest,brokerFields,brokerSigner.privateKey),
    enrollment,enrollmentSignature:detached(enrollment,enrollFields,enrollmentSigner.privateKey),
    pins:{
      trustedManifestPublicKeyPem:brokerSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
      trustedEnrollmentPublicKeyPem:enrollmentSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
      trustedPublisherSubject:publisher,trustedCertificateSha256:cert,
      ownerAccountId:'owner-28',deviceId:'device-28',vmId:vm,
      installedAgentVersion:'1.0.5',installedHubVersion:'1.0.5',
      brokerVersion:'1.0.5',minIndependentEnrollmentEpoch:14,nowUnix:1800000000,
    },
    binaries,paths,aclNodes:protectedAcl(...Object.values(paths)),
    running:{
      runningImageSha256:manifest.brokerSha256,
      creationIdentity:'trusted-creation-identity-28',
      deviceId:'device-28',brokerVersion:'1.0.5',
      nativeImageHandleVerified:true,authenticatedHealth:true,
    },
  };
}
const inspectBroker:BrokerSignatureInspector=async(_kind,_path,sha)=>({
  fileSha256:sha,publisherSubject:publisher,certificateSha256:cert,signatureValid:true,
});
const recoveryPins:S3RecoveryPins={
  transactionId:'txn-28',ownerAccountId:'owner-28',deviceId:'device-28',
  oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',
  hubVersion:'1.0.5',oldArtifactSha256:hash('signed-old-archive-fixture'),
  targetArtifactSha256:hash('signed-new-archive-fixture'),
  installerHelperSha256:hash('signed-installer-helper-fixture'),
  minimumIndependentSequence:20,
};
function recovery(phase:S3CrashRecord['phase'],sequence=20):S3CrashRecord{
  return {
    schemaVersion:1,phase,sequence,
    transactionId:recoveryPins.transactionId,
    ownerAccountId:recoveryPins.ownerAccountId,
    deviceId:recoveryPins.deviceId,
    oldAgentVersion:recoveryPins.oldAgentVersion,
    targetAgentVersion:recoveryPins.targetAgentVersion,
    hubVersion:recoveryPins.hubVersion,
    oldArtifactSha256:recoveryPins.oldArtifactSha256,
    targetArtifactSha256:recoveryPins.targetArtifactSha256,
    installerHelperSha256:recoveryPins.installerHelperSha256,
  };
}
function bootstrapFixture():CoreBootstrapEvidence{
  const root='C:\\ProtectedFixture\\Nexowire';
  const broker=root+'\\runtime\\broker.exe';
  const updater=root+'\\updater\\updater.exe';
  const dll=root+'\\runtime\\owner-native.dll';
  const dpapi=root+'\\owner\\dpapi.bin';
  const brokerSha=hash('synthetic-owner-broker');
  const installerSha=hash('synthetic-owner-installer');
  const updaterSha=hash('synthetic-owner-updater');
  const dpapiSha=hash('synthetic-protected-blob');
  const record={
    schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
    ownerAccountId:'owner-28',deviceId:'device-28',ownerEpoch:14,
    transactionId:'owner-enroll-28',brokerVersion:'1.0.5',
    brokerSha256:brokerSha,installerSha256:installerSha,
    updaterSha256:updaterSha,dpapiBlobSha256:dpapiSha,
    taskName:'\\Nexowire\\PrivilegedBroker',approvedAtUnix:1000,
  };
  const command={
    schemaVersion:1 as const,ownerAccountId:'owner-28',deviceId:'device-28',
    ownerEpoch:14,requestId:'owner-command-28',
    capability:'core.admin.command' as const,inputSha256:hash('bounded-command'),
    sequence:90,
  };
  return {
    record,recordSignature:detached(record,ownerFields,ownerSigner.privateKey),
    pins:{
      ownerPublicKeyPem:ownerSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
      commandPublicKeyPem:commandSigner.publicKey.export({format:'pem',type:'spki'}).toString(),
      ownerAccountId:'owner-28',deviceId:'device-28',minimumOwnerEpoch:14,
      transactionId:'owner-enroll-28',brokerVersion:'1.0.5',
      brokerSha256:brokerSha,installerSha256:installerSha,
      updaterSha256:updaterSha,dpapiBlobSha256:dpapiSha,
      nowUnix:1100,minimumIndependentCommandSequence:89,
      trustedPublisherSubject:publisher,trustedSignerCertificateSha256:cert,
    },
    physicalConsent:{
      provider:'windows-local-owner-os',sessionType:'physical-console',
      ownerAccountId:'owner-28',deviceId:'device-28',
      transactionId:'owner-enroll-28',approvedInstallerSha256:installerSha,
      signedEnrollmentVerified:true,decision:'approved',remoteUiApprovalOnly:false,
    },
    task:{
      provider:'trusted-windows-task-scheduler',
      taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
      taskRunLevel:'highest',logonType:'service-account',
      principalSid:'S-1-5-18',ownerDeviceId:'device-28',
      actionPath:broker,actionSha256:brokerSha,
      brokerPublisherSubject:publisher,brokerCertificateSha256:cert,
      effectiveTokenProvider:'trusted-win32-token',
      tokenIsElevated:true,integrityRid:0x3000,
      administratorsEnabled:true,administratorsDenyOnly:false,
      nativeRunningImageHandle:true,runningImageSha256:brokerSha,
      processCreationIdentity:'trusted-creation-identity-28',
      taskRegistrationIdentityVerified:true,
    },
    ownerKey:{
      provider:'windows-dpapi-native',protectionScope:'current-user',
      protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
      blobPath:dpapi,blobSha256:dpapiSha,
      boundOwnerAccountId:'owner-28',boundDeviceId:'device-28',
      boundBrokerSha256:brokerSha,independentEpoch:14,
      unsealedInProtectedBroker:true,exportableToMediumCaller:false,
    },
    recovery:{
      oldBrokerVersion:'1.0.4',oldBrokerSha256:hash('signed-old-broker-fixture'),
      oldRollbackSignatureVerified:true,oldRollbackProtected:true,
      externalJournalVerified:true,pendingUnknownMutation:false,
      currentInstalledImageSha256:brokerSha,
    },
    protectedImportPaths:[broker,updater,dll],
    aclNodes:protectedAcl(broker,updater,dll,dpapi),
    command,commandSignature:detached(command,commandFields,commandSigner.privateKey),
    revoked:false,
  };
}
function mustDenyBootstrap(mutate:(b:CoreBootstrapEvidence)=>void,reason:RegExp):void{
  const b=bootstrapFixture();mutate(b);
  assert.throws(()=>assessCoreInstalledBrokerSource(b),reason);
}
test('even cryptographically consistent synthetic evidence never claims installed or elevated success',async()=>{
  const brokerVerdict=await assessScopedBrokerTrust(brokerFixture(),inspectBroker);
  assert.equal(brokerVerdict.executionApproved,false);
  assert.equal(brokerVerdict.productionApproved,false);
  const bootstrapVerdict=assessCoreInstalledBrokerSource(bootstrapFixture());
  assert.equal(bootstrapVerdict.elevatedCommandMayExecute,false);
  assert.equal(bootstrapVerdict.productionAccepted,false);
});
test('each exact binary role rejects forged publisher/certificate/signature/hash; old Agent 1.0.5 is only a compatibility input',async()=>{
  for(const role of ['broker','helper','updater'] as const){
    for(const flaw of ['signature','publisher','certificate','sha'] as const){
      const inspect:BrokerSignatureInspector=async(kind,file,sha)=>{
        const correct=await inspectBroker(kind,file,sha);
        if(kind!==role)return correct;
        if(flaw==='signature')return {...correct,signatureValid:false};
        if(flaw==='publisher')return {...correct,publisherSubject:'CN=Attacker'};
        if(flaw==='certificate')return {...correct,certificateSha256:hash('foreign-cert')};
        return {...correct,fileSha256:hash('replaced-binary')};
      };
      await assert.rejects(assessScopedBrokerTrust(brokerFixture(),inspect),
        /S3_HYPERV_BROKER_HELPER_UPDATER_PUBLISHER_MISMATCH/);
    }
  }
  for(const mutation of [
    (b:BrokerEvidenceInput)=>{b.binaries.updater=Buffer.from('replaced-after-signing');},
    (b:BrokerEvidenceInput)=>{b.manifestSignature='invalid-signature';},
    (b:BrokerEvidenceInput)=>{b.pins.installedAgentVersion='1.0.4';},
    (b:BrokerEvidenceInput)=>{b.pins.installedHubVersion='1.0.4';},
    (b:BrokerEvidenceInput)=>{b.running.nativeImageHandleVerified=false;},
    (b:BrokerEvidenceInput)=>{b.running.creationIdentity='PID-44';},
  ]){
    const b=brokerFixture();mutation(b);
    await assert.rejects(assessScopedBrokerTrust(b,inspectBroker),/S3_HYPERV_/);
  }
});
test('protected updater/import ancestry, reparse and inherited Authenticated Users Modify never pass',()=>{
  for(const mode of ['missing-updater','writable-parent','reparse-dll','writable-dpapi'] as const){
    mustDenyBootstrap(b=>{
      if(mode==='missing-updater')b.aclNodes=b.aclNodes.filter(
        n=>n.path!==b.protectedImportPaths[1]);
      if(mode==='writable-parent'||mode==='writable-dpapi'){
        const name=mode==='writable-parent'?'C:\\ProtectedFixture':b.ownerKey.blobPath;
        b.aclNodes=b.aclNodes.map(n=>n.path===name?{...n,entries:[...n.entries,{
          principalSid:'S-1-5-11',kind:'Allow' as const,inherited:true,
          fileSystemRights:0x1301bf,
        }]}:n);
      }
      if(mode==='reparse-dll')b.aclNodes=b.aclNodes.map(n=>
        n.path===b.protectedImportPaths[2]?{...n,isReparsePoint:true}:n);
    },/S3_CORE_DELEGATION_/);
  }
});
test('crash after staging, stop, cutover, start and rollback stays UNKNOWN/no-auto-replay',()=>{
  for(const phase of CRASH_PHASES){
    const verdict=assessS3CrashRecovery(recovery(phase),recoveryPins);
    assert.equal(verdict.productionAccepted,false);
    assert.equal(verdict.resumeAllowed,false);
    assert.equal(verdict.rollbackAllowed,false);
    assert.equal(verdict.status,phase==='signed_stage_ready'
      ?'unverified_local_checkpoint':'interrupted_after_stop');
  }
  assert.equal(assessS3CrashRecovery(
    recovery('rollback_start_started',19),recoveryPins).status,'stale_or_rollback');
  assert.equal(assessS3CrashRecovery(
    {...recovery('target_cutover_started'),deviceId:'repaired-device'},
    recoveryPins).status,'invalid');
  assert.equal(assessS3CrashRecovery(
    {...recovery('target_cutover_started'),sequence:NaN},recoveryPins).status,'invalid');
  assert.equal(assessS3CrashRecovery(
    {...recovery('target_cutover_started'),phase:'completed' as S3CrashRecord['phase']},
    recoveryPins).status,'invalid');
});
test('broker detects even a fully reconstructed local journal after restart and refuses auto-reconciliation',async()=>{
  const b=brokerFixture();
  b.interruptedInstall={
    journal:recovery('rollback_start_started',20),
    pins:recoveryPins,
  };
  await assert.rejects(assessScopedBrokerTrust(b,inspectBroker),
    /S3_HYPERV_STARTUP_CRASH_MANUAL_VM_RECONCILIATION_REQUIRED/);
});
test('stale DPAPI keys, forged task/image identity and unverified old rollback cannot approve recovery',()=>{
  for(const mutation of [
    (b:CoreBootstrapEvidence)=>{b.ownerKey.independentEpoch=13;},
    (b:CoreBootstrapEvidence)=>{b.ownerKey.boundOwnerAccountId='old-owner';},
    (b:CoreBootstrapEvidence)=>{b.ownerKey.blobSha256=hash('old-key');},
    (b:CoreBootstrapEvidence)=>{b.ownerKey.unsealedInProtectedBroker=false;},
    (b:CoreBootstrapEvidence)=>{b.ownerKey.exportableToMediumCaller=true;},
  ])mustDenyBootstrap(mutation,/S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  for(const mutation of [
    (b:CoreBootstrapEvidence)=>{b.task.taskState='unknown';},
    (b:CoreBootstrapEvidence)=>{b.task.runningImageSha256=hash('old-image');},
    (b:CoreBootstrapEvidence)=>{b.task.taskRegistrationIdentityVerified=false;},
  ])mustDenyBootstrap(mutation,/S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/);
  for(const mutation of [
    (b:CoreBootstrapEvidence)=>{b.recovery.oldRollbackSignatureVerified=false;},
    (b:CoreBootstrapEvidence)=>{b.recovery.oldRollbackProtected=false;},
    (b:CoreBootstrapEvidence)=>{b.recovery.externalJournalVerified=false;},
    (b:CoreBootstrapEvidence)=>{b.recovery.pendingUnknownMutation=true;},
    (b:CoreBootstrapEvidence)=>{b.recovery.currentInstalledImageSha256=hash('old-image');},
  ])mustDenyBootstrap(mutation,/S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
});
test('crash mid-enrollment, revoked/re-paired owner and stale signed request cannot regain CORE',()=>{
  mustDenyBootstrap(b=>{b.physicalConsent.decision='unknown';},
    /S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/);
  mustDenyBootstrap(b=>{b.pins.minimumOwnerEpoch=15;},
    /S3_CORE_DELEGATION_OWNER_BOOTSTRAP_SCOPE_INVALID/);
  mustDenyBootstrap(b=>{b.revoked=true;},
    /S3_CORE_DELEGATION_OWNER_GRANT_REVOKED/);
  mustDenyBootstrap(b=>{b.command.ownerEpoch=13;},
    /S3_CORE_DELEGATION_DELEGATED_COMMAND_INVALID/);
  mustDenyBootstrap(b=>{b.command.deviceId='repaired-device';},
    /S3_CORE_DELEGATION_DELEGATED_COMMAND_INVALID/);
});
test('offline revoke is not an ACK: missing witness, running task or retained key deny independently',()=>{
  const base:CoreStopRevokeEvidence={
    operation:'revoke',ownerAccountId:'owner-28',deviceId:'device-28',
    independentEpoch:16,priorEpoch:15,independentWitnessVerified:true,
    taskState:'disabled',taskReadbackVerified:true,
    brokerImageHash:hash('broker'),expectedBrokerImageHash:hash('broker'),
    dpapiKeyAvailable:false,pendingUnknownMutation:false,
  };
  assert.deepEqual(assessCoreStopRevokeSource(base),{
    status:'source_only_revocation_readback',commandAllowed:false,productionAccepted:false,
  });
  for(const patch of [
    {independentWitnessVerified:false},{taskReadbackVerified:false},
    {pendingUnknownMutation:true},{independentEpoch:15},
    {brokerImageHash:hash('stale-running-image')},
  ])assert.throws(()=>assessCoreStopRevokeSource({...base,...patch}),
    /S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/);
  for(const patch of [
    {taskState:'running' as const},{taskState:'unknown' as const},
    {dpapiKeyAvailable:true},
  ])assert.throws(()=>assessCoreStopRevokeSource({...base,...patch}),
    /S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/);
});
