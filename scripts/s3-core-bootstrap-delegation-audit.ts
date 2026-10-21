/**
 * #551 child of S3 CORE source acceptance. DOES NOT execute a Windows task,
 * install a Broker, unseal DPAPI secrets, elevate or interact with UAC.
 * All native attestations are injected evidence. Even good fixtures are
 * NOT evidence of a physically installed first-party signed Broker.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';
import {assessProtectedCoreInstallerStage,
  type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
  type CoreStageSignatureInspector,
} from './s3-core-broker-install-gate.js';

const H=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_.:@-]{1,128}$/;
const keys=['schemaVersion','role','ownerAccountId','deviceId','ownerEpoch','transactionId',
  'brokerVersion','brokerSha256','installerSha256','updaterSha256',
  'dpapiBlobSha256','taskName','approvedAtUnix'];
const commandKeys=['schemaVersion','ownerAccountId','deviceId','ownerEpoch',
  'requestId','capability','inputSha256','sequence'];
const taskName='\\Nexowire\\PrivilegedBroker';
function refuse(reason:string):never{throw new Error('S3_CORE_DELEGATION_'+reason)}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function canon(value:object,fields:readonly string[]):Buffer{
  if(!value||Array.isArray(value)||
     Object.keys(value).sort().join(',')!==[...fields].sort().join(',')){
    refuse('SIGNED_FIELDS_INVALID');
  }
  const data=value as Record<string,unknown>;
  return Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k=>[k,data[k]]))),'utf8');
}
function detached(message:Buffer,signature:string,keyPem:string):void{
  let key;
  try{key=createPublicKey(keyPem)}catch{refuse('TRUST_KEY_INVALID')}
  if(key.asymmetricKeyType!=='ed25519')refuse('TRUST_KEY_INVALID');
  if(typeof signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(signature))refuse('SIGNATURE_INVALID');
  const bytes=Buffer.from(signature,'base64');
  if(bytes.length!==64||bytes.toString('base64')!==signature||
     !verify(null,message,key,bytes))refuse('SIGNATURE_INVALID');
}
export interface CoreBootstrapRecord{
  schemaVersion:1;
  role:'core-elevated-broker-bootstrap';
  ownerAccountId:string;deviceId:string;ownerEpoch:number;
  transactionId:string;brokerVersion:string;
  brokerSha256:string;installerSha256:string;updaterSha256:string;
  dpapiBlobSha256:string;taskName:string;approvedAtUnix:number;
}
export interface CoreBootstrapCommand {
  schemaVersion:1;ownerAccountId:string;deviceId:string;ownerEpoch:number;
  requestId:string;capability:'core.admin.command';inputSha256:string;sequence:number;
}
export interface CoreBootstrapPins{
  /** These are provisioned OUT OF BAND, never taken from the release. */
  ownerPublicKeyPem:string;commandPublicKeyPem:string;
  ownerAccountId:string;deviceId:string;minimumOwnerEpoch:number;
  transactionId:string;brokerVersion:string;
  brokerSha256:string;installerSha256:string;updaterSha256:string;
  dpapiBlobSha256:string;nowUnix:number;minimumIndependentCommandSequence:number;
  trustedPublisherSubject:string;trustedSignerCertificateSha256:string;
}
export interface CorePhysicalConsentEvidence{
  provider:'windows-local-owner-os';
  sessionType:'physical-console'|'authorized-remote-admin';
  ownerAccountId:string;deviceId:string;transactionId:string;
  approvedInstallerSha256:string;
  signedEnrollmentVerified:boolean;
  decision:'approved'|'denied'|'pending'|'unknown';
  remoteUiApprovalOnly:false;
}
export interface CoreTaskNativeEvidence{
  provider:'trusted-windows-task-scheduler';
  taskName:string;taskState:'running'|'ready'|'disabled'|'unknown';
  taskRunLevel:'highest';logonType:'service-account';
  principalSid:string;ownerDeviceId:string;
  actionPath:string;actionSha256:string;
  brokerPublisherSubject:string;brokerCertificateSha256:string;
  effectiveTokenProvider:'trusted-win32-token';
  tokenIsElevated:boolean;integrityRid:number;
  administratorsEnabled:boolean;administratorsDenyOnly:boolean;
  nativeRunningImageHandle:boolean;runningImageSha256:string;
  processCreationIdentity:string;
  taskRegistrationIdentityVerified:boolean;
}
export interface CoreDpapiOwnerKeyEvidence{
  provider:'windows-dpapi-native';
  protectionScope:'current-user';
  protectingSid:string;blobOwnerSid:string;
  blobPath:string;blobSha256:string;
  boundOwnerAccountId:string;boundDeviceId:string;
  boundBrokerSha256:string;independentEpoch:number;
  unsealedInProtectedBroker:boolean;
  exportableToMediumCaller:boolean;
}
export interface CoreBootstrapRecoveryEvidence{
  oldBrokerVersion:string;oldBrokerSha256:string;
  oldRollbackSignatureVerified:boolean;
  oldRollbackProtected:boolean;
  externalJournalVerified:boolean;
  pendingUnknownMutation:boolean;
  currentInstalledImageSha256:string;
}
export interface CoreBootstrapEvidence {
  record:CoreBootstrapRecord;recordSignature:string;pins:CoreBootstrapPins;
  physicalConsent:CorePhysicalConsentEvidence;
  task:CoreTaskNativeEvidence;
  ownerKey:CoreDpapiOwnerKeyEvidence;
  recovery:CoreBootstrapRecoveryEvidence;
  protectedImportPaths:readonly string[];
  aclNodes:readonly CapturedAclNode[];
  /** Signed owner request, not a remotely asserted browser permission. */
  command:CoreBootstrapCommand;
  commandSignature:string;
  revoked:boolean;
}
export type SourceResult={
  status:'source_only_not_deployed';
  initialUac:'one_local_os_approval_required_for_actual_install';
  perCommandUac:'not_required_only_after_real_broker_acceptance';
  elevatedCommandMayExecute:false;productionAccepted:false;
};
function protectedPaths(list:readonly string[],nodes:readonly CapturedAclNode[]):void{
  if(!Array.isArray(list)||list.length<4||list.length>256)refuse('IMPORT_INVENTORY_MISSING');
  try{evaluateCapturedAclNodes(nodes)}catch{refuse('ACL_INSECURE')}
  const known=new Set(nodes.map(n=>path.win32.normalize(n.path).toLowerCase()));
  for(const filename of list){
    if(typeof filename!=='string'||! /^[a-z]:\\/i.test(filename)||
       filename.slice(2).includes(':')||filename.split(/[\\/]/).includes('..')||
       /[\u0000-\u001f]/.test(filename)||filename.length>4096){
      refuse('PATH_INVALID');
    }
    let cursor=path.win32.normalize(filename);
    while(true){
      if(!known.has(cursor.toLowerCase()))refuse('ACL_MISSING_PARENT_OR_IMPORT');
      const parent=path.win32.dirname(cursor);
      if(parent===cursor)break;
      cursor=parent;
    }
  }
}
export function assessCoreInstalledBrokerSource(input:CoreBootstrapEvidence):SourceResult{
  if(!input||!input.pins||!input.record||!input.command)refuse('MISSING_EVIDENCE');
  const {record:r,pins:p,command:c,task:t,ownerKey:k,recovery:v,physicalConsent:consent}=input;
  if(!ID.test(p.ownerAccountId)||!ID.test(p.deviceId)||
    ![p.brokerSha256,p.installerSha256,p.updaterSha256,p.dpapiBlobSha256,
      p.trustedSignerCertificateSha256].every(h=>H.test(h))||
    !Number.isSafeInteger(p.minimumOwnerEpoch)||p.minimumOwnerEpoch<0||
    !Number.isSafeInteger(p.nowUnix)||
    !Number.isSafeInteger(p.minimumIndependentCommandSequence)||
    p.minimumIndependentCommandSequence<1)refuse('INDEPENDENT_PINS_INVALID');
  if(r.schemaVersion!==1||r.role!=='core-elevated-broker-bootstrap'||
    r.ownerAccountId!==p.ownerAccountId||r.deviceId!==p.deviceId||
    r.transactionId!==p.transactionId||r.taskName!==taskName||
    r.brokerVersion!==p.brokerVersion||
    r.brokerSha256!==p.brokerSha256||r.installerSha256!==p.installerSha256||
    r.updaterSha256!==p.updaterSha256||r.dpapiBlobSha256!==p.dpapiBlobSha256||
    !Number.isSafeInteger(r.ownerEpoch)||r.ownerEpoch<p.minimumOwnerEpoch||
    !Number.isSafeInteger(r.approvedAtUnix)||r.approvedAtUnix>p.nowUnix||
    r.approvedAtUnix<0)refuse('OWNER_BOOTSTRAP_SCOPE_INVALID');
  detached(canon(r,keys),input.recordSignature,p.ownerPublicKeyPem);
  if(!consent||consent.provider!=='windows-local-owner-os'||
    !['physical-console','authorized-remote-admin'].includes(consent.sessionType)||
    consent.decision!=='approved'||consent.signedEnrollmentVerified!==true||
    consent.remoteUiApprovalOnly!==false||
    consent.ownerAccountId!==p.ownerAccountId||consent.deviceId!==p.deviceId||
    consent.transactionId!==p.transactionId||
    consent.approvedInstallerSha256!==p.installerSha256)refuse('LOCAL_OS_CONSENT_NOT_ATTESTED');
  if(!t||t.provider!=='trusted-windows-task-scheduler'||t.taskName!==taskName||
    t.taskState!=='running'||t.taskRunLevel!=='highest'||
    t.logonType!=='service-account'||t.principalSid!=='S-1-5-18'||
    t.ownerDeviceId!==p.deviceId||
    t.actionSha256!==p.brokerSha256||
    t.brokerPublisherSubject!==p.trustedPublisherSubject||
    t.brokerCertificateSha256!==p.trustedSignerCertificateSha256||
    t.effectiveTokenProvider!=='trusted-win32-token'||t.tokenIsElevated!==true||
    !Number.isSafeInteger(t.integrityRid)||t.integrityRid<0x3000||
    t.administratorsEnabled!==true||t.administratorsDenyOnly!==false||
    t.nativeRunningImageHandle!==true||t.runningImageSha256!==p.brokerSha256||
    t.taskRegistrationIdentityVerified!==true||
    typeof t.processCreationIdentity!=='string'||
    !/^[A-Za-z0-9_.:@-]{16,128}$/.test(t.processCreationIdentity)){
    refuse('EFFECTIVE_TASK_OR_HIGH_TOKEN_INVALID');
  }
  if(!k||k.provider!=='windows-dpapi-native'||k.protectionScope!=='current-user'||
    k.protectingSid!=='S-1-5-18'||k.blobOwnerSid!=='S-1-5-18'||
    k.blobSha256!==p.dpapiBlobSha256||
    k.boundOwnerAccountId!==p.ownerAccountId||k.boundDeviceId!==p.deviceId||
    k.boundBrokerSha256!==p.brokerSha256||
    k.independentEpoch!==r.ownerEpoch||
    k.unsealedInProtectedBroker!==true||k.exportableToMediumCaller!==false){
    refuse('DPAPI_OWNER_KEY_BOUNDARY_INVALID');
  }
  if(!v||v.oldBrokerVersion===p.brokerVersion||
    !H.test(v.oldBrokerSha256)||v.oldBrokerSha256===p.brokerSha256||
    v.oldRollbackSignatureVerified!==true||v.oldRollbackProtected!==true||
    v.externalJournalVerified!==true||v.pendingUnknownMutation!==false||
    v.currentInstalledImageSha256!==p.brokerSha256)refuse('ROLLBACK_OR_RECOVERY_UNTRUSTED');
  protectedPaths([t.actionPath,k.blobPath,...input.protectedImportPaths],input.aclNodes);
  if(!Array.isArray(input.protectedImportPaths)||input.protectedImportPaths.length<2||
    !input.protectedImportPaths.includes(t.actionPath)||
    !input.protectedImportPaths.some(f=>f.toLowerCase().includes('updater'))){
    refuse('UPDATER_OR_IMPORT_INVENTORY_MISSING');
  }
  if(input.revoked===true)refuse('OWNER_GRANT_REVOKED');
  if(c.schemaVersion!==1||c.capability!=='core.admin.command'||
    c.ownerAccountId!==p.ownerAccountId||c.deviceId!==p.deviceId||
    c.ownerEpoch!==r.ownerEpoch||!ID.test(c.requestId)||
    !H.test(c.inputSha256)||
    !Number.isSafeInteger(c.sequence)||c.sequence<p.minimumIndependentCommandSequence){
    refuse('DELEGATED_COMMAND_INVALID');
  }
  detached(canon(c,commandKeys),input.commandSignature,p.commandPublicKeyPem);
  // All native inspectors and owner signatures can be faked in fixture tests.
  // An actual protected signed installer, independent epoch authority, local
  // Windows approval and native task/image attestations remain NOT deployed.
  return {
    status:'source_only_not_deployed',
    initialUac:'one_local_os_approval_required_for_actual_install',
    perCommandUac:'not_required_only_after_real_broker_acceptance',
    elevatedCommandMayExecute:false,productionAccepted:false,
  };
}
export interface CoreStopRevokeEvidence{
  operation:'stop'|'revoke';
  ownerAccountId:string;deviceId:string;
  independentEpoch:number;priorEpoch:number;
  independentWitnessVerified:boolean;
  taskState:'running'|'stopped'|'disabled'|'deleted'|'unknown';
  taskReadbackVerified:boolean;
  brokerImageHash:string;expectedBrokerImageHash:string;
  dpapiKeyAvailable:boolean;
  pendingUnknownMutation:boolean;
}
export function assessCoreStopRevokeSource(e:CoreStopRevokeEvidence):{
  status:'source_only_revocation_readback';
  commandAllowed:false;productionAccepted:false;
}{
  if(!e||!ID.test(e.ownerAccountId)||!ID.test(e.deviceId)||
    !Number.isSafeInteger(e.independentEpoch)||!Number.isSafeInteger(e.priorEpoch)||
    e.independentEpoch<=e.priorEpoch||e.independentWitnessVerified!==true||
    e.taskReadbackVerified!==true||e.pendingUnknownMutation!==false||
    !H.test(e.expectedBrokerImageHash)||e.brokerImageHash!==e.expectedBrokerImageHash){
    refuse('REVOKE_OR_STOP_UNVERIFIED');
  }
  if(e.operation==='stop'){
    if(e.taskState!=='stopped')refuse('TASK_STILL_RUNNING_OR_UNKNOWN');
  }else if(e.operation==='revoke'){
    if(!['disabled','deleted'].includes(e.taskState)||e.dpapiKeyAvailable!==false){
      refuse('REVOKED_BROKER_OR_KEY_STILL_ACTIVE');
    }
  }else refuse('UNKNOWN_LIFECYCLE_OPERATION');
  return{status:'source_only_revocation_readback',commandAllowed:false,productionAccepted:false};
}


/**
 * Cross-links the pinned installer/rollback/import staging graph with the
 * signed owner enrollment, actual Task Scheduler action and DPAPI owner.
 * This avoids two individually valid but DIFFERENT security snapshots being
 * accidentally combined into a purported "installed CORE" approval.
 */
export async function assessCoreLinkedStageAndDelegation(
  bootstrap:CoreBootstrapEvidence,
  stage:CoreStageManifest,stageSignature:string,
  stagePins:CoreStagePins,stageReadback:CoreStageReadback,
  inspect:CoreStageSignatureInspector,
):Promise<SourceResult>{
  await assessProtectedCoreInstallerStage(
    stage,stageSignature,stagePins,stageReadback,inspect);
  const roles=['installer','broker','helper','updater','rollback'] as const;
  const byRole=new Map(roles.map(role=>[
    role,stage.files.find(f=>f.role===role),
  ] as const));
  if(roles.some(role=>!byRole.get(role))){
    refuse('CROSS_STAGE_REQUIRED_ROLE_MISSING');
  }
  const broker=byRole.get('broker')!;
  const installer=byRole.get('installer')!;
  const updater=byRole.get('updater')!;
  const rollback=byRole.get('rollback')!;
  const b=bootstrap;
  if(!b||!b.task||!b.record||!b.pins||!b.ownerKey||!b.physicalConsent||!b.recovery||
    stage.ownerAccountId!==b.pins.ownerAccountId||
    stage.deviceId!==b.pins.deviceId||
    stage.transactionId!==b.pins.transactionId||
    stage.targetBrokerVersion!==b.record.brokerVersion||
    stage.rollbackBrokerVersion!==b.recovery.oldBrokerVersion||
    stagePins.ownerAccountId!==b.pins.ownerAccountId||
    stagePins.deviceId!==b.pins.deviceId||
    stagePins.transactionId!==b.pins.transactionId||
    stagePins.publisherSubject!==b.pins.trustedPublisherSubject||
    stagePins.certificateSha256!==b.pins.trustedSignerCertificateSha256||
    b.task.actionPath.toLowerCase()!==broker.path.toLowerCase()||
    b.task.actionSha256!==broker.sha256||
    b.task.runningImageSha256!==broker.sha256||
    b.record.brokerSha256!==broker.sha256||
    b.record.updaterSha256!==updater.sha256||
    b.record.installerSha256!==installer.sha256||
    b.physicalConsent.approvedInstallerSha256!==installer.sha256||
    b.recovery.oldBrokerSha256!==rollback.sha256||
    b.ownerKey.boundBrokerSha256!==broker.sha256){
    refuse('CROSS_STAGE_TASK_OWNER_DPAPI_BINDING_MISMATCH');
  }
  for(const imported of stage.files.filter(f=>
    f.role==='import-executable'||f.role==='import-resource')){
    if(!b.protectedImportPaths.some(p=>p.toLowerCase()===imported.path.toLowerCase())){
      refuse('CROSS_STAGE_IMPORT_GRAPH_NOT_BOUND_TO_TASK');
    }
  }
  return assessCoreInstalledBrokerSource(b);
}
