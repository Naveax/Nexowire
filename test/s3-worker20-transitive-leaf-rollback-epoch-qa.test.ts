/**
 * P0 Worker #20 independent, source-only adversarial #714 acceptance.
 * Fixture-derived structural helpers are intentionally isolated from
 * owner #12 source/tests. Never touch real files, UAC, ACL, Agent or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
 type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
 type CoreStageSignatureInspector,type CoreSignedImportDag,
 type CoreNativeImportDagReadback,
} from '../scripts/s3-core-broker-install-gate.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';
import {
 assessCoreAtomicRollbackSwitchSource,
 type CoreAtomicSwitchEvidence,type CoreBootstrapEvidence,
 type CoreOfflineRePairWitness,
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


function canonicalStage(f:ReturnType<typeof setup>):Buffer{
 const m=f.manifest;
 return Buffer.from(JSON.stringify({
  schemaVersion:m.schemaVersion,ownerAccountId:m.ownerAccountId,
  deviceId:m.deviceId,transactionId:m.transactionId,
  targetBrokerVersion:m.targetBrokerVersion,rollbackBrokerVersion:m.rollbackBrokerVersion,
  files:m.files.map(e=>({
   role:e.role,path:e.path,sha256:e.sha256,
   volumeIdentity:e.volumeIdentity,fileIdentity:e.fileIdentity,
  })),
 }));
}
/** A genuinely two-hop declared graph: broker -> runtime native -> provider -> deep crypto. */
function deepFixture(){
 const f=setup();
 const runtime=f.manifest.files.find(v=>v.role==='import-executable'&&v.path.includes('runtime'))!;
 const add=(relative:string,suffix:string)=>{
  const content=Buffer.from('SIGNED_SOURCE_ONLY_DEEP_'+suffix);
  const entry={
   role:'import-executable' as const,
   path:root+'\\'+relative,sha256:H(content),
   volumeIdentity:volumes,fileIdentity:'FILE_DEEP_'+suffix,
  };
  f.manifest.files.push(entry);
  f.readback.files.push({...entry,bytes:content,isReparsePoint:false});
  return entry;
 };
 const provider=add('runtime\\plugins\\provider.dll','PROVIDER0001');
 const deep=add('runtime\\plugins\\deep\\crypto.dll','CRYPTODLL0001');
 f.readback.aclNodes=covered(root,...f.manifest.files.map(v=>v.path));
 const stageBytes=canonicalStage(f);
 f.pins.manifestSha256=H(stageBytes);
 f.signature=sign(null,stageBytes,keys.privateKey).toString('base64');
 const b=bootstrap(f),d=dagFixture(f),a=atomicFixture(f,b);
 const runtimeDag=d.dag.modules.find(v=>v.path===runtime.path)!;
 runtimeDag.imports.push(provider.path);
 d.dag.modules.push(
  {path:provider.path,imports:[deep.path]},
  {path:deep.path,imports:[]},
 );
 d.dag.stageManifestSha256=f.pins.manifestSha256;
 d.native.modules=d.dag.modules.map(v=>({path:v.path,imports:[...v.imports]}));
 d.reseal();
 const old=oldWitness(f,b);
 return {f,b,d,a,old,provider,deep};
}
type Deep=ReturnType<typeof deepFixture>;
function verify(x:Deep,inspect:CoreStageSignatureInspector=x.f.inspect){
 return assessCoreAtomicRollbackSwitchSource(
  x.b,x.f.manifest,x.f.signature,x.f.pins,x.f.readback,
  x.d.dag,x.d.signature(),x.d.pins,x.d.native,
  x.old,x.a,inspect);
}
test('w20 #714: signed two-hop dependency remains source-only with no physical acceptance',async()=>{
 const x=deepFixture();
 const r=await verify(x);
 assert.deepEqual(r,{
  status:'atomic_switch_source_readback_only',
  physicalSwitchAccepted:false,realWindowsUacEnrolled:false,
  canResume:false,canRollbackAutomatically:false,canDispatchCore:false,
  productionApproved:false,
 });
});
test('w20 #714: deeply transitive DLL has wrong publisher, parent and direct DLL remain trusted',async()=>{
 const x=deepFixture();
 const invoked:string[]=[];
 const bad:CoreStageSignatureInspector=async(file,pins)=>{
  invoked.push(file);
  const valid=await x.f.inspect(file,pins);
  return file===x.deep.path?{...valid,publisherSubject:'CN=SUBTREE-FOREIGN'}:valid;
 };
 await assert.rejects(verify(x,bad),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
 assert.ok(invoked.includes(x.deep.path),'signed subdirectory leaf must be checked');
 assert.ok(invoked.includes(x.provider.path),'direct transitive parent must be checked');
});
test('w20 #714: deep DLL digest differs from independently signed stage, even when DAG matches',async()=>{
 const x=deepFixture();
 const captured=x.f.readback.files.find(v=>v.path===x.deep.path)!;
 captured.bytes=Buffer.from('ALTERED_BEFORE_PROTECTED_SWITCH');
 await assert.rejects(verify(x),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('w20 #714: correct deep bytes cannot excuse forged signature-inspector digest',async()=>{
 const x=deepFixture();
 const bad:CoreStageSignatureInspector=async(file,pins)=>{
  const v=await x.f.inspect(file,pins);
  return file===x.deep.path?{...v,sha256:H('foreign-executable-sha')}:v;
 };
 await assert.rejects(verify(x,bad),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
});
test('w20 #714: missing native edge for second-hop DLL cannot be hidden by a signed first-hop inventory',async()=>{
 const x=deepFixture();
 x.d.native.modules.find(m=>m.path===x.provider.path)!.imports=[];
 await assert.rejects(verify(x),
  /S3_CORE_INSTALL_IMPORT_DAG_(UNREACHABLE_DECLARED_FILE|NATIVE_DEPENDENCY_MISMATCH)/);
});
test('w20 #714: repaired owner cannot approve changed previous Agent 1.0.5 rollback volume',async()=>{
 const x=deepFixture();
 // Same signed old-version SHA and file ID, but post-switch volume provenance differs.
 x.a.previousRollbackAfter.volumeIdentity='DIFFERENT_VOLUME_AGENT105';
 await assert.rejects(verify(x),
  /S3_CORE_DELEGATION_ATOMIC_SWITCH_ROLLBACK_OR_POSTIMAGE_IDENTITY_CHANGED/);
});
test('w20 #714: old Agent 1.0.5 rollback import publisher invalid after fresh owner re-pair',async()=>{
 const x=deepFixture();
 const rollback=x.f.manifest.files.find(v=>v.role==='rollback')!;
 // The rollback image remains hash-consistent. Its Authenticode signer is now foreign.
 const inspect:CoreStageSignatureInspector=async(file,pins)=>{
  const good=await x.f.inspect(file,pins);
  return file===rollback.path?{...good,publisherSubject:'CN=OLD-AGENT-UNTRUSTED'}:good;
 };
 await assert.rejects(verify(x,inspect),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNTRUSTED/);
});
test('w20 #714: re-pair new owner signed epoch 12 cannot use stale old Agent 1.0.5 DPAPI epoch 11',async()=>{
 const x=deepFixture();
 assert.notEqual(x.old.previousDpapiBlobSha256,x.b.ownerKey.blobSha256);
 assert.equal(x.old.previousOwnerRevoked,true);
 assert.equal(x.old.previousDpapiKeyUnusable,true);
 // A different ciphertext and a claimed revocation still do not fix a stale SYSTEM owner epoch.
 x.b.ownerKey.independentEpoch=x.old.previousOwnerEpoch;
 await assert.rejects(verify(x),
  /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
});
