/**
 * Worker #28 independent #696 QA. Synthetic signatures/ACLs, scratch fixture journal.
 * NO real Windows installer, UAC, service, DPAPI, broker, network CAS or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,verify,type KeyObject} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessCoreSignedWindowsImportDag,
  type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
  type CoreStageSignatureInspector,type CoreSignedImportDag,
  type CoreNativeImportDagReadback,type CoreImportDagPins,
} from '../../scripts/s3-core-broker-install-gate.js';
import {
  assessCoreOfflineRePairBootstrap,type CoreOfflineRePairWitness,
  type CoreBootstrapEvidence,
} from '../../scripts/s3-core-bootstrap-delegation-audit.js';
import {
  assessS3CrashRecovery,type S3CrashRecord,type S3RecoveryPins,
} from '../../scripts/s3-crash-recovery-assessment.js';
import type {CapturedAclNode} from '../../scripts/s3-windows-acl-preflight.js';

const H=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const mkey=generateKeyPairSync('ed25519');
const dagkey=generateKeyPairSync('ed25519');
const ownerkey=generateKeyPairSync('ed25519');
const commandkey=generateKeyPairSync('ed25519');
const witnesskey=generateKeyPairSync('ed25519');
const ROOT='C:\\ProtectedFixture\\Nexowire';
const OWNER='fixture-owner-28',DEVICE='fixture-device-28',TXN='fixture-transaction-28';
const PUBLISHER='CN=Nexowire-Source-Only',CERT=H('CERTIFICATE_FIXTURE_NOT_AUTHENTICODE');
const FIELDS=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
  'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const CFIELDS=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
const signRecord=(value:object,fields:string[],key:KeyObject)=>{
  const obj=value as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify(Object.fromEntries(
    fields.map(f=>[f,obj[f]])))),key).toString('base64');
};
function protectedTree(...filenames:string[]):CapturedAclNode[]{
  const nodes=new Set<string>();
  for(let file of filenames){
    while(true){
      nodes.add(file);
      const parent=path.win32.dirname(file);
      if(parent===file)break;
      file=parent;
    }
  }
  return [...nodes].map(file=>({
    path:file,ownerSid:'S-1-5-32-544',isReparsePoint:false,
    entries:[
      {principalSid:'S-1-5-18',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
      {principalSid:'S-1-5-32-544',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
      {principalSid:'S-1-5-32-545',kind:'Allow' as const,inherited:true,fileSystemRights:0x1200a9},
    ],
  }));
}
function fixture(){
  const fileDefs=[
    ['installer','bootstrap\\install.exe'],
    ['broker','runtime\\broker.exe'],
    ['helper','helpers\\helper.exe'],
    ['updater','updater\\update.exe'],
    ['rollback','rollback\\old-1.0.5.exe'],
    ['import-executable','runtime\\lib.dll'],
    ['import-executable','updater\\native.dll'],
    ['import-resource','runtime\\policy.json'],
  ] as const;
  const files=fileDefs.map(([role,name],i)=>({
    role,path:ROOT+'\\'+name,sha256:H('28-DAG-PAYLOAD-'+i),
    volumeIdentity:'VOLUME_28_SOURCE_ONLY',
    fileIdentity:'FILE_ID_SOURCE_'+i.toString().padStart(8,'0'),
  }));
  const stage:CoreStageManifest={
    schemaVersion:1,ownerAccountId:OWNER,deviceId:DEVICE,transactionId:TXN,
    targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',files,
  };
  const stageBytes=Buffer.from(JSON.stringify({
    schemaVersion:1,ownerAccountId:OWNER,deviceId:DEVICE,transactionId:TXN,
    targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',
    files:files.map(f=>({
      role:f.role,path:f.path,sha256:f.sha256,
      volumeIdentity:f.volumeIdentity,fileIdentity:f.fileIdentity,
    })),
  }));
  const stageSig=sign(null,stageBytes,mkey.privateKey).toString('base64');
  const stagePins:CoreStagePins={
    manifestPublicKeyPem:mkey.publicKey.export({type:'spki',format:'pem'}).toString(),
    manifestSha256:H(stageBytes),publisherSubject:PUBLISHER,
    certificateSha256:CERT,ownerAccountId:OWNER,deviceId:DEVICE,transactionId:TXN,
    targetBrokerVersion:'1.0.6',rollbackBrokerVersion:'1.0.5',
    trustedProtectedRoot:ROOT,
  };
  const readback:CoreStageReadback={
    files:files.map((f,i)=>({...f,bytes:Buffer.from('28-DAG-PAYLOAD-'+i),isReparsePoint:false})),
    aclNodes:protectedTree(ROOT,...files.map(f=>f.path)),
    noTraversalError:true,completeImportClosureAttested:true,source:'synthetic-fixture',
  };
  const by=(role:string,contains?:string)=>{
    const record=files.find(f=>f.role===role&&(!contains||f.path.includes(contains)));
    assert.ok(record);return record;
  };
  const modules=[
    {path:by('installer').path,imports:[by('helper').path]},
    {path:by('broker').path,imports:[by('import-executable','runtime').path,by('import-resource').path]},
    {path:by('helper').path,imports:[]},
    {path:by('updater').path,imports:[by('import-executable','updater').path]},
    {path:by('rollback').path,imports:[]},
    {path:by('import-executable','runtime').path,imports:[]},
    {path:by('import-executable','updater').path,imports:[]},
  ];
  const dag:CoreSignedImportDag={schemaVersion:1,stageManifestSha256:stagePins.manifestSha256,modules};
  const dagBytes=Buffer.from(JSON.stringify({
    schemaVersion:1,stageManifestSha256:dag.stageManifestSha256,
    modules:dag.modules.map(m=>({path:m.path,imports:m.imports})),
  }));
  const dagSig=sign(null,dagBytes,dagkey.privateKey).toString('base64');
  const dagPins:CoreImportDagPins={
    independentGraphKeyPem:dagkey.publicKey.export({type:'spki',format:'pem'}).toString(),
    independentGraphSha256:H(dagBytes),
  };
  const native:CoreNativeImportDagReadback={
    provider:'synthetic-fixture',
    modules:modules.map(m=>({path:m.path,imports:[...m.imports]})),
    nativeImageHandlesVerified:true,importResolutionComplete:true,
    sawUnknownWindowsSystemDependency:false,
  };
  const inspect:CoreStageSignatureInspector=async(_filename,p)=>({
    status:'signature_verified',sha256:p.sha256,
    publisherSubject:p.publisherSubject,certificateSha256:p.certificateSha256,
  });
  return{stage,stageSig,stagePins,readback,dag,dagSig,dagPins,native,inspect,by};
}
type Fixture=ReturnType<typeof fixture>;
async function inspectDag(f:Fixture,inspector=f.inspect){
  return assessCoreSignedWindowsImportDag(
    f.stage,f.stageSig,f.stagePins,f.readback,
    f.dag,f.dagSig,f.dagPins,f.native,inspector);
}
function ownerBootstrap(f:Fixture):CoreBootstrapEvidence{
  const broker=f.by('broker'),installer=f.by('installer'),
    updater=f.by('updater'),old=f.by('rollback');
  const blobPath=ROOT+'\\owner\\owner-blob.bin',blobSha=H('new-pair-dpapi-blob');
  const record={
    schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
    ownerAccountId:OWNER,deviceId:DEVICE,ownerEpoch:22,
    transactionId:TXN,brokerVersion:'1.0.6',brokerSha256:broker.sha256,
    installerSha256:installer.sha256,updaterSha256:updater.sha256,
    dpapiBlobSha256:blobSha,taskName:'\\Nexowire\\PrivilegedBroker',
    approvedAtUnix:1000,
  };
  const command={
    schemaVersion:1 as const,ownerAccountId:OWNER,deviceId:DEVICE,ownerEpoch:22,
    requestId:'independent-req-28',capability:'core.admin.command' as const,
    inputSha256:H('only-synthetic-command'),sequence:56,
  };
  return{
    record,recordSignature:signRecord(record,FIELDS,ownerkey.privateKey),
    pins:{
      ownerPublicKeyPem:ownerkey.publicKey.export({type:'spki',format:'pem'}).toString(),
      commandPublicKeyPem:commandkey.publicKey.export({type:'spki',format:'pem'}).toString(),
      ownerAccountId:OWNER,deviceId:DEVICE,minimumOwnerEpoch:22,
      transactionId:TXN,brokerVersion:'1.0.6',brokerSha256:broker.sha256,
      installerSha256:installer.sha256,updaterSha256:updater.sha256,
      dpapiBlobSha256:blobSha,nowUnix:1100,minimumIndependentCommandSequence:55,
      trustedPublisherSubject:PUBLISHER,trustedSignerCertificateSha256:CERT,
    },
    physicalConsent:{
      provider:'windows-local-owner-os',sessionType:'physical-console',
      ownerAccountId:OWNER,deviceId:DEVICE,transactionId:TXN,
      approvedInstallerSha256:installer.sha256,
      signedEnrollmentVerified:true,decision:'approved',remoteUiApprovalOnly:false,
    },
    task:{
      provider:'trusted-windows-task-scheduler',
      taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
      taskRunLevel:'highest',logonType:'service-account',
      principalSid:'S-1-5-18',ownerDeviceId:DEVICE,
      actionPath:broker.path,actionSha256:broker.sha256,
      brokerPublisherSubject:PUBLISHER,brokerCertificateSha256:CERT,
      effectiveTokenProvider:'trusted-win32-token',
      tokenIsElevated:true,integrityRid:0x3000,
      administratorsEnabled:true,administratorsDenyOnly:false,
      nativeRunningImageHandle:true,runningImageSha256:broker.sha256,
      processCreationIdentity:'source-only-creation-id-28',
      taskRegistrationIdentityVerified:true,
    },
    ownerKey:{
      provider:'windows-dpapi-native',protectionScope:'current-user',
      protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
      blobPath,blobSha256:blobSha,
      boundOwnerAccountId:OWNER,boundDeviceId:DEVICE,
      boundBrokerSha256:broker.sha256,independentEpoch:22,
      unsealedInProtectedBroker:true,exportableToMediumCaller:false,
    },
    recovery:{
      oldBrokerVersion:'1.0.5',oldBrokerSha256:old.sha256,
      oldRollbackSignatureVerified:true,oldRollbackProtected:true,
      externalJournalVerified:true,pendingUnknownMutation:false,
      currentInstalledImageSha256:broker.sha256,
    },
    protectedImportPaths:[
      broker.path,updater.path,
      ...f.stage.files.filter(r=>r.role.startsWith('import')).map(r=>r.path),
    ],
    aclNodes:protectedTree(...f.stage.files.map(r=>r.path),blobPath),
    command,commandSignature:signRecord(command,CFIELDS,commandkey.privateKey),
    revoked:false,
  };
}
function priorWitness(f:Fixture,b:CoreBootstrapEvidence):CoreOfflineRePairWitness{
  return{
    provider:'independent-monotonic-owner-witness',
    previousOwnerAccountId:'prior-owner-28',deviceId:DEVICE,
    previousTransactionId:'old-txn-28',previousOwnerEpoch:21,
    previousDpapiBlobSha256:H('old-pair-dpapi-blob'),
    previousBrokerSha256:f.by('rollback').sha256,
    previousBrokerVersion:'1.0.5',
    previousTaskState:'disabled',previousTaskReadbackVerified:true,
    previousDpapiKeyUnusable:true,previousOwnerRevoked:true,
    externalNewOwnerEpoch:b.record.ownerEpoch,
    externalReadbackVerified:true,externalRevokeCommitted:true,
    pendingUnknownMutation:false,priorRollbackSignatureVerified:true,
    previousSignedJournalVerified:true,
  };
}
function inspectRePair(f:Fixture,b:CoreBootstrapEvidence,w:CoreOfflineRePairWitness){
  return assessCoreOfflineRePairBootstrap(
    b,f.stage,f.stageSig,f.stagePins,f.readback,
    f.dag,f.dagSig,f.dagPins,f.native,w,f.inspect);
}
function recoveryPins(f:Fixture):S3RecoveryPins{
  return{
    transactionId:TXN,ownerAccountId:OWNER,deviceId:DEVICE,
    oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',
    hubVersion:'1.0.5',oldArtifactSha256:f.by('rollback').sha256,
    targetArtifactSha256:f.by('installer').sha256,
    installerHelperSha256:f.by('helper').sha256,
    minimumIndependentSequence:22,
  };
}
function localRecord(p:S3RecoveryPins,phase:S3CrashRecord['phase']):S3CrashRecord{
  return{
    schemaVersion:1,transactionId:TXN,ownerAccountId:OWNER,deviceId:DEVICE,
    oldAgentVersion:'1.0.5',targetAgentVersion:'1.0.6',hubVersion:'1.0.5',
    oldArtifactSha256:p.oldArtifactSha256,
    targetArtifactSha256:p.targetArtifactSha256,
    installerHelperSha256:p.installerHelperSha256,
    sequence:22,phase,
  };
}

/** Persistent TEMP-FILE surrogate for an independent remote CAS.
 * Atomic exclusive file creation + fsync only demonstrates fixture-process restart.
 * It NEVER demonstrates a physically non-restorable off-host authority.
 */
interface Reservation{
  deviceId:string;ownerAccountId:string;ownerEpoch:number;
  requestId:string;stageSha256:string;dagSha256:string;
  disposition:'RESERVED_EFFECT_UNKNOWN';
}
interface SealedReservation{record:Reservation;signature:string}
class FakeExternalJournal{
  constructor(readonly dir:string,readonly minOwnerEpoch:number){}
  private filename(requestId:string){
    assert.match(requestId,/^[A-Za-z0-9_.-]{1,128}$/);
    return path.join(this.dir,'reservation-'+requestId+'.json');
  }
  async read(requestId:string):Promise<Reservation|null>{
    let bytes:string;
    try{bytes=await fs.readFile(this.filename(requestId),'utf8');}
    catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw error;
    }
    let sealed:SealedReservation;
    try{sealed=JSON.parse(bytes) as SealedReservation;}
    catch{throw new Error('UNTRUSTED_DURABLE_JOURNAL_PARSE');}
    if(!sealed?.record||typeof sealed.signature!=='string'||
       !verify(null,Buffer.from(JSON.stringify(sealed.record)),
         witnesskey.publicKey,Buffer.from(sealed.signature,'base64'))){
      throw new Error('UNTRUSTED_DURABLE_JOURNAL_SIGNATURE');
    }
    if(sealed.record.ownerEpoch<this.minOwnerEpoch||
       sealed.record.requestId!==requestId||
       sealed.record.ownerAccountId!==OWNER||
       sealed.record.deviceId!==DEVICE||
       sealed.record.disposition!=='RESERVED_EFFECT_UNKNOWN'){
      throw new Error('UNTRUSTED_DURABLE_JOURNAL_EPOCH_OR_OWNER');
    }
    return sealed.record;
  }
  async reserve(record:Reservation):Promise<'RESERVED'|'UNKNOWN_NO_REPLAY'>{
    if(record.ownerEpoch!==this.minOwnerEpoch||
      record.ownerAccountId!==OWNER||record.deviceId!==DEVICE||
      record.disposition!=='RESERVED_EFFECT_UNKNOWN'){
      throw Error('STALE_OWNER_OR_UNTRUSTED_RESERVATION');
    }
    const signature=sign(null,Buffer.from(JSON.stringify(record)),
      witnesskey.privateKey).toString('base64');
    try{
      const fd=await fs.open(this.filename(record.requestId),'wx',0o600);
      try{
        await fd.writeFile(JSON.stringify({record,signature}));
        await fd.sync();
      }finally{await fd.close()}
      return 'RESERVED';
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      await this.read(record.requestId);
      return 'UNKNOWN_NO_REPLAY';
    }
  }
}
test('signed stage + signed import DAG before atomic switch cannot claim completed after crash',async()=>{
  const f=fixture();
  const decision=await inspectDag(f);
  assert.deepEqual(decision,{
    status:'signed_import_dag_source_only',
    genuineNativeLoaderEvidence:false,actuallyInstalled:false,productionApproved:false,
  });
  const pins=recoveryPins(f);
  for(const phase of ['signed_stage_ready','target_cutover_started'] as const){
    const result=assessS3CrashRecovery(localRecord(pins,phase),pins);
    assert.equal(result.disposition,'NO_AUTOMATIC_RESTART_OR_ROLLBACK');
    assert.equal(result.resumeAllowed,false);
    assert.equal(result.rollbackAllowed,false);
    assert.equal(result.productionAccepted,false);
  }
  f.readback.files[0]!.bytes=Buffer.from('AFTER_SIGNED_MANIFEST_BEFORE_ATOMIC_SWITCH');
  await assert.rejects(inspectDag(f),/S3_CORE_INSTALL_STAGED_HANDLE_OR_BYTES_CHANGED/);
});
test('offline re-pair rejects stale DPAPI/owner witness even with valid signed import graph',async()=>{
  const good=fixture(),b=ownerBootstrap(good),w=priorWitness(good,b);
  const proof=await inspectRePair(good,b,w);
  assert.equal(proof.canInstall,false);
  assert.equal(proof.canExecuteElevated,false);
  assert.equal(proof.productionAccepted,false);
  for(const mutation of [
    (bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.previousDpapiBlobSha256=bx.ownerKey.blobSha256;},
    (_bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.previousDpapiKeyUnusable=false;},
    (_bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.previousTaskState='running';},
    (_bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.previousSignedJournalVerified=false;},
    (_bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.externalNewOwnerEpoch=21;},
    (_bx:CoreBootstrapEvidence,wx:CoreOfflineRePairWitness)=>{wx.pendingUnknownMutation=true;},
  ]){
    const f=fixture(),bx=ownerBootstrap(f),wx=priorWitness(f,bx);
    mutation(bx,wx);
    await assert.rejects(inspectRePair(f,bx,wx),
      /S3_CORE_DELEGATION_OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED/);
  }
  const stale=fixture(),previousTask=ownerBootstrap(stale);
  const sw=priorWitness(stale,previousTask);
  previousTask.ownerKey.independentEpoch=21;
  await assert.rejects(inspectRePair(stale,previousTask,sw),
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
});
test('updater-import DLL ACL cannot be writable and signed rollback cannot be unsigned',async()=>{
  const f=fixture();
  const oldPath=f.by('rollback').path;
  await assert.rejects(inspectDag(f,async(filename,expect)=>{
    if(filename===oldPath)throw Error('UNSIGNED_OLD_BACKUP');
    return f.inspect(filename,expect);
  }),/S3_CORE_INSTALL_STAGED_AUTHENTICODE_UNAVAILABLE/);
  for(const ancestor of [
    f.by('import-executable','updater').path,
    path.win32.dirname(f.by('import-executable','updater').path),
    path.win32.dirname(f.by('updater').path),
  ]){
    const s=fixture();
    s.readback.aclNodes=s.readback.aclNodes.map(node=>node.path===ancestor?{
      ...node,entries:[...node.entries,{
        principalSid:'S-1-5-11',kind:'Allow' as const,
        inherited:true,fileSystemRights:0x1301bf,
      }],
    }:node);
    await assert.rejects(inspectDag(s),
      /S3_CORE_INSTALL_STAGED_PROTECTED_ACL_INVALID/);
  }
  const d=fixture();
  const broken=d.native.modules.find(m=>m.path===d.by('updater').path)!;
  broken.imports.push(d.by('import-executable','runtime').path);
  await assert.rejects(inspectDag(d),/S3_CORE_INSTALL_IMPORT_DAG_NATIVE_DEPENDENCY_MISMATCH/);
});
test('persisted fixture external journal survives restart, CAS fences parallel rollback, lost ACK stays UNKNOWN',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire28-journal-fixture-'));
  try{
    const first=new FakeExternalJournal(dir,22);
    const record:Reservation={
      deviceId:DEVICE,ownerAccountId:OWNER,ownerEpoch:22,
      requestId:'rollback-request-28',stageSha256:H('stage-pinned'),
      dagSha256:H('signed-import-dag-pinned'),
      disposition:'RESERVED_EFFECT_UNKNOWN',
    };
    // Two independent worker instances race on an immutable external-surrogate reservation.
    const [a,b]=await Promise.all([first.reserve(record),
      new FakeExternalJournal(dir,22).reserve(record)]);
    assert.deepEqual([a,b].sort(),['RESERVED','UNKNOWN_NO_REPLAY']);
    const rebooted=new FakeExternalJournal(dir,22);
    assert.deepEqual(await rebooted.read(record.requestId),record);
    // Crash/lost ACK after possible Native side effect: no replay, no false COMPLETED.
    assert.equal(await rebooted.reserve(record),'UNKNOWN_NO_REPLAY');
    await assert.rejects(new FakeExternalJournal(dir,23).reserve(record),
      /STALE_OWNER_OR_UNTRUSTED_RESERVATION/);
    await assert.rejects(new FakeExternalJournal(dir,23).read(record.requestId),
      /UNTRUSTED_DURABLE_JOURNAL_EPOCH_OR_OWNER/);
    // A changed byte inside a persisted 'receipt' cannot validate as an external authority.
    const file=path.join(dir,'reservation-'+record.requestId+'.json');
    const original=await fs.readFile(file,'utf8');
    const altered=JSON.parse(original) as SealedReservation;
    altered.record={...record,disposition:'RESERVED_EFFECT_UNKNOWN',
      stageSha256:H('attacker-replaced-binary')};
    await fs.writeFile(file,JSON.stringify(altered));
    await assert.rejects(rebooted.reserve(record),
      /UNTRUSTED_DURABLE_JOURNAL_SIGNATURE/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
