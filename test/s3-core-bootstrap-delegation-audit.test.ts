import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
 assessCoreInstalledBrokerSource,assessCoreStopRevokeSource,
 type CoreBootstrapEvidence,type CoreStopRevokeEvidence,
} from '../scripts/s3-core-bootstrap-delegation-audit.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

const ownerKey=generateKeyPairSync('ed25519');
const commandKey=generateKeyPairSync('ed25519');
const otherKey=generateKeyPairSync('ed25519');
const signFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch','transactionId',
 'brokerVersion','brokerSha256','installerSha256','updaterSha256',
 'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
 'requestId','capability','inputSha256','sequence'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function detached(x:object,fields:readonly string[],key=ownerKey.privateKey):string{
 const v=x as Record<string,unknown>;
 const canonical=JSON.stringify(Object.fromEntries(fields.map(k=>[k,v[k]])));
 return sign(null,Buffer.from(canonical),key).toString('base64');
}
function aclFor(...paths:string[]):CapturedAclNode[]{
 const seen=new Set<string>();
 for(let name of paths){
  while(true){
   seen.add(name);const parent=path.win32.dirname(name);
   if(parent===name)break;name=parent;
  }
 }
 return Array.from(seen,pathname=>({
  path:pathname,ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[
   {principalSid:'S-1-5-18',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
   {principalSid:'S-1-5-32-544',kind:'Allow' as const,fileSystemRights:0x1f01ff,inherited:true},
   {principalSid:'S-1-5-32-545',kind:'Allow' as const,fileSystemRights:0x1200a9,inherited:true},
  ],
 }));
}
function fixture():CoreBootstrapEvidence{
 const broker='C:\\ProtectedFixture\\Nexowire\\runtime\\broker.exe';
 const updater='C:\\ProtectedFixture\\Nexowire\\updater\\updater.exe';
 const importDll='C:\\ProtectedFixture\\Nexowire\\runtime\\native-helper.dll';
 const keyPath='C:\\ProtectedFixture\\Nexowire\\owner\\dpapi-blob.bin';
 const brokerSha=hash('synthetic-broker');
 const installerSha=hash('synthetic-installer');
 const updaterSha=hash('synthetic-updater');
 const keySha=hash('synthetic-encrypted-dpapi-key-blob');
 const record={
  schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
  ownerAccountId:'fixture-owner',deviceId:'fixture-device',
  ownerEpoch:12,transactionId:'fixture-bootstrap-01',brokerVersion:'1.0.5',
  brokerSha256:brokerSha,installerSha256:installerSha,
  updaterSha256:updaterSha,dpapiBlobSha256:keySha,
  taskName:'\\Nexowire\\PrivilegedBroker',approvedAtUnix:1000,
 };
 const command={
  schemaVersion:1 as const,ownerAccountId:'fixture-owner',deviceId:'fixture-device',
  ownerEpoch:12,requestId:'fixture-request-01',
  capability:'core.admin.command' as const,
  inputSha256:hash('structured-core-admin-task'),sequence:78,
 };
 return{
  record,recordSignature:detached(record,signFields),
  pins:{
   ownerPublicKeyPem:ownerKey.publicKey.export({format:'pem',type:'spki'}).toString(),
   commandPublicKeyPem:commandKey.publicKey.export({format:'pem',type:'spki'}).toString(),
   ownerAccountId:'fixture-owner',deviceId:'fixture-device',minimumOwnerEpoch:12,
   transactionId:'fixture-bootstrap-01',brokerVersion:'1.0.5',
   brokerSha256:brokerSha,installerSha256:installerSha,
   updaterSha256:updaterSha,dpapiBlobSha256:keySha,
   nowUnix:1100,minimumIndependentCommandSequence:77,
   trustedPublisherSubject:'CN=Fixture Publisher',
   trustedSignerCertificateSha256:hash('synthetic-cert'),
  },
  physicalConsent:{
   provider:'windows-local-owner-os',sessionType:'physical-console',
   ownerAccountId:'fixture-owner',deviceId:'fixture-device',
   transactionId:'fixture-bootstrap-01',approvedInstallerSha256:installerSha,
   signedEnrollmentVerified:true,decision:'approved',remoteUiApprovalOnly:false,
  },
  task:{
   provider:'trusted-windows-task-scheduler',
   taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',
   taskRunLevel:'highest',logonType:'service-account',
   principalSid:'S-1-5-18',ownerDeviceId:'fixture-device',
   actionPath:broker,actionSha256:brokerSha,
   brokerPublisherSubject:'CN=Fixture Publisher',
   brokerCertificateSha256:hash('synthetic-cert'),
   effectiveTokenProvider:'trusted-win32-token',tokenIsElevated:true,
   integrityRid:0x3000,administratorsEnabled:true,administratorsDenyOnly:false,
   nativeRunningImageHandle:true,runningImageSha256:brokerSha,
   processCreationIdentity:'native-creation-id-00001',
   taskRegistrationIdentityVerified:true,
  },
  ownerKey:{
   provider:'windows-dpapi-native',protectionScope:'current-user',
   protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
   blobPath:keyPath,blobSha256:keySha,
   boundOwnerAccountId:'fixture-owner',boundDeviceId:'fixture-device',
   boundBrokerSha256:brokerSha,independentEpoch:12,
   unsealedInProtectedBroker:true,exportableToMediumCaller:false,
  },
  recovery:{
   oldBrokerVersion:'1.0.4',oldBrokerSha256:hash('old-broker'),
   oldRollbackSignatureVerified:true,oldRollbackProtected:true,
   externalJournalVerified:true,pendingUnknownMutation:false,
   currentInstalledImageSha256:brokerSha,
  },
  protectedImportPaths:[broker,updater,importDll],
  aclNodes:aclFor(broker,updater,importDll,keyPath),
  command,commandSignature:detached(command,commandFields,commandKey.privateKey),
  revoked:false,
 };
}
function denyChange(mutate:(fx:CoreBootstrapEvidence)=>void,code:RegExp):void{
 const fx=fixture();mutate(fx);
 assert.throws(()=>assessCoreInstalledBrokerSource(fx),code);
}
test('synthetic signed owner bootstrap & command show one-time UAC design but NEVER grant admin execution',()=>{
 const result=assessCoreInstalledBrokerSource(fixture());
 assert.deepEqual(result,{
  status:'source_only_not_deployed',
  initialUac:'one_local_os_approval_required_for_actual_install',
  perCommandUac:'not_required_only_after_real_broker_acceptance',
  elevatedCommandMayExecute:false,productionAccepted:false,
 });
});
test('owner authority key, signer and signed transaction cannot be forged or relayed to another device',()=>{
 for(const change of [
  (e:CoreBootstrapEvidence)=>{e.pins.ownerPublicKeyPem=otherKey.publicKey.export({format:'pem',type:'spki'}).toString()},
  (e:CoreBootstrapEvidence)=>{e.record.ownerAccountId='foreign-owner'},
  (e:CoreBootstrapEvidence)=>{e.record.deviceId='foreign-device'},
  (e:CoreBootstrapEvidence)=>{e.record.ownerEpoch=11},
  (e:CoreBootstrapEvidence)=>{e.record.approvedAtUnix=2000},
  (e:CoreBootstrapEvidence)=>{e.record.transactionId='replayed-txn'},
  (e:CoreBootstrapEvidence)=>{e.record.installerSha256=hash('replacement')},
 ]){
  const e=fixture();change(e);
  assert.throws(()=>assessCoreInstalledBrokerSource(e),/S3_CORE_DELEGATION_/);
 }
 denyChange(e=>{(e.record as unknown as Record<string,unknown>).allowUnscopedShell=true;},
  /S3_CORE_DELEGATION_SIGNED_FIELDS_INVALID/);
});
test('one-time local OS consent is not remote approved=true, consent.exe PID or UAC unknown',()=>{
 for(const change of [
  {decision:'denied'},{decision:'unknown'},{decision:'pending'},
  {provider:'remote-ui'},{provider:'consent.exe-seen'},
  {provider:'secure-desktop-clicker'},
  {signedEnrollmentVerified:false},{remoteUiApprovalOnly:true},
  {approvedInstallerSha256:hash('replaced-installer')},
  {ownerAccountId:'other-owner'},{transactionId:'different-txn'},
  {sessionType:'browser-tab'},
 ]){
  denyChange(e=>Object.assign(e.physicalConsent,change),
    /S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/);
 }
});
test('Task Scheduler SYSTEM principal, protected action, native effective token and process must align',()=>{
 const cases=[
  {taskRunLevel:'least'},{taskState:'ready'},{taskState:'unknown'},
  {provider:'broker-self-report'},{principalSid:'S-1-5-32-545'},
  {logonType:'interactive'},{ownerDeviceId:'foreign-device'},
  {actionSha256:hash('foreign-broker')},{brokerPublisherSubject:'CN=Foreign'},
  {brokerCertificateSha256:hash('foreign-cert')},
  {effectiveTokenProvider:'shell-stdout'},{tokenIsElevated:false},
  {integrityRid:0x2000},{administratorsEnabled:false},
  {administratorsDenyOnly:true},{nativeRunningImageHandle:false},
  {runningImageSha256:hash('other-running-image')},
  {processCreationIdentity:'PID-12'},{taskRegistrationIdentityVerified:false},
 ];
 for(const change of cases){
  denyChange(e=>Object.assign(e.task,change),
    /S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/);
 }
});
test('DPAPI CurrentUser SYSTEM identity is distinct from unsafe machine/unprivileged blob export',()=>{
 for(const change of [
  {provider:'remote-blob'},{protectionScope:'local-machine'},
  {protectingSid:'S-1-5-32-545'},{blobOwnerSid:'S-1-5-11'},
  {blobSha256:hash('replaced-blob')},{boundOwnerAccountId:'foreign-owner'},
  {boundDeviceId:'foreign-device'},{boundBrokerSha256:hash('foreign-broker')},
  {independentEpoch:11},{unsealedInProtectedBroker:false},
  {exportableToMediumCaller:true},
 ]){
  denyChange(e=>Object.assign(e.ownerKey,change),
    /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
 }
});
test('parent/updater/import/DPAPI ACL protections fail closed on inherited Modify and missing files',()=>{
 for(const mode of ['parent','updater','key','modify','reparse','owner'] as const){
  const e=fixture();
  if(mode==='parent')e.aclNodes=e.aclNodes.filter(n=>n.path!=='C:\\ProtectedFixture');
  if(mode==='updater')e.aclNodes=e.aclNodes.filter(n=>n.path!==e.protectedImportPaths[1]);
  if(mode==='key')e.aclNodes=e.aclNodes.filter(n=>n.path!==e.ownerKey.blobPath);
  if(mode==='modify')e.aclNodes=e.aclNodes.map(n=>
   n.path==='C:\\ProtectedFixture'?{...n,entries:[...n.entries,{
    principalSid:'S-1-5-11',kind:'Allow' as const,inherited:true,fileSystemRights:0x1301bf,
   }]}:n);
  if(mode==='reparse')e.aclNodes=e.aclNodes.map(n=>
   n.path===e.task.actionPath?{...n,isReparsePoint:true}:n);
  if(mode==='owner')e.aclNodes=e.aclNodes.map(n=>
   n.path===e.ownerKey.blobPath?{...n,ownerSid:'S-1-5-21-100-200-300-400'}:n);
  assert.throws(()=>assessCoreInstalledBrokerSource(e),/S3_CORE_DELEGATION_/);
 }
});
test('signed owner command binds owner/device/grant epoch/unique request/durable sequence without per-command UAC',()=>{
 for(const change of [
  {ownerAccountId:'other-owner'},{deviceId:'other-device'},
  {ownerEpoch:11},{requestId:'?'},{capability:'elevated-broker-bypass'},
  {inputSha256:'bad-input'},{sequence:76},{sequence:1.1},
 ]){
  denyChange(e=>Object.assign(e.command,change),/S3_CORE_DELEGATION_DELEGATED_COMMAND_INVALID/);
 }
 denyChange(e=>{e.commandSignature=detached({...e.command,sequence:999},commandFields,commandKey.privateKey)},
  /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
 denyChange(e=>{e.pins.commandPublicKeyPem=otherKey.publicKey.export({format:'pem',type:'spki'}).toString()},
  /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
 denyChange(e=>{(e.command as unknown as Record<string,unknown>).uacEveryCommand=false},
  /S3_CORE_DELEGATION_SIGNED_FIELDS_INVALID/);
});
test('rollback, incomplete external journal, UNKNOWN mutation and owner revoke block privilege',()=>{
 for(const change of [
  {oldRollbackSignatureVerified:false},{oldRollbackProtected:false},
  {externalJournalVerified:false},{pendingUnknownMutation:true},
  {currentInstalledImageSha256:hash('rolled-back-running-image')},
  {oldBrokerSha256:hash('synthetic-broker')},
  {oldBrokerVersion:'1.0.5'},
 ]){
  denyChange(e=>Object.assign(e.recovery,change),/S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
 }
 denyChange(e=>{e.revoked=true},/S3_CORE_DELEGATION_OWNER_GRANT_REVOKED/);
});
function revokeFixture():CoreStopRevokeEvidence{
 return{
  operation:'stop',ownerAccountId:'fixture-owner',deviceId:'fixture-device',
  independentEpoch:14,priorEpoch:13,independentWitnessVerified:true,
  taskState:'stopped',taskReadbackVerified:true,
  brokerImageHash:hash('synthetic-broker'),expectedBrokerImageHash:hash('synthetic-broker'),
  dpapiKeyAvailable:true,pendingUnknownMutation:false,
 };
}
test('stop state readback cannot claim shut down while Task Scheduler still running or UNKNOWN',()=>{
 const e=revokeFixture();
 assert.deepEqual(assessCoreStopRevokeSource(e),{
  status:'source_only_revocation_readback',commandAllowed:false,productionAccepted:false,
 });
 for(const state of ['running','unknown','ready','disabled'] as const){
  const x={...e,taskState:state} as CoreStopRevokeEvidence;
  assert.throws(()=>assessCoreStopRevokeSource(x),
    /S3_CORE_DELEGATION_TASK_STILL_RUNNING_OR_UNKNOWN/);
 }
});
test('owner revoke needs independent higher epoch, disabled/deleted task and inaccessible DPAPI key',()=>{
 const e=revokeFixture();
 assert.deepEqual(assessCoreStopRevokeSource({...e,operation:'revoke',taskState:'disabled',
  dpapiKeyAvailable:false}),{
  status:'source_only_revocation_readback',commandAllowed:false,productionAccepted:false,
 });
 for(const change of [
  {taskState:'running'},{taskState:'stopped'},{dpapiKeyAvailable:true},
 ]){
  const x={...e,operation:'revoke' as const,taskState:'disabled' as const,
   dpapiKeyAvailable:false,...change} as CoreStopRevokeEvidence;
  assert.throws(()=>assessCoreStopRevokeSource(x),
    /S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/);
 }
 for(const change of [
  {independentEpoch:13},{independentWitnessVerified:false},
  {taskReadbackVerified:false},{pendingUnknownMutation:true},
  {brokerImageHash:hash('forged-running-image')},{ownerAccountId:'!bad'},
 ]){
  const x={...e,operation:'revoke' as const,taskState:'disabled' as const,
   dpapiKeyAvailable:false,...change} as CoreStopRevokeEvidence;
  assert.throws(()=>assessCoreStopRevokeSource(x),
    /S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/);
 }
});
