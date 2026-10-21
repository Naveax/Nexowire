/**
 * #551/#617 source-only model for an owner-authorized ONE-TIME Windows
 * elevated Broker installation.  NO installer invocation, UAC interaction,
 * service changes, or privileged command execution occurs here.
 *
 * After authorized installation a high-token protected Broker could accept
 * owner-scoped CORE requests without re-prompting UAC; that runtime and its
 * Windows-native attestation are NOT implemented or enabled by this module.
 */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';
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
