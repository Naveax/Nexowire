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
import {
 assessCoreSignedWindowsImportDag,
 type CoreSignedImportDag,type CoreNativeImportDagReadback,
 type CoreImportDagPins,
} from '../scripts/s3-core-broker-install-gate.js';
import {
 assessCoreOfflineRePairBootstrap,type CoreOfflineRePairWitness,
} from '../scripts/s3-core-bootstrap-delegation-audit.js';
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

const graphKey=generateKeyPairSync('ed25519');
type FullFixture={f:StageFixture;b:CoreBootstrapEvidence;dag:CoreSignedImportDag;
 dagPins:CoreImportDagPins;dagSignature:string;native:CoreNativeImportDagReadback;
 old:CoreOfflineRePairWitness};
function full():FullFixture{
 const f=stage(),b=bootstrap(f);
 const find=(part:string)=>f.manifest.files.find(z=>z.path.includes(part))!.path;
 const installer=find('installer\\installer.exe'),broker=find('runtime\\broker.exe');
 const helper=find('helper\\agent-helper.exe'),updater=find('updater\\update.exe');
 const rollback=find('rollback\\old-agent-1.0.5.exe');
 const runtimeDll=find('runtime\\subdirectory\\nested-native.dll');
 const updaterDll=find('updater\\subdirectory\\updater-native.dll');
 const rollbackDll=find('rollback\\subdirectory\\rollback-native.dll');
 const config=find('runtime\\subdirectory\\config.json');
 const dag:CoreSignedImportDag={
  schemaVersion:1,stageManifestSha256:f.pins.manifestSha256,
  modules:[
   {path:installer,imports:[helper]},
   {path:broker,imports:[runtimeDll,config]},
   {path:helper,imports:[]},
   {path:updater,imports:[updaterDll]},
   {path:rollback,imports:[rollbackDll]},
   {path:runtimeDll,imports:[]},
   {path:updaterDll,imports:[]},
   {path:rollbackDll,imports:[]},
  ],
 };
 const raw=Buffer.from(JSON.stringify({
  schemaVersion:dag.schemaVersion,stageManifestSha256:dag.stageManifestSha256,
  modules:dag.modules.map(z=>({path:z.path,imports:z.imports})),
 }));
 const dagPins:CoreImportDagPins={
  independentGraphKeyPem:keyPem(graphKey),
  independentGraphSha256:H(raw),
 };
 const dagSignature=sign(null,raw,graphKey.privateKey).toString('base64');
 const native:CoreNativeImportDagReadback={
  provider:'synthetic-fixture',
  modules:dag.modules.map(n=>({path:n.path,imports:[...n.imports]})),
  importResolutionComplete:true,nativeImageHandlesVerified:true,
  sawUnknownWindowsSystemDependency:false,
 };
 const old:CoreOfflineRePairWitness={
  provider:'independent-monotonic-owner-witness',
  previousOwnerAccountId:'revoked-owner-w20',deviceId:device,
  previousTransactionId:'revoked-owner-txn-0001',
  previousOwnerEpoch:51,
  previousDpapiBlobSha256:H('revoked-owner-dpapi-blob'),
  previousBrokerSha256:f.manifest.files.find(z=>z.role==='rollback')!.sha256,
  previousBrokerVersion:'1.0.5',
  previousTaskState:'disabled',previousTaskReadbackVerified:true,
  previousDpapiKeyUnusable:true,previousOwnerRevoked:true,
  externalNewOwnerEpoch:52,externalReadbackVerified:true,
  externalRevokeCommitted:true,pendingUnknownMutation:false,
  priorRollbackSignatureVerified:true,previousSignedJournalVerified:true,
 };
 return{f,b,dag,dagPins,dagSignature,native,old};
}
const inspectGraph=(x:FullFixture,provider:CoreStageSignatureInspector=x.f.inspect)=>
 assessCoreSignedWindowsImportDag(
  x.f.manifest,x.f.signature,x.f.pins,x.f.readback,
  x.dag,x.dagSignature,x.dagPins,x.native,provider);
const repair=(x:FullFixture,provider:CoreStageSignatureInspector=x.f.inspect)=>
 assessCoreOfflineRePairBootstrap(x.b,
  x.f.manifest,x.f.signature,x.f.pins,x.f.readback,
  x.dag,x.dagSignature,x.dagPins,x.native,x.old,provider);
async function rejected(
 mutate:(x:FullFixture)=>void,
 expected:RegExp,
):Promise<void>{
 const x=full();mutate(x);
 await assert.rejects(repair(x),expected);
}
test('qa20/696: complete signed updater/old Agent1.0.5 graph is source-only, never installed',async()=>{
 const x=full();
 assert.deepEqual(await inspectGraph(x),{
  status:'signed_import_dag_source_only',
  genuineNativeLoaderEvidence:false,actuallyInstalled:false,productionApproved:false,
 });
 assert.deepEqual(await repair(x),{
  status:'offline_repair_source_gate_only',
  newOwnerUacApprovedByThisModule:false,
  perCoreCommandUacRequired:'not_after_physically_accepted_broker',
  canInstall:false,canExecuteElevated:false,productionAccepted:false,
 });
 x.native.provider='trusted-native-win32-read-only';
 assert.equal((await repair(x)).canInstall,false);
});
test('qa20/696: nested updater DLL wrong Authenticode publisher fails even with correct Broker',async()=>{
 const x=full(),up=x.f.manifest.files.find(y=>y.path.includes('updater-native.dll'))!;
 let seen=0;
 const bad:CoreStageSignatureInspector=async(p,pins)=>{
  const valid=await x.f.inspect(p,pins);
  if(p!==up.path)return valid;
  seen++;
  return{...valid,publisherSubject:'CN=UNPINNED-FOREIGN-UPDATER'};
 };
 await assert.rejects(repair(x,bad),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
 assert.equal(seen,1);
});
test('qa20/696: nested updater DLL hash change fails despite old signed DAG',async()=>{
 const x=full(),up=x.f.readback.files.find(y=>y.path.includes('updater-native.dll'))!;
 up.bytes=Buffer.from('changed-after-signed-inspection');
 await assert.rejects(repair(x),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('qa20/696: nested updater DLL must match actual pinned DER cert, not only publisher',async()=>{
 const x=full(),up=x.f.manifest.files.find(y=>y.path.includes('updater-native.dll'))!;
 const bad:CoreStageSignatureInspector=async(p,pins)=>{
  const valid=await x.f.inspect(p,pins);
  return p===up.path?{...valid,certificateSha256:H('foreign-signing-cert')}:valid;
 };
 await assert.rejects(inspectGraph(x,bad),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
});
test('qa20/696: native updater import edge substitutions disagree with signed graph',async()=>{
 const x=full();
 const update=x.native.modules.find(y=>y.path.includes('update.exe'))!;
 update.imports.push(x.f.manifest.files.find(y=>y.path.includes('rollback-native.dll'))!.path);
 await assert.rejects(inspectGraph(x),/S3_CORE_INSTALL_IMPORT_DAG_NATIVE_DEPENDENCY_MISMATCH/);
});
test('qa20/696: no authenticated DLL handles or unknown Windows dependency is fail-closed',async()=>{
 for(const mode of ['handles','unknown','incomplete'] as const){
  const x=full();
  if(mode==='handles')x.native.nativeImageHandlesVerified=false;
  if(mode==='unknown')x.native.sawUnknownWindowsSystemDependency=true;
  if(mode==='incomplete')x.native.importResolutionComplete=false;
  await assert.rejects(repair(x),/S3_CORE_INSTALL_IMPORT_DAG_NATIVE_READBACK_UNAVAILABLE/);
 }
});
test('qa20/696: revoked previous owner old DPAPI key hash reused after re-pair is refused',async()=>{
 await rejected(x=>{
  x.old.previousOwnerRevoked=true;
  x.old.previousTaskState='disabled';
  x.old.previousDpapiKeyUnusable=true; // attacker asserts revoked while reusing exact same DPAPI blob
  x.old.previousDpapiBlobSha256=x.b.ownerKey.blobSha256;
 },/S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
});
test('qa20/696: revoked owner old key remains usable even after fake task stop receipt',async()=>{
 await rejected(x=>{
  x.old.previousTaskState='deleted';
  x.old.previousTaskReadbackVerified=true;
  x.old.previousDpapiKeyUnusable=false;
 },/S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
});
test('qa20/696: re-pair needs new monotonic owner epoch and new OS-local transaction',async()=>{
 await rejected(x=>{x.old.externalNewOwnerEpoch=x.old.previousOwnerEpoch;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.old.previousTransactionId=x.b.record.transactionId;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.b.physicalConsent.transactionId=x.old.previousTransactionId;},
  /S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/);
});
test('qa20/696: Agent1.0.5 signed rollback requires exact native signed publisher',async()=>{
 const x=full(),rollback=x.f.manifest.files.find(z=>z.role==='rollback')!;
 const forged:CoreStageSignatureInspector=async(p,pins)=>{
  const result=await x.f.inspect(p,pins);
  return p===rollback.path?{...result,publisherSubject:'CN=UNTRUSTED-OLD-AGENT'}:result;
 };
 await assert.rejects(repair(x,forged),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
});
test('qa20/696: Agent1.0.5 rollback bytes and file identity survive stage readback',async()=>{
 for(const mode of ['tampered','replaced'] as const){
  const x=full(),rollback=x.f.readback.files.find(z=>z.role==='rollback')!;
  if(mode==='tampered')rollback.bytes=Buffer.from('torn-rollback-copy-before-switch');
  else rollback.fileIdentity='DIFFERENT_FILE_ID_0001';
  await assert.rejects(repair(x),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 }
});
test('qa20/696: Agent1.0.5 recovery signed witness and old rollback digest required',async()=>{
 await rejected(x=>{x.old.priorRollbackSignatureVerified=false;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.old.previousBrokerSha256=H('foreign-agent-1.0.5-image');},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
});
test('qa20/696: crash before atomic switch leaves incomplete staging UNKNOWN, no approval',async()=>{
 await rejected(x=>{x.f.readback.noTraversalError=false;},
  /S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejected(x=>{x.f.readback.completeImportClosureAttested=false;},
  /S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejected(x=>{x.old.pendingUnknownMutation=true;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
});
test('qa20/696: crash before replace cannot claim switched image when old task still active',async()=>{
 await rejected(x=>{x.old.previousTaskState='running';},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.b.task.runningImageSha256=x.old.previousBrokerSha256;},
  /S3_CORE_DELEGATION_CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH/);
});
test('qa20/696: lost durable journal or revoke CAS readback denies crash recovery',async()=>{
 await rejected(x=>{x.old.previousSignedJournalVerified=false;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.old.externalReadbackVerified=false;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 await rejected(x=>{x.old.externalRevokeCommitted=false;},
  /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
});
