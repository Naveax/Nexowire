import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
  assessProtectedCoreInstallerStage,
  type CoreStageManifest,type CoreStagePins,
  type CoreStageReadback,type CoreStageSignatureInspector,
} from '../scripts/s3-core-broker-install-gate.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';
import {assessCoreLinkedStageAndDelegation,
  type CoreBootstrapEvidence,
} from '../scripts/s3-core-bootstrap-delegation-audit.js';

const keys=generateKeyPairSync('ed25519');
const H=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const root='C:\\ProtectedFixture\\Nexowire';
const subject='CN=Nexowire-Test-Publisher';
const cert=H('fake-signing-cert');
const owner='owner-s3-fixture';
const device='device-s3-fixture';
const txn='signed-bootstrap-transaction';
const volumes='VOLUME_FAKE_01';
function covered(...files:string[]):CapturedAclNode[]{
 const nodes=new Set<string>();
 for(let p of files){
  while(true){nodes.add(p);const parent=path.win32.dirname(p);
   if(parent===p)break;p=parent;}
 }
 return [...nodes].map(p=>({
  path:p,ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[
   {principalSid:'S-1-5-18',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-544',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-545',kind:'Allow' as const,inherited:true,fileSystemRights:0x1200a9},
  ],
 }));
}
function setup(){
 const roles=[
  ['installer','installer\\bootstrap.exe'],
  ['broker','runtime\\broker.exe'],
  ['helper','helpers\\scoped-helper.exe'],
  ['updater','updater\\nexowire-updater.exe'],
  ['rollback','rollback\\previous.exe'],
  ['import-executable','runtime\\native.dll'],
  ['import-executable','updater\\submodule.dll'],
  ['import-resource','runtime\\policy.json'],
 ] as const;
 const data=roles.map(([role,name],i)=>({
  role,path:root+'\\'+name,sha256:H('STAGED_FIXTURE_'+i),
  volumeIdentity:volumes,fileIdentity:'FILE_ID_'+String(i).padStart(8,'0'),
 }));
 const manifest:CoreStageManifest={
  schemaVersion:1,ownerAccountId:owner,deviceId:device,
  transactionId:txn,targetBrokerVersion:'1.0.6',
  rollbackBrokerVersion:'1.0.5',files:data,
 };
 const canonical=JSON.stringify({
  schemaVersion:manifest.schemaVersion,ownerAccountId:owner,
  deviceId:device,transactionId:txn,targetBrokerVersion:'1.0.6',
  rollbackBrokerVersion:'1.0.5',
  files:manifest.files.map(f=>({
   role:f.role,path:f.path,sha256:f.sha256,
   volumeIdentity:f.volumeIdentity,fileIdentity:f.fileIdentity,
  })),
 });
 // The stage uses fixture bytes, never a Windows executable.
 const actual=roles.map(([role,name],i)=>({
  role,path:root+'\\'+name,sha256:data[i]!.sha256,
  volumeIdentity:volumes,fileIdentity:data[i]!.fileIdentity,
  bytes:Buffer.from('STAGED_FIXTURE_'+i),isReparsePoint:false,
 }));
 const readback:CoreStageReadback={
  files:actual,aclNodes:covered(root,...data.map(f=>f.path)),
  noTraversalError:true,completeImportClosureAttested:true,
  source:'synthetic-fixture',
 };
 const pins:CoreStagePins={
  manifestPublicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
  manifestSha256:H(canonical),publisherSubject:subject,
  certificateSha256:cert,ownerAccountId:owner,deviceId:device,
  transactionId:txn,targetBrokerVersion:'1.0.6',
  rollbackBrokerVersion:'1.0.5',trustedProtectedRoot:root,
 };
 const signature=sign(null,Buffer.from(canonical),keys.privateKey).toString('base64');
 const inspect:CoreStageSignatureInspector=async(_path,p)=>({
  status:'signature_verified',sha256:p.sha256,
  publisherSubject:p.publisherSubject,certificateSha256:p.certificateSha256,
 });
 return{manifest,pins,readback,signature,inspect};
}
async function rejectMutation(
 mutate:(f:ReturnType<typeof setup>)=>void,
 expected:RegExp=/S3_CORE_INSTALL_/,
){
 const f=setup();mutate(f);
 await assert.rejects(
  assessProtectedCoreInstallerStage(f.manifest,f.signature,f.pins,f.readback,f.inspect),
  expected,
 );
}
test('full signed stage manifest, all imports and exact native identity still NO-GO',async()=>{
 const f=setup();
 const result=await assessProtectedCoreInstallerStage(
  f.manifest,f.signature,f.pins,f.readback,f.inspect);
 assert.deepEqual(result,{
  status:'staged_source_checked',actuallyInstalled:false,
  initialLocalUacApproved:false,
  perCommandCoreUacRequired:'depends_on_physical_broker_enrollment',
  productionApproved:false,
 });
});
test('out-of-band manifest key/hash and owner/device/version cannot be substituted',async()=>{
 await rejectMutation(f=>{f.pins.manifestSha256='f'.repeat(64)},
  /S3_CORE_INSTALL_SIGNED_STAGE_POLICY_MISMATCH/);
 await rejectMutation(f=>{f.pins.manifestPublicKeyPem='bogus'},
  /S3_CORE_INSTALL_SIGNED_STAGE_TRUST_KEY_INVALID/);
 await rejectMutation(f=>{f.manifest.ownerAccountId='foreign-owner'},
  /S3_CORE_INSTALL_SIGNED_STAGE_POLICY_MISMATCH/);
 await rejectMutation(f=>{f.manifest.deviceId='foreign-device'},
  /S3_CORE_INSTALL_SIGNED_STAGE_POLICY_MISMATCH/);
 await rejectMutation(f=>{f.manifest.targetBrokerVersion='1.0.4'},
  /S3_CORE_INSTALL_SIGNED_STAGE_POLICY_MISMATCH/);
 await rejectMutation(f=>{f.pins.rollbackBrokerVersion='1.0.6'},
  /S3_CORE_INSTALL_STAGE_TRUST_PINS_UNAVAILABLE/);
});
test('valid manifest digest but forged Ed25519 signature rejects before inspecting executables',async()=>{
 await rejectMutation(f=>{
  const other=generateKeyPairSync('ed25519');
  f.signature=sign(null,Buffer.from('untrusted'),other.privateKey).toString('base64');
 },/S3_CORE_INSTALL_SIGNED_STAGE_SIGNATURE_INVALID/);
 await rejectMutation(f=>{f.signature='invalid-base64!'},
  /S3_CORE_INSTALL_SIGNED_STAGE_SIGNATURE_INVALID/);
});
test('full import closure and inventory reject omitted and extra imported executable/config',async()=>{
 await rejectMutation(f=>{f.readback.completeImportClosureAttested=false},
  /S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejectMutation(f=>{f.readback.noTraversalError=false},
  /S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejectMutation(f=>{f.readback.files=f.readback.files.slice(0,-1)},
  /S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejectMutation(f=>{f.readback.files.push({
  ...f.readback.files[0]!,fileIdentity:'FILE_ID_UNDECLARED',
  path:root+'\\runtime\\unknown.dll',
 })},/S3_CORE_INSTALL_STAGED_INVENTORY_NOT_COMPLETE/);
 await rejectMutation(f=>{f.readback.files[7]!.bytes=Buffer.from('MODIFIED_CONFIG')},
  /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('hardlink, renamed handle, other volume, reparse and path substitution fail closed',async()=>{
 await rejectMutation(f=>{f.readback.files[2]!.volumeIdentity='OTHER_VOLUME'},
  /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 await rejectMutation(f=>{f.readback.files[2]!.fileIdentity='FILE_ID_DIFFERENT'},
  /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 await rejectMutation(f=>{f.readback.files[2]!.path=root+'\\evil\\helper.exe'},
  /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 await rejectMutation(f=>{f.readback.files[1]!.isReparsePoint=true},
  /S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
 await rejectMutation(f=>{f.manifest.files[1]!.path='C:\\Users\\Public\\broker.exe'},
  /S3_CORE_INSTALL_SIGNED_STAGE_POLICY_MISMATCH/);
});
test('all parent and updater ACL entries deny inherited Authenticated Users Modify',async()=>{
 await rejectMutation(f=>{f.readback.aclNodes=f.readback.aclNodes.filter(n=>
  n.path!=='C:\\ProtectedFixture')},
  /S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
 await rejectMutation(f=>{f.readback.aclNodes=f.readback.aclNodes.filter(n=>
  n.path!==f.manifest.files[3]!.path)},
  /S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
 await rejectMutation(f=>{f.readback.aclNodes=f.readback.aclNodes.map(n=>
  n.path==='C:\\ProtectedFixture'?{
   ...n,entries:[...n.entries,{principalSid:'S-1-5-11',
    kind:'Allow' as const,fileSystemRights:0x1301bf,inherited:true}],
  }:n)},/S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
});
test('exact Authenticode publisher and certificate on every executable including rollback/import',async()=>{
 const f=setup();let calls=0;
 await assessProtectedCoreInstallerStage(
  f.manifest,f.signature,f.pins,f.readback,async(p,b)=>{
   calls++;return f.inspect(p,b);
  });
 assert.equal(calls,7);
 for(const role of ['rollback','import-executable','updater','installer','helper','broker'] as const){
  for(const bad of ['unsigned','publisher','certificate','digest'] as const){
   const g=setup();const target=g.manifest.files.find(z=>z.role===role)!;
   await assert.rejects(assessProtectedCoreInstallerStage(g.manifest,g.signature,g.pins,
    g.readback,async(p,expected)=>{
      const good=await g.inspect(p,expected);
      if(p!==target.path)return good;
      if(bad==='unsigned')throw new Error('AUTHENTICODE_UNAVAILABLE');
      if(bad==='publisher')return {...good,publisherSubject:'CN=Attacker'};
      if(bad==='certificate')return {...good,certificateSha256:H('evil-cert')};
      return {...good,sha256:H('changed-binary')};
    }),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_(?:UNAVAILABLE|UNTRUSTED)/);
  }
 }
});

const ownerKey=generateKeyPairSync('ed25519');
const commandKey=generateKeyPairSync('ed25519');
function bootstrap(f:ReturnType<typeof setup>):CoreBootstrapEvidence{
 const broker=f.manifest.files.find(x=>x.role==='broker')!;
 const installer=f.manifest.files.find(x=>x.role==='installer')!;
 const updater=f.manifest.files.find(x=>x.role==='updater')!;
 const rollback=f.manifest.files.find(x=>x.role==='rollback')!;
 const blobPath=root+'\\owner\\blob.bin';
 const blobSha=H('DPAPI_FAKE_OWNER_BLOB');
 const ownerFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256',
  'updaterSha256','dpapiBlobSha256','taskName','approvedAtUnix'];
 const commandFields=['schemaVersion','ownerAccountId','deviceId',
  'ownerEpoch','requestId','capability','inputSha256','sequence'];
 const record={
  schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
  ownerAccountId:owner,deviceId:device,ownerEpoch:12,transactionId:txn,
  brokerVersion:'1.0.6',brokerSha256:broker.sha256,
  installerSha256:installer.sha256,updaterSha256:updater.sha256,
  dpapiBlobSha256:blobSha,taskName:'\\Nexowire\\PrivilegedBroker',
  approvedAtUnix:1000,
 };
 const command={
  schemaVersion:1 as const,ownerAccountId:owner,deviceId:device,ownerEpoch:12,
  requestId:'signed-core-cmd-000001',capability:'core.admin.command' as const,
  inputSha256:H('bounded-core-command'),sequence:50,
 };
 const signed=(r:object,fields:string[],key:typeof ownerKey)=>{
  const value=r as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify(
   Object.fromEntries(fields.map(k=>[k,value[k]])))),key.privateKey).toString('base64');
 };
 return{
  record,recordSignature:signed(record,ownerFields,ownerKey),
  pins:{
   ownerPublicKeyPem:ownerKey.publicKey.export({format:'pem',type:'spki'}).toString(),
   commandPublicKeyPem:commandKey.publicKey.export({format:'pem',type:'spki'}).toString(),
   ownerAccountId:owner,deviceId:device,minimumOwnerEpoch:12,transactionId:txn,
   brokerVersion:'1.0.6',brokerSha256:broker.sha256,
   installerSha256:installer.sha256,updaterSha256:updater.sha256,
   dpapiBlobSha256:blobSha,nowUnix:1100,minimumIndependentCommandSequence:49,
   trustedPublisherSubject:subject,trustedSignerCertificateSha256:cert,
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
   brokerPublisherSubject:subject,brokerCertificateSha256:cert,
   effectiveTokenProvider:'trusted-win32-token',
   tokenIsElevated:true,integrityRid:0x3000,
   administratorsEnabled:true,administratorsDenyOnly:false,
   nativeRunningImageHandle:true,runningImageSha256:broker.sha256,
   processCreationIdentity:'trusted-creation-identity-core',
   taskRegistrationIdentityVerified:true,
  },
  ownerKey:{
   provider:'windows-dpapi-native',protectionScope:'current-user',
   protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
   blobPath,blobSha256:blobSha,
   boundOwnerAccountId:owner,boundDeviceId:device,
   boundBrokerSha256:broker.sha256,independentEpoch:12,
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
   ...f.manifest.files.filter(z=>z.role.startsWith('import')).map(z=>z.path),
  ],
  aclNodes:covered(...f.manifest.files.map(z=>z.path),blobPath),
  command,commandSignature:signed(command,commandFields,commandKey),
  revoked:false,
 };
}
test('cross-stage source checks bind signed installer, Task Scheduler, owner consent and DPAPI but NEVER enable CORE',async()=>{
 const f=setup();
 const e=bootstrap(f);
 const decision=await assessCoreLinkedStageAndDelegation(
  e,f.manifest,f.signature,f.pins,f.readback,f.inspect);
 assert.equal(decision.status,'source_only_not_deployed');
 assert.equal(decision.elevatedCommandMayExecute,false);
 assert.equal(decision.productionAccepted,false);
});
test('reject cross-stage task action, DPAPI Broker identity, owner installer consent and old rollback mismatch',async()=>{
 for(const action of [
  (e:CoreBootstrapEvidence)=>{e.task.actionPath=root+'\\other\\broker.exe'},
  (e:CoreBootstrapEvidence)=>{e.task.actionSha256=H('foreign-exe')},
  (e:CoreBootstrapEvidence)=>{e.ownerKey.boundBrokerSha256=H('foreign-image')},
  (e:CoreBootstrapEvidence)=>{e.physicalConsent.approvedInstallerSha256=H('foreign-installer')},
  (e:CoreBootstrapEvidence)=>{e.recovery.oldBrokerSha256=H('unsigned-rollback')},
  (e:CoreBootstrapEvidence)=>{e.record.updaterSha256=H('foreign-updater')},
 ]){
  const f=setup(),e=bootstrap(f);action(e);
  await assert.rejects(assessCoreLinkedStageAndDelegation(
   e,f.manifest,f.signature,f.pins,f.readback,f.inspect),
   /S3_CORE_DELEGATION_CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH/);
 }
});
test('signed import resource and DLL cannot be omitted from owner protected import-closure binding',async()=>{
 const f=setup(),e=bootstrap(f);
 const imported=f.manifest.files.find(z=>z.role==='import-executable')!;
 e.protectedImportPaths=e.protectedImportPaths.filter(p=>p!==imported.path);
 await assert.rejects(assessCoreLinkedStageAndDelegation(
  e,f.manifest,f.signature,f.pins,f.readback,f.inspect),
  /S3_CORE_DELEGATION_CROSS_STAGE_IMPORT_GRAPH_NOT_BOUND_TO_TASK/);
});
