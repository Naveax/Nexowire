/**
 * #20 independent QA of #672 owner implementation, source-only.
 * Synthetic Ed25519 keys, fake executable bytes and injected signature facts.
 * NEVER installs, elevates, edits ACLs, accesses DPAPI, Task Scheduler or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
  assessProtectedCoreInstallerStage,
  type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
  type CoreStageSignatureInspector,type CoreStageRole,
} from '../scripts/s3-core-broker-install-gate.js';
import {assessCoreLinkedStageAndDelegation,type CoreBootstrapEvidence}
  from '../scripts/s3-core-bootstrap-delegation-audit.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

const H=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const stageKey=generateKeyPairSync('ed25519');
const ownerKey=generateKeyPairSync('ed25519');
const commandKey=generateKeyPairSync('ed25519');
const root='C:\\ProtectedFixture\\Nexowire';
const owner='fixture-owner-worker20',device='fixture-device-worker20';
const txn='fixture-owner-pair-txn20';
const subject='CN=Nexowire-Source-Fixture';
const certificate=H('independently-pinned-test-certificate');
const VOL='VOLUME_WORKER20';
const keyPem=(k:typeof stageKey)=>k.publicKey.export({format:'pem',type:'spki'}).toString();
type StageFixture={
 manifest:CoreStageManifest;pins:CoreStagePins;readback:CoreStageReadback;
 signature:string;inspect:CoreStageSignatureInspector;
};
function acl(files:readonly string[]):CapturedAclNode[]{
 const all=new Set<string>();
 for(let p of files){
  while(true){
   all.add(p);
   const parent=path.win32.dirname(p);
   if(parent===p)break;p=parent;
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
const fields=[
 ['installer','installer\\installer.exe'],
 ['broker','runtime\\broker.exe'],
 ['helper','helper\\agent-helper.exe'],
 ['updater','updater\\update.exe'],
 ['rollback','rollback\\old-agent-1.0.5.exe'],
 ['import-executable','runtime\\subdirectory\\nested-native.dll'],
 ['import-executable','updater\\subdirectory\\updater-native.dll'],
 ['import-executable','rollback\\subdirectory\\rollback-native.dll'],
 ['import-resource','runtime\\subdirectory\\config.json'],
] as const satisfies readonly (readonly [CoreStageRole,string])[];
function manifestBytes(m:CoreStageManifest):Buffer{
 return Buffer.from(JSON.stringify({
  schemaVersion:m.schemaVersion,ownerAccountId:m.ownerAccountId,
  deviceId:m.deviceId,transactionId:m.transactionId,
  targetBrokerVersion:m.targetBrokerVersion,
  rollbackBrokerVersion:m.rollbackBrokerVersion,
  files:m.files.map(f=>({
   role:f.role,path:f.path,sha256:f.sha256,
   volumeIdentity:f.volumeIdentity,fileIdentity:f.fileIdentity,
  })),
 }));
}
function stage():StageFixture{
 const files=fields.map(([role,relative],i)=>({
  role,path:root+'\\'+relative,sha256:H('SOURCE_BINARY_'+i),
  volumeIdentity:VOL,fileIdentity:'FILE_WORKER20_'+String(i).padStart(5,'0'),
 }));
 const manifest:CoreStageManifest={
  schemaVersion:1,ownerAccountId:owner,deviceId:device,transactionId:txn,
  targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',files,
 };
 const data=files.map((f,i)=>({
  ...f,bytes:Buffer.from('SOURCE_BINARY_'+i),isReparsePoint:false,
 }));
 const readback:CoreStageReadback={
  files:data,aclNodes:acl([root,...files.map(f=>f.path)]),
  noTraversalError:true,completeImportClosureAttested:true,
  source:'synthetic-fixture',
 };
 const canonical=manifestBytes(manifest);
 const pins:CoreStagePins={
  manifestPublicKeyPem:keyPem(stageKey),manifestSha256:H(canonical),
  publisherSubject:subject,certificateSha256:certificate,
  ownerAccountId:owner,deviceId:device,transactionId:txn,
  targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',
  trustedProtectedRoot:root,
 };
 const inspect:CoreStageSignatureInspector=async(_,p)=>({
  status:'signature_verified',sha256:p.sha256,
  publisherSubject:p.publisherSubject,certificateSha256:p.certificateSha256,
 });
 return {
  manifest,readback,pins,inspect,
  signature:sign(null,canonical,stageKey.privateKey).toString('base64'),
 };
}
const ownerFields=['schemaVersion','role','ownerAccountId','deviceId',
 'ownerEpoch','transactionId','brokerVersion','brokerSha256','installerSha256',
 'updaterSha256','dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
 'requestId','capability','inputSha256','sequence'];
function signRecord(value:object,order:readonly string[],key:typeof ownerKey):string{
 const fields=value as Record<string,unknown>;
 return sign(null,Buffer.from(JSON.stringify(Object.fromEntries(
  order.map(k=>[k,fields[k]])))),key.privateKey).toString('base64');
}
function bootstrap(f:StageFixture):CoreBootstrapEvidence{
 const get=(role:CoreStageRole)=>f.manifest.files.find(e=>e.role===role)!;
 const broker=get('broker'),installer=get('installer');
 const updater=get('updater'),rollback=get('rollback');
 const dpapiSha=H('fake-owner-dpapi-blob');
 const dpapiFile=root+'\\owner\\protected-dpapi.bin';
 const record={
  schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
  ownerAccountId:owner,deviceId:device,ownerEpoch:52,transactionId:txn,
  brokerVersion:'1.0.6',brokerSha256:broker.sha256,
  installerSha256:installer.sha256,updaterSha256:updater.sha256,
  dpapiBlobSha256:dpapiSha,taskName:'\\Nexowire\\PrivilegedBroker',
  approvedAtUnix:2000,
 };
 const command={
  schemaVersion:1 as const,ownerAccountId:owner,deviceId:device,
  ownerEpoch:52,requestId:'signed-command-w20-0001',
  capability:'core.admin.command' as const,
  inputSha256:H('command-input'),sequence:100,
 };
 return {
  record,recordSignature:signRecord(record,ownerFields,ownerKey),
  pins:{
   ownerPublicKeyPem:keyPem(ownerKey),commandPublicKeyPem:keyPem(commandKey),
   ownerAccountId:owner,deviceId:device,minimumOwnerEpoch:52,
   transactionId:txn,brokerVersion:'1.0.6',
   brokerSha256:broker.sha256,installerSha256:installer.sha256,
   updaterSha256:updater.sha256,dpapiBlobSha256:dpapiSha,
   nowUnix:2500,minimumIndependentCommandSequence:99,
   trustedPublisherSubject:subject,trustedSignerCertificateSha256:certificate,
  },
  physicalConsent:{
   provider:'windows-local-owner-os',sessionType:'physical-console',
   ownerAccountId:owner,deviceId:device,transactionId:txn,
   approvedInstallerSha256:installer.sha256,
   signedEnrollmentVerified:true,decision:'approved',
   remoteUiApprovalOnly:false,
  },
  task:{
   provider:'trusted-windows-task-scheduler',
   taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
   taskRunLevel:'highest',logonType:'service-account',principalSid:'S-1-5-18',
   ownerDeviceId:device,actionPath:broker.path,actionSha256:broker.sha256,
   brokerPublisherSubject:subject,brokerCertificateSha256:certificate,
   effectiveTokenProvider:'trusted-win32-token',tokenIsElevated:true,
   integrityRid:0x3000,administratorsEnabled:true,administratorsDenyOnly:false,
   nativeRunningImageHandle:true,runningImageSha256:broker.sha256,
   processCreationIdentity:'native-identity-w20-00001',
   taskRegistrationIdentityVerified:true,
  },
  ownerKey:{
   provider:'windows-dpapi-native',protectionScope:'current-user',
   protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
   blobPath:dpapiFile,blobSha256:dpapiSha,
   boundOwnerAccountId:owner,boundDeviceId:device,
   boundBrokerSha256:broker.sha256,independentEpoch:52,
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
   ...f.manifest.files.filter(e=>e.role.startsWith('import')).map(e=>e.path),
  ],
  aclNodes:acl([...f.manifest.files.map(e=>e.path),dpapiFile]),
  command,commandSignature:signRecord(command,commandFields,commandKey),
  revoked:false,
 };
}
const staged=(f:StageFixture,inspect=f.inspect)=>
 assessProtectedCoreInstallerStage(f.manifest,f.signature,f.pins,f.readback,inspect);
const linked=(f:StageFixture,b:CoreBootstrapEvidence,inspect=f.inspect)=>
 assessCoreLinkedStageAndDelegation(b,f.manifest,f.signature,f.pins,f.readback,inspect);

test('qa20: independent #672 positive fixture cannot certify actual installation or CORE',async()=>{
 const f=stage();const b=bootstrap(f);
 const s=await staged(f),out=await linked(f,b);
 assert.equal(s.actuallyInstalled,false);
 assert.equal(s.initialLocalUacApproved,false);
 assert.equal(s.productionApproved,false);
 assert.equal(out.elevatedCommandMayExecute,false);
 assert.equal(out.productionAccepted,false);
});
test('qa20: nested runtime/updater/rollback DLL requires exact publisher AND certificate',async()=>{
 for(const rel of ['runtime\\subdirectory\\nested-native.dll',
  'updater\\subdirectory\\updater-native.dll',
  'rollback\\subdirectory\\rollback-native.dll']){
  const f=stage(),nested=root+'\\'+rel;
  for(const attack of ['publisher','certificate','file-sha','unavailable'] as const){
   let targeted=0;
   const inspect:CoreStageSignatureInspector=async(p,pins)=>{
    if(p!==nested)return f.inspect(p,pins);
    targeted++;
    if(attack==='unavailable')throw new Error('forged-native-unavailable');
    const good=await f.inspect(p,pins);
    if(attack==='publisher')return {...good,publisherSubject:'CN=Foreign-Signed-Subdir'};
    if(attack==='certificate')return {...good,certificateSha256:H('foreign-cert')};
    return {...good,sha256:H('untrusted-file')};
   };
   await assert.rejects(staged(f,inspect),
    /S3_CORE_INSTALL_STAGED_AUTHENTICODE_(UNTRUSTED|UNAVAILABLE)/);
   assert.equal(targeted,1);
  }
 }
});
test('qa20: signed parent manifest cannot bless replacement subdirectory executable',async()=>{
 const f=stage(),nested=root+'\\runtime\\subdirectory\\nested-native.dll';
 f.readback.files.find(e=>e.path===nested)!.bytes=Buffer.from('tampered');
 await assert.rejects(staged(f),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('qa20: a publisher-matching top-level broker cannot override foreign nested signer',async()=>{
 const f=stage(),target=root+'\\runtime\\subdirectory\\nested-native.dll';
 let accepted=0;
 const inspect:CoreStageSignatureInspector=async(p,pins)=>{
  if(p!==target){accepted++;return f.inspect(p,pins);}
  return {...await f.inspect(p,pins),publisherSubject:'CN=Wrong-Dependency'};
 };
 await assert.rejects(staged(f,inspect),/STAGED_AUTHENTICODE_UNTRUSTED/);
 assert.ok(accepted>=1);
});
test('qa20: revoked owner re-pair rejects previous owner epoch before DPAPI use',async()=>{
 const f=stage(),b=bootstrap(f);
 b.pins.minimumOwnerEpoch=53;
 await assert.rejects(linked(f,b),/S3_CORE_DELEGATION_OWNER_BOOTSTRAP_SCOPE_INVALID/);
});
test('qa20: new signed re-pair record plus old DPAPI epoch is forbidden',async()=>{
 const f=stage(),b=bootstrap(f);
 b.record.ownerEpoch=53;
 b.recordSignature=signRecord(b.record,ownerFields,ownerKey);
 b.command.ownerEpoch=53;
 b.commandSignature=signRecord(b.command,commandFields,commandKey);
 b.pins.minimumOwnerEpoch=53;
 // DPAPI remains at 52: physically revoked old owner key cannot authorize epoch 53.
 await assert.rejects(linked(f,b),/S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
});
test('qa20: stale/foreign DPAPI blob and a revoked grant cannot satisfy re-pair',async()=>{
 for(const attack of ['blob','device','broker','revoke'] as const){
  const f=stage(),b=bootstrap(f);
  if(attack==='blob')b.ownerKey.blobSha256=H('old-epoch-blob');
  if(attack==='device')b.ownerKey.boundDeviceId='previous-owner-device';
  if(attack==='broker')b.ownerKey.boundBrokerSha256=H('previous-broker');
  if(attack==='revoke')b.revoked=true;
  await assert.rejects(linked(f,b),
   attack==='revoke'?/S3_CORE_DELEGATION_OWNER_GRANT_REVOKED/:
    attack==='broker'?/S3_CORE_DELEGATION_CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH/:
     /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
 }
});
test('qa20: interruption mid-replace with unchanged SHA but replaced file identity fails',async()=>{
 for(const which of ['broker','updater','rollback'] as const){
  const f=stage();
  const node=f.readback.files.find(e=>e.role===which)!;
  node.fileIdentity='REPLACED_'+node.fileIdentity;
  await assert.rejects(staged(f),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 }
});
test('qa20: mid-replace partial/unknown inventory must not produce install receipt',async()=>{
 const actions=[
  (f:StageFixture)=>{f.readback.noTraversalError=false;},
  (f:StageFixture)=>{f.readback.completeImportClosureAttested=false;},
  (f:StageFixture)=>{f.readback.files=f.readback.files.slice(0,-1);},
  (f:StageFixture)=>{f.readback.files[1]!.isReparsePoint=true;},
 ];
 for(const change of actions){
  const f=stage();change(f);
  await assert.rejects(staged(f),
   /S3_CORE_INSTALL_(STAGED_INVENTORY_NOT_COMPLETE|STAGED_HANDLE_OR_BYTES_CHANGED)/);
 }
});
test('qa20: crash after native-write dispatch remains UNKNOWN, never completed or replayed',async()=>{
 for(const attack of ['unknown','journal','old-image','rollback-untrusted'] as const){
  const f=stage(),b=bootstrap(f);
  if(attack==='unknown')b.recovery.pendingUnknownMutation=true;
  if(attack==='journal')b.recovery.externalJournalVerified=false;
  if(attack==='old-image')b.recovery.currentInstalledImageSha256=H('old-image-after-crash');
  if(attack==='rollback-untrusted')b.recovery.oldRollbackSignatureVerified=false;
  await assert.rejects(linked(f,b),/S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
 }
});
test('qa20: crash during cutover with different running image or lost task receipt fails closed',async()=>{
 for(const attack of ['image','task','consent'] as const){
  const f=stage(),b=bootstrap(f);
  if(attack==='image')b.task.runningImageSha256=H('new-image-not-attested');
  if(attack==='task')b.task.taskRegistrationIdentityVerified=false;
  if(attack==='consent')b.physicalConsent.signedEnrollmentVerified=false;
  await assert.rejects(linked(f,b),
   attack==='task'?/S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/:
    attack==='consent'?/S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/:
     /S3_CORE_DELEGATION_CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH/);
 }
});
test('qa20: cancelled recovery cannot silently relabel forged rollback executable',async()=>{
 const f=stage(),b=bootstrap(f);
 b.recovery.oldBrokerSha256=H('rollback-from-foreign-owner');
 await assert.rejects(linked(f,b),
  /S3_CORE_DELEGATION_CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH/);
});
