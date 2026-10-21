import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import path from 'node:path';
import {
  assessCoreBrokerOneTimeInstall,
  type CoreBrokerInstallGate,type CoreInstallerInspector,
} from '../scripts/s3-core-broker-install-gate.js';
import type {BrokerSignatureInspector,BrokerManifest,OwnerEnrollment} from '../scripts/s3-hyperv-broker-trust.js';
import type {CapturedAclNode} from '../scripts/s3-windows-acl-preflight.js';

const sigKey=generateKeyPairSync('ed25519');
const ownerKey=generateKeyPairSync('ed25519');
const SHA=(x:Buffer)=>createHash('sha256').update(x).digest('hex');
const CERT='e'.repeat(64);
const PUB='CN=Fixture Nexowire Broker';
const VM='bbfe85b2-ed70-46dc-aa0a-df496a508c0b';
const bk=['schemaVersion','role','version','minAgentVersion','maxAgentVersion',
 'minHubVersion','maxHubVersion','publisher','brokerSha256','helperSha256','updaterSha256'];
const ek=['schemaVersion','ownerAccountId','deviceId','vmId','brokerVersion','epoch','expiresAtUnix'];
const signer=(v:object,fields:string[],privateKey=sigKey.privateKey)=>{
 const t=v as Record<string,unknown>;
 return sign(null,Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k=>[k,t[k]])))),
   privateKey).toString('base64');
};
function acl(...p:string[]):CapturedAclNode[]{
 const paths=new Set<string>();
 for(let pathname of p){
  while(true){
   paths.add(pathname);
   const parent=path.win32.dirname(pathname);
   if(parent===pathname)break;
   pathname=parent;
  }
 }
 return [...paths].map(filename=>({
  path:filename,ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[{principalSid:'S-1-5-18',kind:'Allow' as const,
    inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-544',kind:'Allow' as const,
    inherited:true,fileSystemRights:0x1f01ff},
   {principalSid:'S-1-5-32-545',kind:'Allow' as const,
    inherited:true,fileSystemRights:0x1200a9}],
 }));
}
function fixture(){
 const binaries={broker:Buffer.from('BROKER_FIXTURE'),helper:Buffer.from('HYPERV_HELPER_FIXTURE'),
  updater:Buffer.from('UPDATER_FIXTURE')};
 const m:BrokerManifest={
  schemaVersion:1,role:'nexowire-scoped-hyperv-broker',version:'1.0.5',
  minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
  minHubVersion:'1.0.5',maxHubVersion:'1.0.6',publisher:PUB,
  brokerSha256:SHA(binaries.broker),
  helperSha256:SHA(binaries.helper),updaterSha256:SHA(binaries.updater),
 };
 const enrollment:OwnerEnrollment={
  schemaVersion:1,ownerAccountId:'owner-one',deviceId:'workpc-test',
  vmId:VM,brokerVersion:'1.0.5',epoch:7,expiresAtUnix:1800000100,
 };
 const folder='C:\\ProtectedFixture\\Nexowire';
 const paths={
  broker:folder+'\\runtime\\broker.exe',helper:folder+'\\helper\\hyperv-helper.exe',
  updater:folder+'\\updater\\updater.exe',
 };
 const installer={path:folder+'\\installer\\installer.exe',bytes:Buffer.from('INSTALLER_FIXTURE'),
  expectedSha256:'',version:'1.0.5'};
 installer.expectedSha256=SHA(installer.bytes);
 const rollback={path:folder+'\\rollback\\rollback.exe',bytes:Buffer.from('ROLLBACK_FIXTURE'),
  expectedSha256:'',version:'1.0.4'};
 rollback.expectedSha256=SHA(rollback.bytes);
 const importedFiles=[
  folder+'\\runtime\\native-ffi.dll',folder+'\\runtime\\policy.json',
  folder+'\\updater\\windows-update-bridge.dll',
 ];
 const gate:CoreBrokerInstallGate={
  scopedBroker:{
   manifest:m,manifestSignature:signer(m,bk),
   enrollment,enrollmentSignature:signer(enrollment,ek,ownerKey.privateKey),
   pins:{
    trustedManifestPublicKeyPem:sigKey.publicKey.export({type:'spki',format:'pem'}).toString(),
    trustedEnrollmentPublicKeyPem:ownerKey.publicKey.export({type:'spki',format:'pem'}).toString(),
    trustedPublisherSubject:PUB,trustedCertificateSha256:CERT,
    ownerAccountId:'owner-one',deviceId:'workpc-test',vmId:VM,
    installedAgentVersion:'1.0.5',installedHubVersion:'1.0.5',brokerVersion:'1.0.5',
    minIndependentEnrollmentEpoch:6,nowUnix:1800000000,
   },
   binaries,paths,aclNodes:acl(...Object.values(paths)),
   running:{
    runningImageSha256:m.brokerSha256,
    creationIdentity:'trusted-process-creation-01',deviceId:'workpc-test',
    brokerVersion:'1.0.5',nativeImageHandleVerified:true,
    authenticatedHealth:true,
   },
  },
  installer,rollback,previousAgentVersion:'1.0.5',
  previousBrokerVersion:'1.0.4',installedBrokerVersion:'1.0.5',
  importedFiles,pathsAclSnapshot:acl(...Object.values(paths),
    installer.path,rollback.path,...importedFiles),
  token:{
   provider:'trusted-native-win32',tokenElevationType:'full',
   tokenIsElevated:true,integrityRid:0x3000,
   adminSid:'S-1-5-32-544',adminSidEnabled:true,adminSidDenyOnly:false,
   deviceId:'workpc-test',processCreationIdentity:'trusted-process-creation-01',
   imageSha256:m.brokerSha256,nativeImageHandleVerified:true,
  },
  localConsent:{
   source:'windows-local-interactive-owner',sessionType:'physical-console',
   installerSha256:installer.expectedSha256,ownerAccountId:'owner-one',
   deviceId:'workpc-test',sessionId:'local-session-001',
   transactionId:'install-txn-001',decision:'approved',trustedReceiptVerified:true,
  },
  revoke:{
   independentlyRead:true,currentOwnerEpoch:7,minimumValidOwnerEpoch:6,revoked:false,
  },
  expectedTransactionId:'install-txn-001',interruptedInstallation:false,
 };
 const brokerInspector:BrokerSignatureInspector=async(_,__,sha)=>({
  fileSha256:sha,publisherSubject:PUB,certificateSha256:CERT,signatureValid:true,
 });
 const installerInspector:CoreInstallerInspector=async(_,__,sha)=>({
  fileSha256:sha,publisherSubject:PUB,certificateSha256:CERT,signatureValid:true,
 });
 return {gate,brokerInspector,installerInspector};
}
async function denied(
 alter:(g:CoreBrokerInstallGate)=>void,pattern:RegExp
){
 const {gate,brokerInspector,installerInspector}=fixture();
 alter(gate);
 await assert.rejects(
  assessCoreBrokerOneTimeInstall(gate,brokerInspector,installerInspector),pattern);
}
test('one-time owner-UAC then high-token Broker is architecture only, not enabled by fixture',async()=>{
 for(const sessionType of ['physical-console','authorized-windows-remote-admin-session'] as const){
  const {gate,brokerInspector,installerInspector}=fixture();
  gate.localConsent.sessionType=sessionType;
  const result=await assessCoreBrokerOneTimeInstall(gate,brokerInspector,installerInspector);
  assert.deepEqual(result,{
   status:'source_preflight_only',
   oneTimeLocalConsentEvidence:'synthetic_or_native_evidence_unaccepted',
   highTokenNativeProof:'not_physically_accepted',
   subsequentCoreUac:'no_reprompt_architecture_only',
   mayInstall:false,mayExecuteCoreAdmin:false,productionApproved:false,
  });
 }
});
test('Medium token, deny-only Administrators, no actual image proof reject CORE elevation',async()=>{
 for(const change of [
  {integrityRid:0x2000},{tokenElevationType:'limited'},
  {tokenIsElevated:false},{adminSidEnabled:false},{adminSidDenyOnly:true},
  {adminSid:'S-1-5-32-545'},{imageSha256:'a'.repeat(64)},
  {nativeImageHandleVerified:false},{processCreationIdentity:'PID-5'},
  {deviceId:'other-device'},{provider:'shell-stdout'},
 ]){
  await denied(g=>Object.assign(g.token,change),
   /S3_CORE_INSTALL_EFFECTIVE_HIGH_TOKEN_OR_PROCESS_UNVERIFIED/);
 }
});
test('remote claim, consent.exe presence or remote secure-desktop click cannot prove Windows UAC',async()=>{
 for(const change of [
  {trustedReceiptVerified:false},{source:'remote-ui'},
  {source:'consent.exe-seen'},{source:'secure-desktop-auto-click'},
  {decision:'unknown'},{decision:'pending'},{decision:'denied'},
  {installerSha256:'f'.repeat(64)},{ownerAccountId:'foreign-owner'},
  {deviceId:'wrong-device'},{transactionId:'wrong-install'},
  {sessionType:'untrusted-remote-browser'},
 ]){
  await denied(g=>Object.assign(g.localConsent,change),
   /S3_CORE_INSTALL_LOCAL_OWNER_WINDOWS_CONSENT_UNVERIFIED/);
 }
});
test('protected parent, updater, imports and reparse cannot be skipped by installer staging',async()=>{
 for(const mode of ['missingParent','missingImport','missingUpdater','writableParent','reparse','badOwner'] as const){
  await denied(g=>{
   if(mode==='missingParent')g.pathsAclSnapshot=g.pathsAclSnapshot.filter(n=>n.path!=='C:\\ProtectedFixture');
   if(mode==='missingImport')g.pathsAclSnapshot=g.pathsAclSnapshot.filter(n=>n.path!==g.importedFiles[0]);
   if(mode==='missingUpdater')g.pathsAclSnapshot=g.pathsAclSnapshot.filter(n=>n.path!==g.scopedBroker.paths.updater);
   if(mode==='writableParent')g.pathsAclSnapshot=g.pathsAclSnapshot.map(n=>
    n.path==='C:\\ProtectedFixture'?{...n,entries:[...n.entries,{
     principalSid:'S-1-5-11',kind:'Allow' as const,
     inherited:true,fileSystemRights:0x1301bf,
    }]}:n);
   if(mode==='reparse')g.pathsAclSnapshot=g.pathsAclSnapshot.map(n=>
    n.path===g.importedFiles[1]?{...n,isReparsePoint:true}:n);
   if(mode==='badOwner')g.pathsAclSnapshot=g.pathsAclSnapshot.map(n=>
    n.path===g.rollback.path?{...n,ownerSid:'S-1-5-21-123-456-789-1000'}:n);
  },/S3_CORE_INSTALL_PROTECTED_INSTALL_IMPORT_ACL_UNTRUSTED/);
 }
});
test('unsigned/replaced new helper installer OR old rollback staging fail closed',async()=>{
 for(const which of ['installer','rollback'] as const){
  for(const failure of ['bytes','signature','subject','certificate'] as const){
   const {gate,brokerInspector,installerInspector}=fixture();
   if(failure==='bytes'){
    gate[which].bytes=Buffer.from('ATTACKER_REPLACEMENT');
    await assert.rejects(assessCoreBrokerOneTimeInstall(gate,brokerInspector,installerInspector),
     /S3_CORE_INSTALL_INSTALLER_OR_ROLLBACK_HASH_MISMATCH/);
   }else{
    const inspect:CoreInstallerInspector=async(k,p,h)=>{
     const correct=await installerInspector(k,p,h);
     if(k!==which)return correct;
     if(failure==='signature')return {...correct,signatureValid:false};
     if(failure==='subject')return {...correct,publisherSubject:'CN=Foreign'};
     return {...correct,certificateSha256:'a'.repeat(64)};
    };
    await assert.rejects(assessCoreBrokerOneTimeInstall(gate,brokerInspector,inspect),
     /S3_CORE_INSTALL_INSTALLER_OR_ROLLBACK_SIGNER_UNTRUSTED/);
   }
  }
 }
});
test('prior Agent migration version skew or replay and same rollback target are denied',async()=>{
 for(const change of [
  {previousAgentVersion:'1.0.4'},{previousBrokerVersion:'1.0.3'},
  {installedBrokerVersion:'1.0.4'},
 ]){
  await denied(g=>Object.assign(g,change),
   /S3_CORE_INSTALL_PRIOR_VERSION_MIGRATION_MISMATCH/);
 }
 await denied(g=>{g.rollback.version='1.0.6';},
  /S3_CORE_INSTALL_PRIOR_VERSION_MIGRATION_MISMATCH/);
 await denied(g=>{g.installer.version='1.0.4';},
  /S3_CORE_INSTALL_PRIOR_VERSION_MIGRATION_MISMATCH/);
});
test('revocation, stale independent epoch and interrupted staging never perform auto replay',async()=>{
 for(const change of [
  {revoked:true},{independentlyRead:false},
  {currentOwnerEpoch:5},{minimumValidOwnerEpoch:8},{currentOwnerEpoch:8},
 ]){
  await denied(g=>Object.assign(g.revoke,change),
   /S3_CORE_INSTALL_OWNER_ENROLLMENT_REVOKED_OR_STALE/);
 }
 await denied(g=>{g.revoke.revokedArtifactSha256=g.installer.expectedSha256;},
  /S3_CORE_INSTALL_OWNER_ENROLLMENT_REVOKED_OR_STALE/);
 await denied(g=>{g.interruptedInstallation=true;},
  /S3_CORE_INSTALL_STARTUP_UNKNOWN_NO_AUTO_REPLAY/);
});
