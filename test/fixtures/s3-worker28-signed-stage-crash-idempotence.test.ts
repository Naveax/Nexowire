/**
 * #28 independent signed-stage, rollback and offline re-pair acceptance.
 * In-memory signed fixture + fake inspector ONLY. No Windows/UAC/ACL/DPAPI/VM mutation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import path from 'node:path';
import {
  assessProtectedCoreInstallerStage,
  type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
  type CoreStageSignatureInspector,type CoreStageEntry,
} from '../../scripts/s3-core-broker-install-gate.js';
import {
  assessCoreLinkedStageAndDelegation,assessCoreStopRevokeSource,
  type CoreBootstrapEvidence,type CoreStopRevokeEvidence,
} from '../../scripts/s3-core-bootstrap-delegation-audit.js';
import {
  assessS3CrashRecovery,type S3RecoveryPins,type S3CrashRecord,
} from '../../scripts/s3-crash-recovery-assessment.js';
import type {CapturedAclNode} from '../../scripts/s3-windows-acl-preflight.js';

const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const manifestKeys=generateKeyPairSync('ed25519');
const ownerKeys=generateKeyPairSync('ed25519');
const commandKeys=generateKeyPairSync('ed25519');
const root='C:\\ProtectedFixture\\Nexowire';
const owner='owner-28-stage',device='device-28-stage',txn='transaction-28-stage';
const publisher='CN=Nexowire-Fixture-Only',cert=hash('never-a-real-signing-certificate');
const volume='VOLUME_28_SYNTHETIC';
const roles=[
  ['installer','installer\\install.exe'],
  ['broker','runtime\\broker.exe'],
  ['helper','helpers\\helper.exe'],
  ['updater','updater\\updater.exe'],
  ['rollback','rollback\\agent-1.0.5.exe'],
  ['import-executable','runtime\\native.dll'],
  ['import-executable','updater\\bridge.dll'],
  ['import-resource','runtime\\policy.json'],
] as const;
function acl(...files:string[]):CapturedAclNode[]{
  const all=new Set<string>();
  for(let current of files){
    while(true){
      all.add(current);
      const parent=path.win32.dirname(current);
      if(parent===current)break;
      current=parent;
    }
  }
  return [...all].map(filename=>({
    path:filename,ownerSid:'S-1-5-32-544',isReparsePoint:false,
    entries:[
      {principalSid:'S-1-5-18',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-544',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
      {principalSid:'S-1-5-32-545',kind:'Allow' as const,fileSystemRights:0x1200a9,inherited:true},
    ],
  }));
}
function detached(record:object,fields:readonly string[],key:KeyObject):string{
  const values=record as Record<string,unknown>;
  const bytes=Buffer.from(JSON.stringify(Object.fromEntries(fields.map(f=>[f,values[f]]))));
  return sign(null,bytes,key).toString('base64');
}
function stage(){
  const files:CoreStageEntry[]=roles.map(([role,suffix],i)=>({
    role,path:root+'\\'+suffix,
    sha256:hash('STAGE28_BYTES_'+i),
    volumeIdentity:volume,fileIdentity:'NATIVEFILE_28_'+String(i).padStart(3,'0'),
  }));
  const manifest:CoreStageManifest={
    schemaVersion:1,ownerAccountId:owner,deviceId:device,
    transactionId:txn,targetBrokerVersion:'1.0.6',
    rollbackBrokerVersion:'1.0.5',files,
  };
  const canonical=Buffer.from(JSON.stringify({
    schemaVersion:1,ownerAccountId:owner,deviceId:device,
    transactionId:txn,targetBrokerVersion:'1.0.6',
    rollbackBrokerVersion:'1.0.5',
    files:files.map(f=>({
      role:f.role,path:f.path,sha256:f.sha256,
      volumeIdentity:f.volumeIdentity,fileIdentity:f.fileIdentity,
    })),
  }));
  const pins:CoreStagePins={
    manifestPublicKeyPem:manifestKeys.publicKey.export({type:'spki',format:'pem'}).toString(),
    manifestSha256:hash(canonical),publisherSubject:publisher,
    certificateSha256:cert,ownerAccountId:owner,deviceId:device,transactionId:txn,
    targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',
    trustedProtectedRoot:root,
  };
  const readback:CoreStageReadback={
    files:files.map((f,i)=>({...f,bytes:Buffer.from('STAGE28_BYTES_'+i),isReparsePoint:false})),
    aclNodes:acl(root,...files.map(f=>f.path)),
    noTraversalError:true,completeImportClosureAttested:true,source:'synthetic-fixture',
  };
  const signature=sign(null,canonical,manifestKeys.privateKey).toString('base64');
  const inspect:CoreStageSignatureInspector=async(_path,p)=>({
    status:'signature_verified',sha256:p.sha256,
    publisherSubject:p.publisherSubject,certificateSha256:p.certificateSha256,
  });
  return {manifest,pins,readback,signature,inspect};
}
const ownerFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
function bootstrap(s:ReturnType<typeof stage>):CoreBootstrapEvidence{
  const role=(name:CoreStageEntry['role'])=>s.manifest.files.find(f=>f.role===name)!;
  const broker=role('broker'),installer=role('installer'),updater=role('updater');
  const rollback=role('rollback');
  const dpapiPath=root+'\\owner\\owner-key.blob',dpapiSha=hash('SYNTHETIC_OWNER_BLOB');
  const record={
    schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
    ownerAccountId:owner,deviceId:device,ownerEpoch:22,transactionId:txn,
    brokerVersion:'1.0.6',brokerSha256:broker.sha256,
    installerSha256:installer.sha256,updaterSha256:updater.sha256,
    dpapiBlobSha256:dpapiSha,taskName:'\\Nexowire\\PrivilegedBroker',
    approvedAtUnix:1000,
  };
  const command={
    schemaVersion:1 as const,ownerAccountId:owner,deviceId:device,ownerEpoch:22,
    requestId:'request-28-safe',capability:'core.admin.command' as const,
    inputSha256:hash('source-only-no-shell'),sequence:45,
  };
  return {
    record,recordSignature:detached(record,ownerFields,ownerKeys.privateKey),
    pins:{
      ownerPublicKeyPem:ownerKeys.publicKey.export({type:'spki',format:'pem'}).toString(),
      commandPublicKeyPem:commandKeys.publicKey.export({type:'spki',format:'pem'}).toString(),
      ownerAccountId:owner,deviceId:device,minimumOwnerEpoch:22,
      transactionId:txn,brokerVersion:'1.0.6',brokerSha256:broker.sha256,
      installerSha256:installer.sha256,updaterSha256:updater.sha256,
      dpapiBlobSha256:dpapiSha,nowUnix:1100,minimumIndependentCommandSequence:44,
      trustedPublisherSubject:publisher,trustedSignerCertificateSha256:cert,
    },
    physicalConsent:{
      provider:'windows-local-owner-os',sessionType:'physical-console',
      ownerAccountId:owner,deviceId:device,transactionId:txn,
      approvedInstallerSha256:installer.sha256,
      signedEnrollmentVerified:true,decision:'approved',remoteUiApprovalOnly:false,
    },
    task:{
      provider:'trusted-windows-task-scheduler',
      taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
      taskRunLevel:'highest',logonType:'service-account',
      principalSid:'S-1-5-18',ownerDeviceId:device,
      actionPath:broker.path,actionSha256:broker.sha256,
      brokerPublisherSubject:publisher,brokerCertificateSha256:cert,
      effectiveTokenProvider:'trusted-win32-token',
      tokenIsElevated:true,integrityRid:0x3000,
      administratorsEnabled:true,administratorsDenyOnly:false,
      nativeRunningImageHandle:true,runningImageSha256:broker.sha256,
      processCreationIdentity:'independent-created-identity-28',
      taskRegistrationIdentityVerified:true,
    },
    ownerKey:{
      provider:'windows-dpapi-native',protectionScope:'current-user',
      protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
      blobPath:dpapiPath,blobSha256:dpapiSha,
      boundOwnerAccountId:owner,boundDeviceId:device,
      boundBrokerSha256:broker.sha256,independentEpoch:22,
      unsealedInProtectedBroker:true,exportableToMediumCaller:false,
    },
    recovery:{
      oldBrokerVersion:'1.0.5',oldBrokerSha256:rollback.sha256,
      oldRollbackSignatureVerified:true,oldRollbackProtected:true,
      externalJournalVerified:true,pendingUnknownMutation:false,
      currentInstalledImageSha256:broker.sha256,
    },
    protectedImportPaths:[
      broker.path,updater.path,
      ...s.manifest.files.filter(f=>f.role.startsWith('import')).map(f=>f.path),
    ],
    aclNodes:acl(...s.manifest.files.map(f=>f.path),dpapiPath),
    command,commandSignature:detached(command,commandFields,commandKeys.privateKey),
    revoked:false,
  };
}
function recoveryPins(s:ReturnType<typeof stage>):S3RecoveryPins{
  const file=(role:CoreStageEntry['role'])=>s.manifest.files.find(f=>f.role===role)!;
  return {
    transactionId:txn,ownerAccountId:owner,deviceId:device,
    oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',hubVersion:'1.0.5',
    oldArtifactSha256:file('rollback').sha256,
    targetArtifactSha256:file('installer').sha256,
    installerHelperSha256:file('helper').sha256,
    minimumIndependentSequence:22,
  };
}
function journal(p:S3RecoveryPins,phase:S3CrashRecord['phase'],sequence=22):S3CrashRecord{
  return {
    schemaVersion:1,transactionId:p.transactionId,
    ownerAccountId:p.ownerAccountId,deviceId:p.deviceId,
    oldAgentVersion:p.oldAgentVersion,targetAgentVersion:p.targetAgentVersion,
    hubVersion:p.hubVersion,oldArtifactSha256:p.oldArtifactSha256,
    targetArtifactSha256:p.targetArtifactSha256,
    installerHelperSha256:p.installerHelperSha256,phase,sequence,
  };
}
test('signed manifest checked, crash before atomic switch remains UNKNOWN and cannot auto-publish',async()=>{
  const s=stage();
  const accepted=await assessProtectedCoreInstallerStage(
    s.manifest,s.signature,s.pins,s.readback,s.inspect);
  assert.equal(accepted.status,'staged_source_checked');
  assert.equal(accepted.actuallyInstalled,false);
  assert.equal(accepted.initialLocalUacApproved,false);
  assert.equal(accepted.productionApproved,false);
  const p=recoveryPins(s);
  // No native atomic switch occurs here: this is source-only post-stage interruption.
  for(const phase of ['signed_stage_ready','target_cutover_started'] as const){
    const outcome=assessS3CrashRecovery(journal(p,phase),p);
    assert.equal(outcome.disposition,'NO_AUTOMATIC_RESTART_OR_ROLLBACK');
    assert.equal(outcome.resumeAllowed,false);
    assert.equal(outcome.rollbackAllowed,false);
    assert.equal(outcome.productionAccepted,false);
  }
  // Even the signed manifest cannot allow an altered post-inspection file handle.
  const changed=stage();
  changed.readback.files[0]!.bytes=Buffer.from('TOCTOU_AFTER_SIGNED_MANIFEST');
  await assert.rejects(assessProtectedCoreInstallerStage(
    changed.manifest,changed.signature,changed.pins,changed.readback,changed.inspect),
    /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('offline owner re-pair rejects stale DPAPI task epoch and stale signed task image',async()=>{
  const s=stage(),b=bootstrap(s);
  const result=await assessCoreLinkedStageAndDelegation(
    b,s.manifest,s.signature,s.pins,s.readback,s.inspect);
  assert.equal(result.elevatedCommandMayExecute,false);
  assert.equal(result.productionAccepted,false);
  for(const change of [
    (x:CoreBootstrapEvidence)=>{x.ownerKey.independentEpoch=21;},
    (x:CoreBootstrapEvidence)=>{x.ownerKey.boundOwnerAccountId='previous-owner';},
    (x:CoreBootstrapEvidence)=>{x.ownerKey.blobSha256=hash('old-pair-dpapi');},
  ]){
    const sx=stage(),bx=bootstrap(sx);change(bx);
    await assert.rejects(assessCoreLinkedStageAndDelegation(
      bx,sx.manifest,sx.signature,sx.pins,sx.readback,sx.inspect),
      /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
  }
  for(const change of [
    (x:CoreBootstrapEvidence)=>{x.task.taskState='unknown';},
    (x:CoreBootstrapEvidence)=>{x.task.actionSha256=hash('old-broker-binary');},
    (x:CoreBootstrapEvidence)=>{x.task.nativeRunningImageHandle=false;},
  ]){
    const sx=stage(),bx=bootstrap(sx);change(bx);
    await assert.rejects(assessCoreLinkedStageAndDelegation(
      bx,sx.manifest,sx.signature,sx.pins,sx.readback,sx.inspect),
      /S3_CORE_DELEGATION_(?:CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH|EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID)/);
  }
  const rep=stage(),old=bootstrap(rep);old.pins.minimumOwnerEpoch=23;
  await assert.rejects(assessCoreLinkedStageAndDelegation(
    old,rep.manifest,rep.signature,rep.pins,rep.readback,rep.inspect),
    /S3_CORE_DELEGATION_OWNER_BOOTSTRAP_SCOPE_INVALID/);
});
test('rollback restore rejects unsigned image even when updater parent is protected',async()=>{
  const s=stage();
  // The parent is correctly protected but an unsigned rollback must fail.
  const rollback=s.manifest.files.find(f=>f.role==='rollback')!;
  await assert.rejects(assessProtectedCoreInstallerStage(
    s.manifest,s.signature,s.pins,s.readback,
    async(filename,expected)=>{
      if(filename===rollback.path)throw Error('FAKE_AUTHENTICODE_UNAVAILABLE');
      return s.inspect(filename,expected);
    }),
    /S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNAVAILABLE/);
  // Conversely, a forged signed image cannot waive insecure updater ancestry.
  const bad=stage(),parent=path.win32.dirname(
    bad.manifest.files.find(f=>f.role==='updater')!.path);
  bad.readback.aclNodes=bad.readback.aclNodes.map(node=>node.path===parent?{
    ...node,entries:[...node.entries,{
      principalSid:'S-1-5-11',kind:'Allow' as const,
      inherited:true,fileSystemRights:0x1301bf,
    }],
  }:node);
  await assert.rejects(assessProtectedCoreInstallerStage(
    bad.manifest,bad.signature,bad.pins,bad.readback,bad.inspect),
    /S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
  // Attempting both flaws together still has no accepted restore outcome.
  await assert.rejects(assessProtectedCoreInstallerStage(
    bad.manifest,bad.signature,bad.pins,bad.readback,
    async(filename,expected)=>{
      if(filename===bad.manifest.files.find(f=>f.role==='rollback')!.path){
        throw Error('FAKE_UNSIGNED_ROLLBACK');
      }
      return bad.inspect(filename,expected);
    }),
    /S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
});
test('duplicate rollback journal is deterministic NO-REPLAY, never falsely idempotent OS mutation',()=>{
  const s=stage(),p=recoveryPins(s);
  const recorded=journal(p,'rollback_cutover_started',22);
  const first=assessS3CrashRecovery(recorded,p);
  const second=assessS3CrashRecovery({...recorded},p);
  assert.deepEqual(first,second);
  assert.equal(first.status,'interrupted_after_stop');
  assert.equal(first.resumeAllowed,false);
  assert.equal(first.rollbackAllowed,false);
  // Repaired owner external epoch fences the same old local rollback record.
  const advanced={...p,minimumIndependentSequence:23};
  assert.equal(assessS3CrashRecovery(recorded,advanced).status,'stale_or_rollback');
  const falseAck={...recorded,phase:'rolled_back'} as unknown;
  assert.equal(assessS3CrashRecovery(falseAck,p).status,'invalid');
  // Offline revoke ACK requires external witness, verified task state and no DPAPI key.
  const revocation:CoreStopRevokeEvidence={
    operation:'revoke',ownerAccountId:owner,deviceId:device,
    priorEpoch:22,independentEpoch:23,independentWitnessVerified:false,
    taskState:'unknown',taskReadbackVerified:false,
    brokerImageHash:hash('running-broker'),expectedBrokerImageHash:hash('running-broker'),
    dpapiKeyAvailable:true,pendingUnknownMutation:true,
  };
  assert.throws(()=>assessCoreStopRevokeSource(revocation),
    /S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/);
});
