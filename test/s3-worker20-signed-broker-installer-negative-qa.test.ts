/**
 * Worker #20: independent hostile source fixtures for #551 / #632 / #271.
 * No Win32 API, UAC, task registration, DPAPI unseal, installation or disk I/O.
 * Passing here NEVER verifies a physical signed Broker or permits deployment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {assessCoreBrokerOneTimeInstall,type CoreBrokerInstallGate,
  type CoreInstallerInspector} from '../scripts/s3-core-broker-install-gate.js';
import {assessCoreInstalledBrokerSource,assessCoreStopRevokeSource,
  type CoreBootstrapEvidence,type CoreStopRevokeEvidence}
  from '../scripts/s3-core-bootstrap-delegation-audit.js';
import {evaluateCapturedAclNodes,type CapturedAclNode}
  from '../scripts/s3-windows-acl-preflight.js';
import type {BrokerSignatureInspector,BrokerManifest,OwnerEnrollment}
  from '../scripts/s3-hyperv-broker-trust.js';

const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const manifestKey=generateKeyPairSync('ed25519');
const enrollmentKey=generateKeyPairSync('ed25519');
const bootstrapKey=generateKeyPairSync('ed25519');
const commandKey=generateKeyPairSync('ed25519');
const maliciousKey=generateKeyPairSync('ed25519');
const pub=(k:typeof manifestKey)=>k.publicKey.export({format:'pem',type:'spki'}).toString();
const cert=hash('out-of-band-fixture-certificate');
const publisher='CN=PINNED-NEXOWIRE-FIXTURE';
const owner='owner-w20',device='device-w20';
const dir='C:\\ProtectedFixture\\Nexowire';
const manifestFields=['schemaVersion','role','version','minAgentVersion','maxAgentVersion',
 'minHubVersion','maxHubVersion','publisher','brokerSha256','helperSha256','updaterSha256'];
const enrollmentFields=['schemaVersion','ownerAccountId','deviceId','vmId','brokerVersion',
 'epoch','expiresAtUnix'];
const bootstrapFields=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch',
 'transactionId','brokerVersion','brokerSha256','installerSha256','updaterSha256',
 'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandFields=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
 'requestId','capability','inputSha256','sequence'];
const sig=(value:object,keys:readonly string[],key:typeof manifestKey)=>{
 const rec=value as Record<string,unknown>;
 const data=Buffer.from(JSON.stringify(Object.fromEntries(keys.map(k=>[k,rec[k]]))));
 return sign(null,data,key.privateKey).toString('base64');
};
function protectedAcl(...files:string[]):CapturedAclNode[]{
 const found=new Set<string>();
 for(let file of files){
  while(true){found.add(file);const parent=path.win32.dirname(file);
   if(parent===file)break;file=parent;}
 }
 return [...found].map(name=>({
  path:name,ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[
   {principalSid:'S-1-5-18',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-544',kind:'Allow' as const,inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-545',kind:'Allow' as const,inherited:true,fileSystemRights:0x1200a9},
  ],
 }));
}
const unsafeAllow=(sid='S-1-5-11')=>({
 principalSid:sid,kind:'Allow' as const,inherited:true,fileSystemRights:0x1301bf,
});
const binaryInspector:BrokerSignatureInspector=async(_,__,sha)=>({
 fileSha256:sha,publisherSubject:publisher,certificateSha256:cert,signatureValid:true,
});
const installerInspector:CoreInstallerInspector=async(_,__,sha)=>({
 fileSha256:sha,publisherSubject:publisher,certificateSha256:cert,signatureValid:true,
});
function installFixture():CoreBrokerInstallGate{
 const binaries={broker:Buffer.from('w20-fixture-broker'),
  helper:Buffer.from('w20-fixture-helper'),updater:Buffer.from('w20-fixture-updater')};
 const vmId='1c111111-2222-4333-8444-555555555555';
 const manifest:BrokerManifest={schemaVersion:1,role:'nexowire-scoped-hyperv-broker',
  version:'1.0.5',minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
  minHubVersion:'1.0.5',maxHubVersion:'1.0.6',publisher,
  brokerSha256:hash(binaries.broker),helperSha256:hash(binaries.helper),
  updaterSha256:hash(binaries.updater)};
 const enrollment:OwnerEnrollment={schemaVersion:1,ownerAccountId:owner,deviceId:device,
  vmId,brokerVersion:'1.0.5',epoch:20,expiresAtUnix:1800001000};
 const paths={broker:dir+'\\runtime\\broker.exe',
  helper:dir+'\\helper\\native-helper.exe',updater:dir+'\\updater\\updater.exe'};
 const mkSlot=(name:string,version:string)=>({
  path:dir+'\\'+name+'\\'+name+'.exe',
  bytes:Buffer.from('synthetic-'+name),expectedSha256:hash('synthetic-'+name),version,
 });
 const installer=mkSlot('installer','1.0.5'),rollback=mkSlot('rollback','1.0.4');
 const importedFiles=[dir+'\\runtime\\native.dll',dir+'\\updater\\imported.dll',
  dir+'\\runtime\\config.json'];
 return {
  scopedBroker:{
   manifest,manifestSignature:sig(manifest,manifestFields,manifestKey),
   enrollment,enrollmentSignature:sig(enrollment,enrollmentFields,enrollmentKey),
   pins:{trustedManifestPublicKeyPem:pub(manifestKey),
    trustedEnrollmentPublicKeyPem:pub(enrollmentKey),
    trustedPublisherSubject:publisher,trustedCertificateSha256:cert,
    ownerAccountId:owner,deviceId:device,vmId,
    installedAgentVersion:'1.0.5',installedHubVersion:'1.0.5',
    brokerVersion:'1.0.5',minIndependentEnrollmentEpoch:19,nowUnix:1800000000},
   binaries,paths,aclNodes:protectedAcl(...Object.values(paths)),
   running:{runningImageSha256:manifest.brokerSha256,
    creationIdentity:'trusted-process-identity-w20',deviceId:device,
    brokerVersion:'1.0.5',nativeImageHandleVerified:true,authenticatedHealth:true},
  },
  installer,rollback,previousAgentVersion:'1.0.5',
  previousBrokerVersion:'1.0.4',installedBrokerVersion:'1.0.5',
  importedFiles,pathsAclSnapshot:protectedAcl(...Object.values(paths),
   installer.path,rollback.path,...importedFiles),
  token:{provider:'trusted-native-win32',tokenElevationType:'full',tokenIsElevated:true,
   integrityRid:0x3000,adminSid:'S-1-5-32-544',adminSidEnabled:true,
   adminSidDenyOnly:false,deviceId:device,
   processCreationIdentity:'trusted-process-identity-w20',
   imageSha256:manifest.brokerSha256,nativeImageHandleVerified:true},
  localConsent:{source:'windows-local-interactive-owner',sessionType:'physical-console',
   installerSha256:installer.expectedSha256,ownerAccountId:owner,
   deviceId:device,sessionId:'fixture-session-w20',transactionId:'fixture-install-w20',
   decision:'approved',trustedReceiptVerified:true},
  revoke:{independentlyRead:true,currentOwnerEpoch:20,minimumValidOwnerEpoch:19,
   revoked:false},expectedTransactionId:'fixture-install-w20',
  interruptedInstallation:false,
 };
}
function bootstrapFixture():CoreBootstrapEvidence{
 const broker=dir+'\\runtime\\broker.exe';
 const updater=dir+'\\updater\\updater.exe';
 const dll=dir+'\\runtime\\owner-native.dll';
 const blob=dir+'\\owner\\dpapi.bin';
 const brokerSha=hash('broker-w20'),installerSha=hash('installer-w20');
 const updaterSha=hash('updater-w20'),blobSha=hash('blob-w20');
 const transactionId='enrollment-w20';
 const record={schemaVersion:1 as const,role:'core-elevated-broker-bootstrap' as const,
  ownerAccountId:owner,deviceId:device,ownerEpoch:30,transactionId,
  brokerVersion:'1.0.5',brokerSha256:brokerSha,installerSha256:installerSha,
  updaterSha256:updaterSha,dpapiBlobSha256:blobSha,
  taskName:'\\Nexowire\\PrivilegedBroker',approvedAtUnix:2000};
 const command={schemaVersion:1 as const,ownerAccountId:owner,deviceId:device,
  ownerEpoch:30,requestId:'request-w20',capability:'core.admin.command' as const,
  inputSha256:hash('command-w20'),sequence:31};
 return {
  record,recordSignature:sig(record,bootstrapFields,bootstrapKey),
  pins:{ownerPublicKeyPem:pub(bootstrapKey),commandPublicKeyPem:pub(commandKey),
   ownerAccountId:owner,deviceId:device,minimumOwnerEpoch:30,
   transactionId,brokerVersion:'1.0.5',brokerSha256:brokerSha,
   installerSha256:installerSha,updaterSha256:updaterSha,dpapiBlobSha256:blobSha,
   nowUnix:2001,minimumIndependentCommandSequence:30,
   trustedPublisherSubject:publisher,trustedSignerCertificateSha256:cert},
  physicalConsent:{provider:'windows-local-owner-os',sessionType:'physical-console',
   ownerAccountId:owner,deviceId:device,transactionId,
   approvedInstallerSha256:installerSha,signedEnrollmentVerified:true,
   decision:'approved',remoteUiApprovalOnly:false},
  task:{provider:'trusted-windows-task-scheduler',
   taskName:'\\Nexowire\\PrivilegedBroker',taskState:'running',taskRunLevel:'highest',
   logonType:'service-account',principalSid:'S-1-5-18',ownerDeviceId:device,
   actionPath:broker,actionSha256:brokerSha,brokerPublisherSubject:publisher,
   brokerCertificateSha256:cert,effectiveTokenProvider:'trusted-win32-token',
   tokenIsElevated:true,integrityRid:0x3000,administratorsEnabled:true,
   administratorsDenyOnly:false,nativeRunningImageHandle:true,
   runningImageSha256:brokerSha,processCreationIdentity:'native-identity-w20-0001',
   taskRegistrationIdentityVerified:true},
  ownerKey:{provider:'windows-dpapi-native',protectionScope:'current-user',
   protectingSid:'S-1-5-18',blobOwnerSid:'S-1-5-18',
   blobPath:blob,blobSha256:blobSha,boundOwnerAccountId:owner,
   boundDeviceId:device,boundBrokerSha256:brokerSha,independentEpoch:30,
   unsealedInProtectedBroker:true,exportableToMediumCaller:false},
  recovery:{oldBrokerVersion:'1.0.4',oldBrokerSha256:hash('old-broker-w20'),
   oldRollbackSignatureVerified:true,oldRollbackProtected:true,
   externalJournalVerified:true,pendingUnknownMutation:false,
   currentInstalledImageSha256:brokerSha},
  protectedImportPaths:[broker,updater,dll],
  aclNodes:protectedAcl(broker,updater,dll,blob),
  command,commandSignature:sig(command,commandFields,commandKey),revoked:false,
 };
}
const install=async(fx:CoreBrokerInstallGate,
 inspect:CoreInstallerInspector=installerInspector)=>
 assessCoreBrokerOneTimeInstall(fx,binaryInspector,inspect);
async function deniedInstall(change:(e:CoreBrokerInstallGate)=>void,re:RegExp){
 const e=installFixture();change(e);await assert.rejects(install(e),re);
}
function deniedBootstrap(change:(e:CoreBootstrapEvidence)=>void,re:RegExp){
 const e=bootstrapFixture();change(e);
 assert.throws(()=>assessCoreInstalledBrokerSource(e),re);
}

test('w20: apparently valid isolated fixtures can never authorize install or CORE command',async()=>{
 const i=await install(installFixture());
 assert.equal(i.mayInstall,false);
 assert.equal(i.mayExecuteCoreAdmin,false);
 assert.equal(i.productionApproved,false);
 const b=assessCoreInstalledBrokerSource(bootstrapFixture());
 assert.equal(b.elevatedCommandMayExecute,false);
 assert.equal(b.productionAccepted,false);
 assert.match(b.initialUac,/one_local_os_approval/);
});
test('w20: exact pinned publisher AND certificate required for installer and signed old rollback',async()=>{
 for(const slot of ['installer','rollback'] as const){
  for(const kind of ['other-cert','same-subject-invalid-signature','other-publisher'] as const){
   const e=installFixture();
   const attack:CoreInstallerInspector=async(name,p,sha)=>{
    const original=await installerInspector(name,p,sha);
    if(name!==slot)return original;
    return kind==='other-cert'?{...original,certificateSha256:hash('other-cert')}:
     kind==='same-subject-invalid-signature'?{...original,signatureValid:false}:
     {...original,publisherSubject:'CN=OTHER-SIGNER'};
   };
   await assert.rejects(install(e,attack),/S3_CORE_INSTALL_INSTALLER_OR_ROLLBACK_SIGNER_UNTRUSTED/);
  }
  await deniedInstall(e=>{e[slot].bytes=Buffer.from('replacement');},
   /S3_CORE_INSTALL_INSTALLER_OR_ROLLBACK_HASH_MISMATCH/);
 }
});
test('w20: signed manifest/owner enrollment replay or attacker signing key cannot replace pinned authority',async()=>{
 const foreign=pub(maliciousKey);
 await deniedInstall(e=>{e.scopedBroker.pins.trustedManifestPublicKeyPem=foreign},
  /S3_/);
 await deniedInstall(e=>{e.scopedBroker.pins.trustedEnrollmentPublicKeyPem=foreign},
  /S3_/);
 await deniedInstall(e=>{e.scopedBroker.enrollment.deviceId='foreign-device'},
  /S3_/);
});
test('w20: protected ancestor and updater/import ACL rejects inherited writer even alongside Deny',async()=>{
 for(const file of [dir,dir+'\\updater\\updater.exe',
  dir+'\\runtime\\native.dll',dir+'\\rollback\\rollback.exe']){
  await deniedInstall(e=>{e.pathsAclSnapshot=e.pathsAclSnapshot.map(n=>n.path===file?
   {...n,entries:[...n.entries,
    {principalSid:'S-1-5-11',kind:'Deny',inherited:false,fileSystemRights:0x1301bf},
    unsafeAllow()]}:n);},
   /S3_CORE_INSTALL_PROTECTED_INSTALL_IMPORT_ACL_UNTRUSTED/);
 }
 for(const file of [dir,dir+'\\owner\\dpapi.bin',dir+'\\updater\\updater.exe']){
  deniedBootstrap(e=>{e.aclNodes=e.aclNodes.map(n=>n.path===file?
   {...n,entries:[...n.entries,unsafeAllow('S-1-1-0')]}:n);},
   /S3_CORE_DELEGATION_ACL_INSECURE/);
 }
});
test('w20: reparse/import graph omissions and alternate drive paths cannot inherit false protection',async()=>{
 await deniedInstall(e=>{e.importedFiles=['D:\\Unlisted\\evil.dll']},
  /S3_CORE_INSTALL_PROTECTED_INSTALL_IMPORT_ACL_UNTRUSTED/);
 await deniedInstall(e=>{e.pathsAclSnapshot=e.pathsAclSnapshot.map(n=>
  n.path===dir+'\\runtime\\native.dll'?{...n,isReparsePoint:true}:n)},
  /S3_CORE_INSTALL_PROTECTED_INSTALL_IMPORT_ACL_UNTRUSTED/);
 deniedBootstrap(e=>{e.protectedImportPaths.push('D:\\Unknown\\payload.dll')},
  /S3_CORE_DELEGATION_ACL_MISSING_PARENT_OR_IMPORT/);
 deniedBootstrap(e=>{e.aclNodes=e.aclNodes.filter(n=>n.path!==dir)},
  /S3_CORE_DELEGATION_ACL_MISSING_PARENT_OR_IMPORT/);
});
test('w20: SYSTEM high integrity and image-handle requirement fail closed on token laundering',async()=>{
 for(const mutation of [
  {principalSid:'S-1-5-32-544'},{integrityRid:0x2000},
  {administratorsDenyOnly:true},{administratorsEnabled:false},
  {tokenIsElevated:false},{nativeRunningImageHandle:false},
  {taskRegistrationIdentityVerified:false},
  {brokerCertificateSha256:hash('spoofed-cert')},
  {processCreationIdentity:'PID-10'},
 ]){
  deniedBootstrap(e=>Object.assign(e.task,mutation),
   /S3_CORE_DELEGATION_EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID/);
 }
 await deniedInstall(e=>{e.token.adminSidDenyOnly=true},
  /S3_CORE_INSTALL_EFFECTIVE_HIGH_TOKEN_OR_PROCESS_UNVERIFIED/);
 await deniedInstall(e=>{e.token.nativeImageHandleVerified=false},
  /S3_CORE_INSTALL_EFFECTIVE_HIGH_TOKEN_OR_PROCESS_UNVERIFIED/);
});
test('w20: DPAPI key is bound to protected SYSTEM identity and owner/device/epoch',()=>{
 for(const mutation of [
  {protectionScope:'local-machine'},{protectingSid:'S-1-5-11'},
  {blobOwnerSid:'S-1-5-32-545'},{exportableToMediumCaller:true},
  {unsealedInProtectedBroker:false},{boundDeviceId:'stale-device'},
  {boundOwnerAccountId:'stale-owner'},{independentEpoch:29},
  {boundBrokerSha256:hash('replacement-broker')},
 ]){
  deniedBootstrap(e=>Object.assign(e.ownerKey,mutation),
   /S3_CORE_DELEGATION_DPAPI_OWNER_KEY_BOUNDARY_INVALID/);
 }
});
test('w20: one local UAC enrollment cannot be fabricated from remote click/consent.exe status',async()=>{
 for(const mutation of [
  {source:'remote-browser'},{decision:'unknown'},{trustedReceiptVerified:false},
  {transactionId:'different-txn'},{installerSha256:hash('foreign-installer')},
 ]){
  await deniedInstall(e=>Object.assign(e.localConsent,mutation),
   /S3_CORE_INSTALL_LOCAL_OWNER_WINDOWS_CONSENT_UNVERIFIED/);
 }
 for(const mutation of [
  {provider:'browser-ui'},{decision:'pending'},{remoteUiApprovalOnly:true},
  {signedEnrollmentVerified:false},{approvedInstallerSha256:hash('changed')},
 ]){
  deniedBootstrap(e=>Object.assign(e.physicalConsent,mutation),
   /S3_CORE_DELEGATION_LOCAL_OS_CONSENT_NOT_ATTESTED/);
 }
});
test('w20: revoked CORE/epoch replay and forged command signature deny without UAC-reprompt fallback',async()=>{
 await deniedInstall(e=>{e.revoke.revoked=true},
  /S3_CORE_INSTALL_OWNER_ENROLLMENT_REVOKED_OR_STALE/);
 await deniedInstall(e=>{e.interruptedInstallation=true},
  /S3_CORE_INSTALL_STARTUP_UNKNOWN_NO_AUTO_REPLAY/);
 deniedBootstrap(e=>{e.revoked=true},/S3_CORE_DELEGATION_OWNER_GRANT_REVOKED/);
 deniedBootstrap(e=>{e.command.sequence=29},/S3_CORE_DELEGATION_DELEGATED_COMMAND_INVALID/);
 deniedBootstrap(e=>{e.command.ownerEpoch=29},/S3_CORE_DELEGATION_DELEGATED_COMMAND_INVALID/);
 deniedBootstrap(e=>{e.commandSignature=sig(e.command,commandFields,maliciousKey)},
  /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
 deniedBootstrap(e=>{e.pins.commandPublicKeyPem=pub(maliciousKey)},
  /S3_CORE_DELEGATION_SIGNATURE_INVALID/);
});
test('w20: rollback fail/UNKNOWN journal cannot claim signed recovery or replay',()=>{
 for(const change of [
  {oldRollbackSignatureVerified:false},{oldRollbackProtected:false},
  {externalJournalVerified:false},{pendingUnknownMutation:true},
  {currentInstalledImageSha256:hash('stale-running-binary')},
 ]){
  deniedBootstrap(e=>Object.assign(e.recovery,change),
   /S3_CORE_DELEGATION_ROLLBACK_OR_RECOVERY_UNTRUSTED/);
 }
});
test('w20: revoked CORE demands independent epoch and inaccessible owner key readback',()=>{
 const good:CoreStopRevokeEvidence={operation:'revoke',ownerAccountId:owner,deviceId:device,
  independentEpoch:32,priorEpoch:31,independentWitnessVerified:true,
  taskState:'disabled',taskReadbackVerified:true,
  brokerImageHash:hash('broker-w20'),expectedBrokerImageHash:hash('broker-w20'),
  dpapiKeyAvailable:false,pendingUnknownMutation:false};
 assert.equal(assessCoreStopRevokeSource(good).commandAllowed,false);
 for(const [mutation,re] of [
  [{independentEpoch:31},/S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/],
  [{independentWitnessVerified:false},/S3_CORE_DELEGATION_REVOKE_OR_STOP_UNVERIFIED/],
  [{taskState:'running'},/S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/],
  [{dpapiKeyAvailable:true},/S3_CORE_DELEGATION_REVOKED_BROKER_OR_KEY_STILL_ACTIVE/],
 ] as const){
  assert.throws(()=>assessCoreStopRevokeSource({...good,...mutation} as CoreStopRevokeEvidence),re);
 }
});
test('w20: raw ACL fixture never equals trusted Windows effective ACL or deployment proof',()=>{
 const nodes=protectedAcl(dir+'\\runtime\\broker.exe');
 const result=evaluateCapturedAclNodes(nodes);
 assert.equal(result.executionSafe,false);
 assert.equal(result.productionApproved,false);
 const bad=nodes.map(n=>n.path===dir?
  {...n,entries:[...n.entries,unsafeAllow()]}:n);
 assert.throws(()=>evaluateCapturedAclNodes(bad),/S3_ACL_UNTRUSTED_WRITER/);
});
