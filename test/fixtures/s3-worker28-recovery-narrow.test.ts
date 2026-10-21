/** Worker #28 source-only negatives. No Windows install/UAC/DPAPI/ACL/service/VM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import path from 'node:path';
import {
  canonicalAgentManifest,preflightAgentUpgrade,upgradeIsolatedAgent,
  type SignedRelease,type ReleaseTrust,type AgentRuntime,type UpgradeAdapter,
} from '../../src/update/agent-lifecycle-manager.js';
import {assessS3CrashRecovery,type S3RecoveryPins,type S3CrashRecord} from '../../scripts/s3-crash-recovery-assessment.js';
import {
  assessCoreInstalledBrokerSource,assessCoreStopRevokeSource,
  type CoreBootstrapEvidence,type CoreStopRevokeEvidence,
} from '../../scripts/s3-core-bootstrap-delegation-audit.js';
import type {CapturedAclNode} from '../../scripts/s3-windows-acl-preflight.js';

const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const keys=generateKeyPairSync('ed25519');
const owner=generateKeyPairSync('ed25519');
const command=generateKeyPairSync('ed25519');
const publisher='Fixture Nexowire Publisher', cert=sha('test-certificate');
const oldBytes=Buffer.from('TEST_SIGNED_OLD_INSTALLER_BYTES');
const newBytes=Buffer.from('TEST_SIGNED_TARGET_INSTALLER_BYTES');
const signFields=(r:object,fields:readonly string[],key:KeyObject)=>{
  const x=r as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k=>[k,x[k]])))),key).toString('base64');
};
function released(version:'1.0.5'|'1.0.6',author=publisher):SignedRelease{
  const artifact=Buffer.from(version==='1.0.5'?oldBytes:newBytes);
  const manifest={
    schemaVersion:1 as const,version,sourceSha:'c'.repeat(40),
    artifactSha256:sha(artifact),publisher:author,
    minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
    minHubVersion:'1.0.5',maxHubVersion:'1.0.6',
  };
  return {artifact,manifest,manifestSignature:sign(
    null,canonicalAgentManifest(manifest),keys.privateKey).toString('base64')};
}
const trust:ReleaseTrust={
  trustedManifestPublicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
  trustedPublisher:publisher,trustedCertificateSha256:cert,
  inspectPublisher:async bytes=>({
    signatureValid:true,publisher,artifactSha256:sha(bytes),certificateSha256:cert,
  }),
};
const runtime:AgentRuntime={
  ownerAccountId:'owner28',deviceId:'device28',agentVersion:'1.0.5',hubVersion:'1.0.5',
  brokerMode:'off',coreGrantId:null,privilegeMode:'safe',
  authSessionEpoch:'session22',authTokenValid:true,
};
const context=(rollbackRelease:SignedRelease)=>({
  expectedOwnerAccountId:'owner28',expectedDeviceId:'device28',
  minimumFreeBytes:1,availableBytes:8192,userApprovedDisruption:true,rollbackRelease,
});
const pins:S3RecoveryPins={
  transactionId:'copy-txn-28',ownerAccountId:'owner28',deviceId:'device28',
  oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',hubVersion:'1.0.5',
  oldArtifactSha256:sha(oldBytes),targetArtifactSha256:sha(newBytes),
  installerHelperSha256:sha('helper-fixture'),minimumIndependentSequence:22,
};
function journal(phase:S3CrashRecord['phase'],sequence=22):S3CrashRecord{
  return {schemaVersion:1,phase,sequence,transactionId:pins.transactionId,
    ownerAccountId:pins.ownerAccountId,deviceId:pins.deviceId,
    oldAgentVersion:pins.oldAgentVersion,targetAgentVersion:pins.targetAgentVersion,
    hubVersion:pins.hubVersion,oldArtifactSha256:pins.oldArtifactSha256,
    targetArtifactSha256:pins.targetArtifactSha256,
    installerHelperSha256:pins.installerHelperSha256};
}
test('signed installer mid-copy interruption cannot stop/cutover or replay old journal',async()=>{
  const calls:string[]=[];
  const stages=new Map<string,Buffer>();
  const adapter:UpgradeAdapter={
    acquireDeviceLock:async()=>{calls.push('lock');return async()=>{calls.push('unlock')};},
    readRuntime:async()=>({...runtime}),
    stageRollback:async old=>{stages.set('rollback',Buffer.from(old.artifact));calls.push('old-staged');},
    stage:async target=>{
      stages.set('target',Buffer.from(target.artifact.subarray(0,target.artifact.length-4)));
      calls.push('crash-during-copy');
    },
    readStagedBytes:async(_dev,slot)=>Buffer.from(stages.get(slot)??Buffer.alloc(0)),
    stopOwnedAgent:async()=>{calls.push('UNEXPECTED_STOP');},
    cutover:async()=>{calls.push('UNEXPECTED_CUTOVER');},
    startOwnedAgent:async()=>{calls.push('UNEXPECTED_START');},
    healthyRuntime:async()=>null,attestOwnedAgentBinary:async()=>null,
  };
  await assert.rejects(upgradeIsolatedAgent(
    released('1.0.6'),trust,context(released('1.0.5')),adapter),
  /S3_STAGED_TARGET_HASH_MISMATCH/);
  assert.deepEqual(calls,['lock','old-staged','crash-during-copy','unlock']);
  for(const [phase,sequence,status] of [
    ['signed_stage_ready',22,'unverified_local_checkpoint'],
    ['signed_stage_ready',21,'stale_or_rollback'],
    ['service_stop_started',22,'interrupted_after_stop'],
    ['target_cutover_started',22,'interrupted_after_stop'],
  ] as const){
    const outcome=assessS3CrashRecovery(journal(phase,sequence),pins);
    assert.equal(outcome.status,status);
    assert.equal(outcome.resumeAllowed,false);
    assert.equal(outcome.rollbackAllowed,false);
    assert.equal(outcome.productionAccepted,false);
  }
});
test('rollback manifest signed with trusted test key but foreign publisher fails before disruption',async()=>{
  const target=released('1.0.6'),wrong=released('1.0.5','Foreign Publisher');
  assert.equal(wrong.manifest.artifactSha256,sha(oldBytes));
  await assert.rejects(preflightAgentUpgrade(target,trust,context(wrong),runtime),
    /S3_PUBLISHER_MISMATCH/);
  const calls:string[]=[];
  const adapter:UpgradeAdapter={
    acquireDeviceLock:async()=>{calls.push('lock');return async()=>{calls.push('unlock');};},
    readRuntime:async()=>({...runtime}),
    stage:async()=>{calls.push('FORBIDDEN_STAGE');},
    stageRollback:async()=>{calls.push('FORBIDDEN_ROLLBACK_STAGE');},
    readStagedBytes:async()=>Buffer.alloc(0),
    stopOwnedAgent:async()=>{calls.push('FORBIDDEN_STOP');},
    cutover:async()=>{calls.push('FORBIDDEN_CUTOVER');},
    startOwnedAgent:async()=>{calls.push('FORBIDDEN_START');},
    healthyRuntime:async()=>null,attestOwnedAgentBinary:async()=>null,
  };
  await assert.rejects(upgradeIsolatedAgent(target,trust,context(wrong),adapter),
    /S3_PUBLISHER_MISMATCH/);
  assert.deepEqual(calls,['lock','unlock']);
});

const ownerFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
function acl(...values:string[]):CapturedAclNode[]{
  const names=new Set<string>();
  for(let filename of values){
    while(true){
      names.add(filename);const parent=path.win32.dirname(filename);
      if(parent===filename)break;
      filename=parent;
    }
  }
  return [...names].map(filename=>({
    path:filename,ownerSid:'S-1-5-32-544',isReparsePoint:false,
    entries:[
      {principalSid:'S-1-5-18',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
      {principalSid:'S-1-5-32-544',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
      {principalSid:'S-1-5-32-545',kind:'Allow' as const,inherited:true,fileSystemRights:0x1200a9},
    ],
  }));
}
function core():CoreBootstrapEvidence{
  const root='C:\\ProtectedFixture\\Nexowire';
  const broker=root+'\\runtime\\broker.exe',updater=root+'\\updater\\updater.exe';
  const imported=root+'\\updater\\native-bridge.dll',dpapi=root+'\\owner\\key.blob';
  const brokerSha=sha('fixture-broker'),installerSha=sha('fixture-installer');
  const updaterSha=sha('fixture-updater'),blobSha=sha('fixture-dpapi');
  const record={
    schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
    ownerAccountId:'owner28',deviceId:'device28',ownerEpoch:22,
    transactionId:'pair-txn-22',brokerVersion:'1.0.6',
    brokerSha256:brokerSha,installerSha256:installerSha,updaterSha256:updaterSha,
    dpapiBlobSha256:blobSha,taskName:'\\Nexowire\\PrivilegedBroker',
    approvedAtUnix:1000,
  };
  const commandRecord={
    schemaVersion:1 as const,ownerAccountId:'owner28',deviceId:'device28',
    ownerEpoch:22,requestId:'command-22',capability:'core.admin.command' as const,
    inputSha256:sha('typed-command-fixture'),sequence:44,
  };
  return {
    record,recordSignature:signFields(record,ownerFields,owner.privateKey),
    pins:{
      ownerPublicKeyPem:owner.publicKey.export({type:'spki',format:'pem'}).toString(),
      commandPublicKeyPem:command.publicKey.export({type:'spki',format:'pem'}).toString(),
      ownerAccountId:'owner28',deviceId:'device28',minimumOwnerEpoch:22,
      transactionId:'pair-txn-22',brokerVersion:'1.0.6',
      brokerSha256:brokerSha,installerSha256:installerSha,
      updaterSha256:updaterSha,dpapiBlobSha256:blobSha,
      nowUnix:1100,minimumIndependentCommandSequence:44,
      trustedPublisherSubject:publisher,trustedSignerCertificateSha256:cert,
    },
    physicalConsent:{
      provider:'windows-local-owner-os',sessionType:'physical-console',
      ownerAccountId:'owner28',deviceId:'device28',transactionId:'pair-txn-22',
      approvedInstallerSha256:installerSha,signedEnrollmentVerified:true,
      decision:'approved',remoteUiApprovalOnly:false,
    },
    task:{
      provider:'trusted-windows-task-scheduler',
      taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
      taskRunLevel:'highest',logonType:'service-account',
      principalSid:'S-1-5-18',ownerDeviceId:'device28',
      actionPath:broker,actionSha256:brokerSha,
      brokerPublisherSubject:publisher,brokerCertificateSha256:cert,
      effectiveTokenProvider:'trusted-win32-token',tokenIsElevated:true,
      integrityRid:0x3000,administratorsEnabled:true,administratorsDenyOnly:false,
      nativeRunningImageHandle:true,runningImageSha256:brokerSha,
      processCreationIdentity:'native-creation-id-00022',
      taskRegistrationIdentityVerified:true,
    },
    ownerKey:{
      provider:'windows-dpapi-native',protectionScope:'current-user',
      protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
      blobPath:dpapi,blobSha256:blobSha,boundOwnerAccountId:'owner28',
      boundDeviceId:'device28',boundBrokerSha256:brokerSha,
      independentEpoch:22,unsealedInProtectedBroker:true,
      exportableToMediumCaller:false,
    },
    recovery:{
      oldBrokerVersion:'1.0.5',oldBrokerSha256:sha('old-broker'),
      oldRollbackSignatureVerified:true,oldRollbackProtected:true,
      externalJournalVerified:true,pendingUnknownMutation:false,
      currentInstalledImageSha256:brokerSha,
    },
    protectedImportPaths:[broker,updater,imported],
    aclNodes:acl(broker,updater,imported,dpapi),
    command:commandRecord,
    commandSignature:signFields(commandRecord,commandFields,command.privateKey),
    revoked:false,
  };
}
test('protected updater import and ancestor ACL deny writable, missing and reparse trees',()=>{
  const normal=assessCoreInstalledBrokerSource(core());
  assert.equal(normal.elevatedCommandMayExecute,false);
  assert.equal(normal.productionAccepted,false);
  const base=core(),updater=base.protectedImportPaths[1],dll=base.protectedImportPaths[2];
  for(const target of [updater,dll,path.win32.dirname(updater)]){
    const x=core();
    x.aclNodes=x.aclNodes.map(n=>n.path===target?{...n,entries:[...n.entries,{
      principalSid:'S-1-5-11',kind:'Allow' as const,inherited:true,
      fileSystemRights:0x1301bf,
    }]}:n);
    assert.throws(()=>assessCoreInstalledBrokerSource(x),/S3_CORE_DELEGATION_ACL_INSECURE/);
  }
  for(const target of [updater,dll]){
    const x=core();x.aclNodes=x.aclNodes.filter(n=>n.path!==target);
    assert.throws(()=>assessCoreInstalledBrokerSource(x),
      /S3_CORE_DELEGATION_ACL_MISSING_PARENT_OR_IMPORT/);
  }
  const x=core();x.aclNodes=x.aclNodes.map(n=>
    n.path===dll?{...n,isReparsePoint:true}:n);
  assert.throws(()=>assessCoreInstalledBrokerSource(x),/S3_CORE_DELEGATION_ACL_INSECURE/);
});
test('offline re-pair rejects stale DPAPI key, stale owner epoch and unknown task revoke',()=>{
  const previous=core();previous.ownerKey.independentEpoch=21;
  assert.throws(()=>assessCoreInstalledBrokerSource(previous),
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  const badBlob=core();badBlob.ownerKey.blobSha256=sha('old-pair-blob');
  assert.throws(()=>assessCoreInstalledBrokerSource(badBlob),
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  const offline=core();offline.task.taskState='unknown';
  assert.throws(()=>assessCoreInstalledBrokerSource(offline),
    /S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/);
  const oldEnrollment=core();oldEnrollment.pins.minimumOwnerEpoch=23;
  assert.throws(()=>assessCoreInstalledBrokerSource(oldEnrollment),
    /S3_CORE_DELEGATION_OWNER_BOOTSTRAP_SCOPE_INVALID/);
  const evidence:CoreStopRevokeEvidence={
    operation:'revoke',ownerAccountId:'owner28',deviceId:'device28',
    independentEpoch:23,priorEpoch:22,independentWitnessVerified:true,
    taskState:'unknown',taskReadbackVerified:false,
    brokerImageHash:sha('fixture-broker'),expectedBrokerImageHash:sha('fixture-broker'),
    dpapiKeyAvailable:true,pendingUnknownMutation:false,
  };
  assert.throws(()=>assessCoreStopRevokeSource(evidence),
    /S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/);
  assert.throws(()=>assessCoreStopRevokeSource({...evidence,taskReadbackVerified:true}),
    /S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/);
  const confirmed=assessCoreStopRevokeSource({...evidence,taskState:'disabled',
    taskReadbackVerified:true,dpapiKeyAvailable:false});
  assert.equal(confirmed.commandAllowed,false);
  assert.equal(confirmed.productionAccepted,false);
});
