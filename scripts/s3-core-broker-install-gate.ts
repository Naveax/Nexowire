/**
 * #551/#617 source-only model for an owner-authorized ONE-TIME Windows
 * elevated Broker installation.  NO installer invocation, UAC interaction,
 * service changes, or privileged command execution occurs here.
 *
 * After authorized installation a high-token protected Broker could accept
 * owner-scoped CORE requests without re-prompting UAC; that runtime and its
 * Windows-native attestation are NOT implemented or enabled by this module.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';
import {inspectSignedWindowsBinary} from './s3-windows-binary-trust.js';
import {
  assessScopedBrokerTrust,type BrokerEvidenceInput,
  type BrokerSignatureInspector,type BrokerNativeEvidence,
} from './s3-hyperv-broker-trust.js';
const HEX=/^[a-f0-9]{64}$/;
const SID=/^S-\d+(?:-\d+)+$/;
const id=/^[A-Za-z0-9_.:@-]{1,128}$/;
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const reject=(s:string):never=>{throw new Error('S3_CORE_INSTALL_'+s)};
export interface CoreInstallerSlot {
  path:string;bytes:Buffer;expectedSha256:string;version:string;
}
export interface CoreInstallNativeToken {
  // MUST be from a trusted native GetTokenInformation/OS inspector,
  // never from shell stdout, CORE mode preference or process ID alone.
  provider:'trusted-native-win32';
  tokenElevationType:'full';
  tokenIsElevated:true;
  integrityRid:number;
  adminSid:string;
  adminSidEnabled:true;
  adminSidDenyOnly:false;
  deviceId:string;
  processCreationIdentity:string;
  imageSha256:string;
  nativeImageHandleVerified:true;
}
export interface CoreLocalConsent {
  // Provenance MUST be attested by Windows-owned local session controller.
  // Presence of consent.exe, remote browser click or broker ACK != consent.
  source:'windows-local-interactive-owner';
  sessionType:'physical-console'|'authorized-windows-remote-admin-session';
  installerSha256:string;
  ownerAccountId:string;
  deviceId:string;
  sessionId:string;
  transactionId:string;
  decision:'approved'|'denied'|'pending'|'unknown';
  trustedReceiptVerified:boolean;
}
export interface CoreRevokeEvidence {
  independentlyRead:boolean;
  currentOwnerEpoch:number;
  minimumValidOwnerEpoch:number;
  revoked:boolean;
  revokedArtifactSha256?:string;
}
export interface CoreBrokerInstallGate {
  scopedBroker:BrokerEvidenceInput;
  installer:CoreInstallerSlot;
  rollback:CoreInstallerSlot;
  previousAgentVersion:string;
  previousBrokerVersion:string;
  installedBrokerVersion:string;
  pathsAclSnapshot:readonly CapturedAclNode[];
  importedFiles:readonly string[];
  token:CoreInstallNativeToken;
  localConsent:CoreLocalConsent;
  revoke:CoreRevokeEvidence;
  expectedTransactionId:string;
  interruptedInstallation:boolean;
}
export type CoreInstallerInspector=(
  kind:'installer'|'rollback',filePath:string,expectedSha256:string,
)=>Promise<BrokerNativeEvidence>;
export interface CoreBrokerInstallResult {
  status:'source_preflight_only';
  oneTimeLocalConsentEvidence:'synthetic_or_native_evidence_unaccepted';
  highTokenNativeProof:'not_physically_accepted';
  subsequentCoreUac:'no_reprompt_architecture_only';
  mayInstall:false;mayExecuteCoreAdmin:false;productionApproved:false;
}
const version=(v:string)=>typeof v==='string'&&semver.test(v)&&
  v.split('.').every(part=>Number.isSafeInteger(Number(part)));
function coveredNodes(paths:readonly string[],nodes:readonly CapturedAclNode[]):void{
  evaluateCapturedAclNodes(nodes);
  const coverage=new Set(nodes.map(n=>path.win32.normalize(n.path).toLowerCase()));
  for(const filename of paths){
    if(typeof filename!=='string'||! /^[A-Za-z]:\\/.test(filename)||
      filename.length>4096||filename.slice(2).includes(':')||
      filename.split(/[\\/]/).includes('..')||
      /[\u0000-\u001f]/.test(filename))reject('BAD_IMPORT_OR_INSTALL_PATH');
    let current=path.win32.normalize(filename);
    while(true){
      if(!coverage.has(current.toLowerCase()))reject('MISSING_PROTECTED_PARENT_OR_IMPORT');
      const parent=path.win32.dirname(current);
      if(parent===current)break;
      current=parent;
    }
  }
}
function verifyToken(t:CoreInstallNativeToken,expectedDevice:string,expectedSha:string):void{
  if(!t||t.provider!=='trusted-native-win32'||
    t.tokenElevationType!=='full'||t.tokenIsElevated!==true||
    !Number.isInteger(t.integrityRid)||t.integrityRid<0x3000||
    t.adminSid!=='S-1-5-32-544'||t.adminSidEnabled!==true||
    t.adminSidDenyOnly!==false||t.deviceId!==expectedDevice||
    t.imageSha256!==expectedSha||t.nativeImageHandleVerified!==true||
    typeof t.processCreationIdentity!=='string'||
    !/^[A-Za-z0-9_.:@-]{16,128}$/.test(t.processCreationIdentity)){
    reject('EFFECTIVE_HIGH_TOKEN_OR_PROCESS_UNVERIFIED');
  }
}
function verifyConsent(c:CoreLocalConsent,
  installerSha:string,owner:string,device:string,txn:string):void{
  if(!c||c.source!=='windows-local-interactive-owner'||
    !['physical-console','authorized-windows-remote-admin-session'].includes(c.sessionType)||
    c.installerSha256!==installerSha||
    c.ownerAccountId!==owner||c.deviceId!==device||
    c.transactionId!==txn||!id.test(c.sessionId)||
    c.decision!=='approved'||c.trustedReceiptVerified!==true){
    reject('LOCAL_OWNER_WINDOWS_CONSENT_UNVERIFIED');
  }
}
export async function assessCoreBrokerOneTimeInstall(
  input:CoreBrokerInstallGate,
  inspectBroker:BrokerSignatureInspector,
  inspectInstaller:CoreInstallerInspector,
):Promise<CoreBrokerInstallResult>{
  if(!input||typeof inspectInstaller!=='function')reject('MISSING_INSPECTOR');
  const b=input.scopedBroker;
  if(!b||!b.pins||!b.manifest||!b.enrollment)reject('MISSING_BROKER_EVIDENCE');
  // The existing #551 signed Broker/helper/updater + owner-VM signed
  // enrollment gate is necessary, but can NEVER authorize execution alone.
  await assessScopedBrokerTrust(b,inspectBroker);
  if(input.interruptedInstallation||b.interruptedInstall){
    reject('STARTUP_UNKNOWN_NO_AUTO_REPLAY');
  }
  const allPaths=[
    b.paths.broker,b.paths.helper,b.paths.updater,
    input.installer?.path,input.rollback?.path,...(input.importedFiles??[]),
  ];
  if(!Array.isArray(input.importedFiles)||input.importedFiles.length===0||
    input.importedFiles.length>256||allPaths.some(p=>typeof p!=='string')){
    reject('IMPORT_GRAPH_INCOMPLETE');
  }
  try{coveredNodes(allPaths as string[],input.pathsAclSnapshot)}
  catch{reject('PROTECTED_INSTALL_IMPORT_ACL_UNTRUSTED')}
  if(!version(input.previousAgentVersion)||
     input.previousAgentVersion!==b.pins.installedAgentVersion||
     !version(input.previousBrokerVersion)||
     !version(input.installedBrokerVersion)||
     input.installedBrokerVersion!==b.manifest.version||
     input.previousBrokerVersion===input.installedBrokerVersion||
     input.rollback.version!==input.previousBrokerVersion||
     input.installer.version!==input.installedBrokerVersion){
    reject('PRIOR_VERSION_MIGRATION_MISMATCH');
  }
  if(!id.test(input.expectedTransactionId))reject('TRANSACTION_ID_INVALID');
  if(!input.revoke?.independentlyRead||input.revoke.revoked===true||
    !Number.isSafeInteger(input.revoke.currentOwnerEpoch)||
    !Number.isSafeInteger(input.revoke.minimumValidOwnerEpoch)||
    input.revoke.currentOwnerEpoch<input.revoke.minimumValidOwnerEpoch||
    input.revoke.currentOwnerEpoch!==b.enrollment.epoch||
    (input.revoke.revokedArtifactSha256!==undefined&&
      input.revoke.revokedArtifactSha256===input.installer.expectedSha256)){
    reject('OWNER_ENROLLMENT_REVOKED_OR_STALE');
  }
  for(const [kind,slot] of [
    ['installer',input.installer],['rollback',input.rollback],
  ] as const){
    if(!Buffer.isBuffer(slot.bytes)||slot.bytes.length===0||
      !HEX.test(slot.expectedSha256)||
      digest(slot.bytes)!==slot.expectedSha256)reject('INSTALLER_OR_ROLLBACK_HASH_MISMATCH');
    let result:BrokerNativeEvidence | null = null;
    try{result=await inspectInstaller(kind,slot.path,slot.expectedSha256)}
    catch{reject('INSTALLER_SIGNATURE_INSPECTION_UNAVAILABLE')}
    if(!result?.signatureValid||result.fileSha256!==slot.expectedSha256||
       result.certificateSha256!==b.pins.trustedCertificateSha256||
       result.publisherSubject!==b.pins.trustedPublisherSubject){
      reject('INSTALLER_OR_ROLLBACK_SIGNER_UNTRUSTED');
    }
  }
  if(input.installer.expectedSha256===input.rollback.expectedSha256){
    reject('ROLLBACK_SAME_AS_INSTALLER');
  }
  verifyConsent(input.localConsent,input.installer.expectedSha256,
    b.pins.ownerAccountId,b.pins.deviceId,input.expectedTransactionId);
  verifyToken(input.token,b.pins.deviceId,b.manifest.brokerSha256);
  // An injected provider can claim all the above: no actual signed native
  // helper, protected installer process, physical UAC receipt, high token
  // or persistent authorized Broker has been deployed/physically accepted.
  return {
    status:'source_preflight_only',
    oneTimeLocalConsentEvidence:'synthetic_or_native_evidence_unaccepted',
    highTokenNativeProof:'not_physically_accepted',
    subsequentCoreUac:'no_reprompt_architecture_only',
    mayInstall:false,mayExecuteCoreAdmin:false,productionApproved:false,
  };
}


/**
 * Exact on-disk installer graph acceptance for #551/#617.
 * Statically verifies an independently pinned, ED25519 signed manifest and
 * all discovered staged files. It cannot certify future Windows loader
 * dynamic imports or execute a single privileged operation.
 */
export type CoreStageRole =
  'installer'|'broker'|'helper'|'updater'|'rollback'|'import-executable'|'import-resource';
export interface CoreStageEntry {
  role:CoreStageRole;
  path:string;
  sha256:string;
  /** Stable file ID + volume provenance is REQUIRED from a native read-only inspector. */
  volumeIdentity:string;
  fileIdentity:string;
}
export interface CoreStageManifest {
  schemaVersion:1;
  ownerAccountId:string;deviceId:string;
  transactionId:string;
  targetBrokerVersion:string;
  rollbackBrokerVersion:string;
  files:CoreStageEntry[];
}
export interface CoreStagePins {
  /** Independently distributed, never copied from the untrusted bundle. */
  manifestPublicKeyPem:string;
  manifestSha256:string;
  publisherSubject:string;
  certificateSha256:string;
  ownerAccountId:string;deviceId:string;transactionId:string;
  targetBrokerVersion:string;rollbackBrokerVersion:string;
  trustedProtectedRoot:string;
}
export interface CoreStageReadback {
  /** Entire recursively enumerated protected stage + imported files, NOT a caller-declared subset. */
  files:Array<CoreStageEntry & { bytes:Buffer; isReparsePoint:boolean }>;
  aclNodes:readonly CapturedAclNode[];
  noTraversalError:boolean;
  completeImportClosureAttested:boolean;
  source:'trusted-native-read-only-inspector'|'synthetic-fixture';
}
export interface CoreStageSignatureEvidence {
  status:'signature_verified';
  sha256:string;publisherSubject:string;certificateSha256:string;
}
export type CoreStageSignatureInspector=(
  path:string,pins:{sha256:string;publisherSubject:string;certificateSha256:string},
)=>Promise<CoreStageSignatureEvidence>;
/** Read-only OS-native Authenticode check, never a launch authorization. */
export const inspectCoreStageWindowsAuthenticode:CoreStageSignatureInspector=async (filename,p)=>{
  const evidence=inspectSignedWindowsBinary({
    filePath:filename,expectedSha256:p.sha256,
    expectedPublisherSubject:p.publisherSubject,
    expectedCertificateSha256:p.certificateSha256,
  });
  return{status:'signature_verified',sha256:evidence.fileSha256,
    publisherSubject:evidence.publisherSubject,certificateSha256:evidence.certificateSha256};
};
const CoreRoles=new Set<CoreStageRole>([
  'installer','broker','helper','updater','rollback','import-executable','import-resource',
]);
const ExecutableRoles=new Set<CoreStageRole>([
  'installer','broker','helper','updater','rollback','import-executable',
]);
const StageRequiredRoles=['installer','broker','helper','updater','rollback','import-executable'] as const;
const unique=(x:string[])=>new Set(x).size===x.length;
function stagePath(filename:string,root:string):string{
  if(typeof filename!=='string'||! /^[a-zA-Z]:\\/.test(filename)||
      filename.length>4096||filename.slice(2).includes(':')||
      /[\u0000-\u001f]/.test(filename)||filename.split(/[\\/]/).includes('..')){
    reject('STAGE_PATH_UNTRUSTED');
  }
  const full=path.win32.normalize(filename);
  if(full===root||!full.toLowerCase().startsWith(root.toLowerCase()+'\\')){
    reject('STAGE_PATH_OUTSIDE_PROTECTED_ROOT');
  }
  return full.toLowerCase();
}
function stageManifestBytes(m:CoreStageManifest):Buffer{
  if(!m||typeof m!=='object'||Array.isArray(m)||
      Object.keys(m).sort().join(',')!==
      ['schemaVersion','ownerAccountId','deviceId','transactionId',
        'targetBrokerVersion','rollbackBrokerVersion','files'].sort().join(',')||
      !Array.isArray(m.files)||m.files.length<6||m.files.length>4096){
    reject('SIGNED_STAGE_MANIFEST_INVALID');
  }
  for(const entry of m.files){
    if(!entry||typeof entry!=='object'||
        Object.keys(entry).sort().join(',')!==
        ['role','path','sha256','volumeIdentity','fileIdentity'].sort().join(',')||
        !CoreRoles.has(entry.role)||!HEX.test(entry.sha256)||
        typeof entry.volumeIdentity!=='string'||
        !/^[A-Za-z0-9:._-]{8,128}$/.test(entry.volumeIdentity)||
        typeof entry.fileIdentity!=='string'||
        !/^[A-Za-z0-9:._-]{8,128}$/.test(entry.fileIdentity)){
      reject('SIGNED_STAGE_MANIFEST_INVALID');
    }
  }
  // Canonical serialization: field ordering cannot vary with JSON parser keys.
  const canonical=(f:CoreStageEntry)=>({
    role:f.role,path:f.path,sha256:f.sha256,
    volumeIdentity:f.volumeIdentity,fileIdentity:f.fileIdentity,
  });
  return Buffer.from(JSON.stringify({
    schemaVersion:m.schemaVersion,ownerAccountId:m.ownerAccountId,
    deviceId:m.deviceId,transactionId:m.transactionId,
    targetBrokerVersion:m.targetBrokerVersion,
    rollbackBrokerVersion:m.rollbackBrokerVersion,
    files:m.files.map(canonical),
  }),'utf8');
}
export async function assessProtectedCoreInstallerStage(
  manifest:CoreStageManifest,
  signatureBase64:string,
  pins:CoreStagePins,
  readback:CoreStageReadback,
  inspect:CoreStageSignatureInspector=inspectCoreStageWindowsAuthenticode,
):Promise<{
  status:'staged_source_checked';
  actuallyInstalled:false;initialLocalUacApproved:false;
  perCommandCoreUacRequired:'depends_on_physical_broker_enrollment';
  productionApproved:false;
}>{
  if(!pins||!readback||typeof inspect!=='function'||!HEX.test(pins.manifestSha256)||
      !HEX.test(pins.certificateSha256)||
      !id.test(pins.ownerAccountId)||!id.test(pins.deviceId)||
      !id.test(pins.transactionId)||!version(pins.targetBrokerVersion)||
      !version(pins.rollbackBrokerVersion)||
      pins.targetBrokerVersion===pins.rollbackBrokerVersion||
      typeof pins.publisherSubject!=='string'||pins.publisherSubject.length<6){
    reject('STAGE_TRUST_PINS_UNAVAILABLE');
  }
  const root=path.win32.normalize(pins.trustedProtectedRoot);
  if(! /^[a-z]:\\/i.test(root)||root.slice(2).includes(':')||
      root.split(/[\\/]/).includes('..')||root.length>4096){
    reject('STAGE_ROOT_UNTRUSTED');
  }
  const bytes=stageManifestBytes(manifest);
  if(manifest.schemaVersion!==1||
      manifest.ownerAccountId!==pins.ownerAccountId||
      manifest.deviceId!==pins.deviceId||
      manifest.transactionId!==pins.transactionId||
      manifest.targetBrokerVersion!==pins.targetBrokerVersion||
      manifest.rollbackBrokerVersion!==pins.rollbackBrokerVersion||
      digest(bytes)!==pins.manifestSha256){
    reject('SIGNED_STAGE_POLICY_MISMATCH');
  }
  let verifyingKey:ReturnType<typeof createPublicKey>|null=null;
  try{verifyingKey=createPublicKey(pins.manifestPublicKeyPem)}
  catch{reject('SIGNED_STAGE_TRUST_KEY_INVALID')}
  if(!verifyingKey||verifyingKey.asymmetricKeyType!=='ed25519'||
      typeof signatureBase64!=='string'||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)){
    reject('SIGNED_STAGE_SIGNATURE_INVALID');
  }
  const signature=Buffer.from(signatureBase64,'base64');
  if(signature.length!==64||
      signature.toString('base64')!==signatureBase64||
      !verify(null,bytes,verifyingKey!,signature)){
    reject('SIGNED_STAGE_SIGNATURE_INVALID');
  }
  const entries=manifest.files;
  const names=entries.map(e=>stagePath(e.path,root));
  if(!unique(names)||!unique(entries.map(e=>e.volumeIdentity+':'+e.fileIdentity))){
    reject('SIGNED_STAGE_ALIAS_OR_HARDLINK');
  }
  for(const role of StageRequiredRoles){
    const count=entries.filter(e=>e.role===role).length;
    if(count<1||(role!=='import-executable'&&count!==1)){
      reject('SIGNED_STAGE_ROLE_MISSING_OR_DUPLICATE');
    }
  }
  if(!readback.noTraversalError||!readback.completeImportClosureAttested||
      !Array.isArray(readback.files)||readback.files.length!==entries.length){
    reject('STAGED_INVENTORY_NOT_COMPLETE');
  }
  const disk=new Map(readback.files.map(f=>[stagePath(f.path,root),f]));
  if(disk.size!==entries.length){
    reject('STAGED_INVENTORY_DUPLICATE');
  }
  for(const f of entries){
    const actual=disk.get(stagePath(f.path,root));
    if(!actual||actual.role!==f.role||actual.sha256!==f.sha256||
        actual.volumeIdentity!==f.volumeIdentity||
        actual.fileIdentity!==f.fileIdentity||
        !Buffer.isBuffer(actual.bytes)||actual.bytes.length===0||
        actual.isReparsePoint!==false||digest(actual.bytes)!==f.sha256){
      reject('STAGED_HANDLE_OR_BYTES_CHANGED');
    }
  }
  try{coveredNodes([root,...entries.map(f=>f.path)],readback.aclNodes)}
  catch{reject('STAGED_PROTECTED_ACL_INVALID')}
  // A valid target/rollback SHA256 is insufficient without an independently
  // pinned Authenticode Subject and actual signing certificate per executable.
  for(const f of entries){
    if(!ExecutableRoles.has(f.role))continue;
    let ev:CoreStageSignatureEvidence|null=null;
    try{ev=await inspect(f.path,{sha256:f.sha256,
      publisherSubject:pins.publisherSubject,
      certificateSha256:pins.certificateSha256})}
    catch{reject('STAGED_AUTHENTICODE_UNAVAILABLE')}
    if(!ev||ev.status!=='signature_verified'||ev.sha256!==f.sha256||
        ev.publisherSubject!==pins.publisherSubject||
        ev.certificateSha256!==pins.certificateSha256){
      reject('STAGED_AUTHENTICODE_UNTRUSTED');
    }
  }
  // Source snapshot may be stale before launch. A native elevated installer,
  // trusted OS-owned consent receipt, protected-handle atomic cutover,
  // DPAPI/TaskScheduler high-token proof and crash recovery are still absent.
  return{
    status:'staged_source_checked',
    actuallyInstalled:false,initialLocalUacApproved:false,
    perCommandCoreUacRequired:'depends_on_physical_broker_enrollment',
    productionApproved:false,
  };
}
