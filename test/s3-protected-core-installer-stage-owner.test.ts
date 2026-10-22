import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
  assessProtectedCoreInstallerStage,assessCoreSignedWindowsImportDag,
  type CoreSignedImportDag,type CoreNativeImportDagReadback,
  type CoreStageManifest,type CoreStagePins,
  type CoreStageReadback,type CoreStageSignatureInspector,
} from '../scripts/s3-core-broker-install-gate.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';
import {assessCoreLinkedStageAndDelegation,assessCoreOfflineRePairBootstrap,
  assessCoreAtomicRollbackSwitchSource,assessCoreNativeAclAndDispatchSource,
  type CoreNativeAclV2Evidence,type CoreInstallerDispatchPins,
  type CoreInstallerPermitWitness,type CoreInstallerDispatchPermit,
  type CoreAtomicSwitchEvidence,
  type CoreBootstrapEvidence,type CoreOfflineRePairWitness,
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


const importKey=generateKeyPairSync('ed25519');
function dagFixture(f:ReturnType<typeof setup>){
  const get=(role:string,contains?:string)=>{
    const v=f.manifest.files.find(z=>z.role===role&&(!contains||z.path.includes(contains)));
    assert.ok(v);return v.path;
  };
  const broker=get('broker'),installer=get('installer'),helper=get('helper');
  const updater=get('updater'),rollback=get('rollback');
  const dll=get('import-executable','runtime'),upDll=get('import-executable','updater');
  const config=get('import-resource');
  const dag:CoreSignedImportDag={
    schemaVersion:1,stageManifestSha256:f.pins.manifestSha256,
    modules:[
      {path:installer,imports:[helper]},
      {path:broker,imports:[dll,config]},
      {path:helper,imports:[]},
      {path:updater,imports:[upDll]},
      {path:rollback,imports:[]},
      {path:dll,imports:[]},
      {path:upDll,imports:[]},
    ],
  };
  const bytes=()=>Buffer.from(JSON.stringify({
    schemaVersion:dag.schemaVersion,stageManifestSha256:dag.stageManifestSha256,
    modules:dag.modules.map(m=>({path:m.path,imports:m.imports})),
  }));
  const pins={
    independentGraphKeyPem:importKey.publicKey.export({type:'spki',format:'pem'}).toString(),
    independentGraphSha256:H(bytes()),
  };
  let signature=sign(null,bytes(),importKey.privateKey).toString('base64');
  const native:CoreNativeImportDagReadback={
    provider:'synthetic-fixture',modules:dag.modules.map(m=>({path:m.path,imports:[...m.imports]})),
    importResolutionComplete:true,nativeImageHandlesVerified:true,
    sawUnknownWindowsSystemDependency:false,
  };
  return{dag,pins,native,signature:()=>signature,reseal:()=>{
    pins.independentGraphSha256=H(bytes());
    signature=sign(null,bytes(),importKey.privateKey).toString('base64');
  }};
}
type DagFixture=ReturnType<typeof dagFixture>;
async function inspectDag(f:ReturnType<typeof setup>,d:DagFixture){
  return assessCoreSignedWindowsImportDag(
    f.manifest,f.signature,f.pins,f.readback,d.dag,d.signature(),d.pins,d.native,f.inspect);
}
test('signed Windows import DAG and native readback positive source still denies physical Broker',async()=>{
 const f=setup(),d=dagFixture(f);
 assert.deepEqual(await inspectDag(f,d),{
  status:'signed_import_dag_source_only',genuineNativeLoaderEvidence:false,
  actuallyInstalled:false,productionApproved:false,
 });
 d.native.provider='trusted-native-win32-read-only';
 assert.equal((await inspectDag(f,d)).productionApproved,false);
});
test('import DAG requires second independently pinned signature and exact release identity',async()=>{
 const f=setup(),d=dagFixture(f);
 d.pins.independentGraphSha256=H('forged');
 await assert.rejects(inspectDag(f,d),/IMPORT_DAG_INDEPENDENT_PIN_MISMATCH/);
 const a=dagFixture(f);
 a.pins.independentGraphKeyPem=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
 await assert.rejects(inspectDag(f,a),/IMPORT_DAG_SIGNATURE_INVALID/);
 const b=dagFixture(f);b.dag.stageManifestSha256=H('different-stage');b.reseal();
 await assert.rejects(inspectDag(f,b),/IMPORT_DAG_INDEPENDENT_PIN_MISMATCH/);
});
test('DAG closes transitive DLL/config graph: missing, extra, duplicate and orphan imports fail',async()=>{
 const f=setup();
 const changes=[
  (d:DagFixture)=>{d.dag.modules.pop()},
  (d:DagFixture)=>{d.dag.modules[1]!.imports.pop()},
  (d:DagFixture)=>{d.dag.modules[1]!.imports.push('C:\\evil\\rogue.dll')},
  (d:DagFixture)=>{d.dag.modules[1]!.imports.push(d.dag.modules[1]!.imports[0]!)},
  (d:DagFixture)=>{d.dag.modules[1]!.imports.push(d.dag.modules[1]!.path)},
  (d:DagFixture)=>{d.dag.modules[0]!.imports=[]},
 ];
 for(const change of changes){
  const d=dagFixture(f);change(d);d.reseal();
  await assert.rejects(inspectDag(f,d),/S3_CORE_INSTALL_(?:IMPORT_DAG_|STAGE_PATH_)/);
 }
});
test('native resolver missing an import, unknown system dependency or forged handles is rejected',async()=>{
 const f=setup(),d=dagFixture(f);
 d.native.modules[1]!.imports.pop();
 await assert.rejects(inspectDag(f,d),/IMPORT_DAG_(?:NATIVE_DEPENDENCY_MISMATCH|UNREACHABLE_DECLARED_FILE)/);
 for(const field of ['nativeImageHandlesVerified','importResolutionComplete'] as const){
  const z=dagFixture(f);z.native[field]=false;
  await assert.rejects(inspectDag(f,z),/IMPORT_DAG_NATIVE_READBACK_UNAVAILABLE/);
 }
 const z=dagFixture(f);z.native.sawUnknownWindowsSystemDependency=true;
 await assert.rejects(inspectDag(f,z),/IMPORT_DAG_NATIVE_READBACK_UNAVAILABLE/);
});
function oldWitness(f:ReturnType<typeof setup>,b:CoreBootstrapEvidence):CoreOfflineRePairWitness{
 const rollback=f.manifest.files.find(z=>z.role==='rollback')!;
 return{
  provider:'independent-monotonic-owner-witness',previousOwnerAccountId:'previous-owner',
  deviceId:device,previousTransactionId:'old-txn',
  previousOwnerEpoch:11,previousDpapiBlobSha256:H('old-dpapi-blob'),
  previousBrokerSha256:rollback.sha256,previousBrokerVersion:'1.0.5',
  previousTaskState:'disabled',previousTaskReadbackVerified:true,
  previousDpapiKeyUnusable:true,previousOwnerRevoked:true,
  externalNewOwnerEpoch:b.record.ownerEpoch,
  externalReadbackVerified:true,externalRevokeCommitted:true,
  pendingUnknownMutation:false,priorRollbackSignatureVerified:true,
  previousSignedJournalVerified:true,
 };
}
const repair=(f:ReturnType<typeof setup>,b:CoreBootstrapEvidence,d:DagFixture,w:CoreOfflineRePairWitness)=>
  assessCoreOfflineRePairBootstrap(
    b,f.manifest,f.signature,f.pins,f.readback,d.dag,d.signature(),d.pins,d.native,w,f.inspect);
test('offline re-pair source denies installation even with all positive synthetic receipts',async()=>{
 const f=setup(),b=bootstrap(f),d=dagFixture(f),w=oldWitness(f,b);
 assert.deepEqual(await repair(f,b,d,w),{
  status:'offline_repair_source_gate_only',newOwnerUacApprovedByThisModule:false,
  perCoreCommandUacRequired:'not_after_physically_accepted_broker',
  canInstall:false,canExecuteElevated:false,productionAccepted:false,
 });
});
test('offline re-pair denies stale owner epoch, active task, retained DPAPI key, crash and forged rollback',async()=>{
 const f=setup();
 const bad=[
  {previousTaskState:'running'},{previousTaskState:'unknown'},
  {previousTaskReadbackVerified:false},{previousDpapiKeyUnusable:false},
  {previousOwnerRevoked:false},{externalReadbackVerified:false},
  {externalRevokeCommitted:false},{pendingUnknownMutation:true},
  {priorRollbackSignatureVerified:false},{previousSignedJournalVerified:false},
  {previousOwnerEpoch:12},{externalNewOwnerEpoch:11},
  {deviceId:'foreign-device'},{previousTransactionId:txn},
  {previousBrokerSha256:H('forged-rollback')},
  {previousBrokerVersion:'1.0.4'},
 ];
 for(const change of bad){
  const b=bootstrap(f),d=dagFixture(f),w=oldWitness(f,b);
  Object.assign(w,change);
  await assert.rejects(repair(f,b,d,w),
    /OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 }
});
test('old DPAPI blob or old UAC consent transaction cannot silently re-enroll CORE',async()=>{
 const f=setup(),b=bootstrap(f),d=dagFixture(f),w=oldWitness(f,b);
 w.previousDpapiBlobSha256=b.ownerKey.blobSha256;
 await assert.rejects(repair(f,b,d,w),
   /OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
 const next=bootstrap(f),nw=oldWitness(f,next);
 next.physicalConsent.transactionId='old-txn';
 await assert.rejects(repair(f,next,dagFixture(f),nw),
   /LOCAL_OS_CONSENT_NOT_ATTESTED/);
});


function atomicFixture(f:ReturnType<typeof setup>,b:CoreBootstrapEvidence):CoreAtomicSwitchEvidence{
 const role=(r:string)=>{
  const x=f.manifest.files.find(z=>z.role===r);
  assert.ok(x);return x;
 };
 const broker=role('broker'),rollback=role('rollback'),updater=role('updater');
 const stageId=(v:typeof broker)=>({
  sha256:v.sha256,volumeIdentity:v.volumeIdentity,fileIdentity:v.fileIdentity,
 });
 return{
  provider:'synthetic-fixture',phase:'post-cutover-readback',
  transactionId:b.record.transactionId,ownerAccountId:b.record.ownerAccountId,
  deviceId:b.record.deviceId,ownerEpoch:b.record.ownerEpoch,
  externalSequence:52,minimumIndependentSequence:51,
  writeAheadJournalDurable:true,journalAuthenticatedByExternalAuthority:true,
  noPendingUnknownNativeMutation:true,postconditionWitnessVerified:true,
  beforeInstalled:{
   sha256:rollback.sha256,volumeIdentity:broker.volumeIdentity,
   fileIdentity:'PREVIOUS_INSTALLED_ID_0001',
  },
  stagedTarget:stageId(broker),
  installedAfterCutover:stageId(broker),
  previousRollbackBefore:stageId(rollback),
  previousRollbackAfter:stageId(rollback),
  postUpdater:stageId(updater),
  nativePostImportGraphVerified:true,nativePostProtectedAclVerified:true,
  nativePostSignerVerified:true,nativeTaskImageHandleVerified:true,
  nativeTaskCreationIdentity:b.task.processCreationIdentity,
  localWindowsConsentTransactionId:b.physicalConsent.transactionId,
 };
}
async function atomicCheck(
 f:ReturnType<typeof setup>,
 b:CoreBootstrapEvidence,
 d:DagFixture,
 a:CoreAtomicSwitchEvidence,
){
 return assessCoreAtomicRollbackSwitchSource(
  b,f.manifest,f.signature,f.pins,f.readback,d.dag,d.signature(),
  d.pins,d.native,oldWitness(f,b),a,f.inspect);
}
test('even fully signed DAG plus synthetic atomic identity postreadback never deploys or authorizes CORE',async()=>{
 const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
 assert.deepEqual(await atomicCheck(f,b,d,a),{
  status:'atomic_switch_source_readback_only',
  physicalSwitchAccepted:false,realWindowsUacEnrolled:false,
  canResume:false,canRollbackAutomatically:false,
  canDispatchCore:false,productionApproved:false,
 });
});
test('crash before or after native write dispatch remains UNKNOWN even if ACK claims success',async()=>{
 for(const phase of [
  'preflight','reserved','write-dispatched-unknown',
  'rollback-dispatched-unknown','rollback-readback',
 ] as const){
  const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
  a.phase=phase;
  await assert.rejects(atomicCheck(f,b,d,a),
   /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
 }
 const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
 a.noPendingUnknownNativeMutation=false;
 await assert.rejects(atomicCheck(f,b,d,a),
  /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
});
test('atomic switch must preserve signed prior rollback and exact volume/file identity, not digest alone',async()=>{
 const cases=[
  (a:CoreAtomicSwitchEvidence)=>{a.installedAfterCutover.fileIdentity='CHANGED_SAME_DIGEST_ID'},
  (a:CoreAtomicSwitchEvidence)=>{a.installedAfterCutover.volumeIdentity='DIFFERENT_VOLUME_ID'},
  (a:CoreAtomicSwitchEvidence)=>{a.previousRollbackAfter.fileIdentity='REPLACED_OLD_ROLLBACK_ID'},
  (a:CoreAtomicSwitchEvidence)=>{a.previousRollbackAfter.sha256=H('foreign-rollback')},
  (a:CoreAtomicSwitchEvidence)=>{a.stagedTarget.fileIdentity='RENAMED_HANDLE_ID'},
  (a:CoreAtomicSwitchEvidence)=>{a.postUpdater.fileIdentity='MODIFIED_IMPORT_ID'},
  (a:CoreAtomicSwitchEvidence)=>{a.beforeInstalled.sha256=H('unknown-original')},
  (a:CoreAtomicSwitchEvidence)=>{a.beforeInstalled.fileIdentity=a.installedAfterCutover.fileIdentity},
 ];
 for(const mutate of cases){
  const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
  mutate(a);
  await assert.rejects(atomicCheck(f,b,d,a),
   /ATOMIC_SWITCH_ROLLBACK_OR_POSTIMAGE_IDENTITY_CHANGED/);
 }
});
test('protected parent and native signed import DAG readback must survive after cutover',async()=>{
 for(const property of [
  'nativePostImportGraphVerified','nativePostProtectedAclVerified',
  'nativePostSignerVerified','nativeTaskImageHandleVerified',
  'writeAheadJournalDurable','journalAuthenticatedByExternalAuthority',
  'postconditionWitnessVerified',
 ] as const){
  const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
  a[property]=false;
  await assert.rejects(atomicCheck(f,b,d,a),
   /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
 }
 const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
 d.native.modules[0]!.imports.push('C:\\Outside\\unsigned.dll');
 await assert.rejects(atomicCheck(f,b,d,a),/S3_CORE_INSTALL_/);
});
test('owner UAC consent is one transaction, not reused when owner re-pairs offline',async()=>{
 const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
 a.localWindowsConsentTransactionId='previous-local-UAC-transaction';
 await assert.rejects(atomicCheck(f,b,d,a),
  /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
 const c=atomicFixture(f,b);c.ownerEpoch=11;
 await assert.rejects(atomicCheck(f,b,d,c),
  /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
});
test('missing independent sequence, forged provenance and stale task create time block rollback receipts',async()=>{
 for(const mutate of [
  (a:CoreAtomicSwitchEvidence)=>{a.externalSequence=12},
  (a:CoreAtomicSwitchEvidence)=>{a.minimumIndependentSequence=0},
  (a:CoreAtomicSwitchEvidence)=>{a.nativeTaskCreationIdentity='stale-job-pid'},
  (a:CoreAtomicSwitchEvidence)=>{a.transactionId='unrelated-owner-install'},
  (a:CoreAtomicSwitchEvidence)=>{a.deviceId='other-device'},
 ]){
  const f=setup(),b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
  mutate(a);
  await assert.rejects(atomicCheck(f,b,d,a),
   /ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED/);
 }
});


const authorityKey=generateKeyPairSync('ed25519');
const dispatchFields=['schemaVersion','kind','ownerAccountId','deviceId',
 'transactionId','ownerEpoch','grantGeneration','challengeNonce',
 'brokerSha256','stageManifestSha256','signedImportDagSha256',
 'rollbackSha256','dpapiBlobSha256',
 'processCreationIdentity','externalSequence'];
function nativeFenceFixture(){
 const f=setup(),b=bootstrap(f),atomic=atomicFixture(f,b),d=dagFixture(f);
 const sourcePaths=[...f.manifest.files.map(x=>x.path),b.ownerKey.blobPath];
 const items=new Set<string>();
 for(let p of sourcePaths){
  while(true){
   items.add(path.win32.normalize(p).toLowerCase());
   const parent=path.win32.dirname(p);
   if(path.win32.normalize(parent).toLowerCase()===path.win32.normalize(p).toLowerCase())break;
   p=parent;
  }
 }
 const acl:CoreNativeAclV2Evidence={
  kind:'windows_core_broker_protected_tree_readonly_v2',
  requestEnvelopeVersion:1,protectedRoot:root,
  acceptedInputPaths:sourcePaths,
  inspectedFilesCount:sourcePaths.length,
  inspectedEntries:[...items].map(p=>({
   path:p,evidenceAvailable:true,
   broadLowTrustWriteFound:false,reparsePointDetected:false,
  })),
  inputsInsideRoot:true,rejectedOutOfRootPaths:[],
  allInspectedPathsHaveAclEvidence:true,anyInspectedPathUnsafe:false,
  importListIndependentlyEnumerated:false,
  signedImportManifestVerified:false,
  protectedCompleteImageTreeAttested:false,
  productionReady:false,elevatedCoreDispatchEnabled:false,
 };
 const pins:CoreInstallerDispatchPins={
  authorityPublicKeyPem:authorityKey.publicKey.export({format:'pem',type:'spki'}).toString(),
  ownerAccountId:b.record.ownerAccountId,deviceId:b.record.deviceId,
  ownerEpoch:b.record.ownerEpoch,grantGeneration:4,
  expectedChallengeNonce:'a'.repeat(64),
  independentlyPinnedStageManifestSha256:f.pins.manifestSha256,
  independentlyPinnedImportDagSha256:d.pins.independentGraphSha256,
  minimumExternalSequence:50,
 };
 const permit:CoreInstallerDispatchPermit={
  schemaVersion:2,kind:'core_installer_dispatch_permit_source_v2',
  ownerAccountId:b.record.ownerAccountId,deviceId:b.record.deviceId,
  transactionId:b.record.transactionId,
  ownerEpoch:b.record.ownerEpoch,grantGeneration:4,
  challengeNonce:pins.expectedChallengeNonce,
  brokerSha256:atomic.installedAfterCutover.sha256,
  stageManifestSha256:f.pins.manifestSha256,
  signedImportDagSha256:d.pins.independentGraphSha256,
  rollbackSha256:atomic.previousRollbackAfter.sha256,
  dpapiBlobSha256:b.ownerKey.blobSha256,
  processCreationIdentity:atomic.nativeTaskCreationIdentity,
  externalSequence:atomic.externalSequence,
 };
 const signature=()=>sign(null,Buffer.from(JSON.stringify(
   Object.fromEntries(dispatchFields.map(key=>[
     key,(permit as unknown as Record<string,unknown>)[key],
   ])))),authorityKey.privateKey).toString('base64');
 const witness:CoreInstallerPermitWitness={
  signedPermit:permit,signatureBase64:signature(),
  independentlyAuthenticated:true,singleUseReserved:true,
  revoked:false,unknownMutation:false,
 };
 return{f,b,d,atomic,acl,pins,permit,witness,resign:()=>{
  witness.signatureBase64=signature();
 }};
}
function fence(v:ReturnType<typeof nativeFenceFixture>){
 return assessCoreNativeAclAndDispatchSource(
  v.f.manifest,v.f.pins,v.d.pins,v.b,v.atomic,v.acl,v.pins,v.witness);
}
test('native #709 v2 protected tree plus signed #712 epoch/nonce remain source-only, never privilege',()=>{
 const v=nativeFenceFixture();
 assert.deepEqual(fence(v),{
  status:'native_acl_and_permit_source_only',nativeHighTokenAttested:false,
  ownerOsConsentPhysicallyConfirmed:false,
  executionApproved:false,productionApproved:false,
 });
});
test('native #709 v2 denies missing imported DLL or parent, inherited Modify, reparse and v1 fallback',()=>{
 for(const mutation of [
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.kind='windows_core_broker_protected_tree_readonly_v1' as CoreNativeAclV2Evidence['kind'];},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.anyInspectedPathUnsafe=true;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.inputsInsideRoot=false;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.acceptedInputPaths.pop();},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.inspectedEntries.pop();},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.inspectedEntries[0]!.broadLowTrustWriteFound=true;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.inspectedEntries[2]!.reparsePointDetected=true;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.acl.inspectedEntries[1]!.evidenceAvailable=false;},
 ]){
  const v=nativeFenceFixture();mutation(v);
  assert.throws(()=>fence(v),/S3_CORE_DELEGATION_NATIVE_ACL_V2_/);
 }
});
test('signed external #712 ownerEpoch/grantGeneration/nonce and replay barrier reject forged/stale claims',()=>{
 for(const mutate of [
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.pins.grantGeneration=5;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.pins.ownerEpoch=11;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.pins.expectedChallengeNonce='b'.repeat(64);},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.singleUseReserved=false as true;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.revoked=true as false;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.unknownMutation=true as false;},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.signedPermit.externalSequence=49;v.resign();},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.signedPermit.brokerSha256=H('other signed executable');v.resign();},
  (v:ReturnType<typeof nativeFenceFixture>)=>{v.witness.signedPermit.processCreationIdentity='stale-pid-creation';v.resign();},
 ]){
  const v=nativeFenceFixture();mutate(v);
  assert.throws(()=>fence(v),/S3_CORE_DELEGATION_DISPATCH_PERMIT_OWNER_NONCE_EPOCH_STALE/);
 }
 const forged=nativeFenceFixture();
 forged.witness.signedPermit.grantGeneration=5;
 forged.witness.signedPermit.grantGeneration=4;
 forged.witness.signatureBase64=sign(null,Buffer.from('attacker'),authorityKey.privateKey).toString('base64');
 assert.throws(()=>fence(forged),/S3_CORE_DELEGATION_SIGNATURE_INVALID/);
});


test('signed installer root cannot be swapped for another #743 native protected-tree report',()=>{
 const mutations=[
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.acl.protectedRoot='C:\\DifferentProtectedRoot';
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.f.pins.trustedProtectedRoot='C:\\AnotherTrustedRoot';
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.b.ownerKey.blobPath='C:\\Users\\Public\\old-dpapi-blob.bin';
  },
 ];
 for(const mutation of mutations){
  const v=nativeFenceFixture();mutation(v);
  assert.throws(()=>fence(v),/NATIVE_ACL_V2_SIGNED_ROOT_MISMATCH/);
 }
});
test('valid old CORE nonce permit cannot authorize a newly signed importer DAG or release manifest',()=>{
 for(const mutate of [
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.f.pins.manifestSha256=H('re-signed-next-manifest');
    v.pins.independentlyPinnedStageManifestSha256=v.f.pins.manifestSha256;
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.d.pins.independentGraphSha256=H('next-dll-import-closure');
    v.pins.independentlyPinnedImportDagSha256=v.d.pins.independentGraphSha256;
  },
 ]){
  const v=nativeFenceFixture();mutate(v);
  assert.throws(()=>fence(v),/DISPATCH_PERMIT_OWNER_NONCE_EPOCH_STALE/);
 }
 const v=nativeFenceFixture();
 v.pins.independentlyPinnedImportDagSha256=H('attacker-untrusted-dag-pin');
 assert.throws(()=>fence(v),/SIGNED_IMPORT_RELEASE_SCOPE_MISMATCH/);
 const legacy=nativeFenceFixture();
 legacy.permit.schemaVersion=1 as 2;
 legacy.permit.kind='core_installer_dispatch_permit_source_v1' as CoreInstallerDispatchPermit['kind'];
 legacy.resign();
 assert.throws(()=>fence(legacy),/DISPATCH_PERMIT_OWNER_NONCE_EPOCH_STALE/);
});
test('source permit rejects stale revoked SYSTEM DPAPI blob and mismatched signed rollback after cutover',()=>{
 for(const mutate of [
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.permit.dpapiBlobSha256=H('revoked-previous-owner-dpapi-blob');
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.permit.rollbackSha256=H('unsigned-replacement-old-agent-image');
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.atomic.previousRollbackAfter.sha256=H('torn-rollback-after-atomic-replace');
  },
 ]){
  const v=nativeFenceFixture();mutate(v);v.resign();
  assert.throws(()=>fence(v),/DISPATCH_PERMIT_OWNER_NONCE_EPOCH_STALE|SIGNED_RELEASE_ATOMIC_READBACK_MISMATCH/);
 }
});

test('signed CORE permit cannot bridge an unresolved atomic cutover or same-hash file-ID replacement',()=>{
 for(const mutate of [
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.atomic.phase='write-dispatched-unknown';
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.atomic.noPendingUnknownNativeMutation=false;
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.atomic.installedAfterCutover.fileIdentity='DIFFERENT_NATIVE_FILE_ID';
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.atomic.previousRollbackAfter.fileIdentity='REPLACED_SIGNED_OLD_AGENT_ID';
  },
  (v:ReturnType<typeof nativeFenceFixture>)=>{
    v.b.ownerKey.independentEpoch=v.b.record.ownerEpoch-1;
  },
 ]){
  const v=nativeFenceFixture();mutate(v);
  assert.throws(()=>fence(v),/SIGNED_RELEASE_ATOMIC_READBACK_MISMATCH/);
 }
});
