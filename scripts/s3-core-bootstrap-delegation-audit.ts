/**
 * #551 child of S3 CORE source acceptance. DOES NOT execute a Windows task,
 * install a Broker, unseal DPAPI secrets, elevate or interact with UAC.
 * All native attestations are injected evidence. Even good fixtures are
 * NOT evidence of a physically installed first-party signed Broker.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import path from 'node:path';
import {evaluateCapturedAclNodes,type CapturedAclNode} from './s3-windows-acl-preflight.js';
import {assessProtectedCoreInstallerStage,assessCoreSignedWindowsImportDag,
  type CoreStageManifest,type CoreStagePins,type CoreStageReadback,
  type CoreStageSignatureInspector,type CoreSignedImportDag,
  type CoreImportDagPins,type CoreNativeImportDagReadback,
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


/**
 * Single new owner-approved Windows bootstrap after an OFFLINE revoke/re-pair.
 * No service registration or DPAPI unseal. Authoritative external-CAS and
 * native Windows facts are still NOT implemented in this source adapter.
 */
export interface CoreOfflineRePairWitness {
  provider:'independent-monotonic-owner-witness';
  previousOwnerAccountId:string;
  deviceId:string;
  previousTransactionId:string;
  previousOwnerEpoch:number;
  previousDpapiBlobSha256:string;
  previousBrokerSha256:string;
  previousBrokerVersion:string;
  previousTaskState:'disabled'|'deleted'|'stopped'|'running'|'unknown';
  previousTaskReadbackVerified:boolean;
  previousDpapiKeyUnusable:boolean;
  previousOwnerRevoked:boolean;
  externalNewOwnerEpoch:number;
  externalReadbackVerified:boolean;
  externalRevokeCommitted:boolean;
  pendingUnknownMutation:boolean;
  priorRollbackSignatureVerified:boolean;
  previousSignedJournalVerified:boolean;
}
export async function assessCoreOfflineRePairBootstrap(
  bootstrap:CoreBootstrapEvidence,
  stage:CoreStageManifest,stageSignature:string,
  stagePins:CoreStagePins,stageReadback:CoreStageReadback,
  dag:CoreSignedImportDag,dagSignature:string,
  dagPins:CoreImportDagPins,nativeDag:CoreNativeImportDagReadback,
  w:CoreOfflineRePairWitness,
  inspect:CoreStageSignatureInspector,
):Promise<{
  status:'offline_repair_source_gate_only';
  newOwnerUacApprovedByThisModule:false;
  perCoreCommandUacRequired:'not_after_physically_accepted_broker';
  canInstall:false;canExecuteElevated:false;productionAccepted:false;
}>{
  await assessCoreSignedWindowsImportDag(stage,stageSignature,stagePins,
    stageReadback,dag,dagSignature,dagPins,nativeDag,inspect);
  await assessCoreLinkedStageAndDelegation(bootstrap,stage,stageSignature,
    stagePins,stageReadback,inspect);
  const b=bootstrap;
  const old=stage.files.find(f=>f.role==='rollback');
  const newKey=b.ownerKey.blobSha256;
  if(!w||w.provider!=='independent-monotonic-owner-witness'||
    !old||w.deviceId!==b.pins.deviceId||
    !Number.isSafeInteger(w.previousOwnerEpoch)||
    !Number.isSafeInteger(w.externalNewOwnerEpoch)||
    w.externalNewOwnerEpoch<=w.previousOwnerEpoch||
    w.externalNewOwnerEpoch!==b.record.ownerEpoch||
    w.previousTransactionId===b.record.transactionId||
    w.previousDpapiBlobSha256===newKey||
    w.previousBrokerSha256!==old.sha256||
    w.previousBrokerVersion!==stage.rollbackBrokerVersion||
    w.previousTaskReadbackVerified!==true||
    !['disabled','deleted'].includes(w.previousTaskState)||
    w.previousDpapiKeyUnusable!==true||
    w.previousOwnerRevoked!==true||
    w.externalReadbackVerified!==true||
    w.externalRevokeCommitted!==true||
    w.pendingUnknownMutation!==false||
    w.priorRollbackSignatureVerified!==true||
    w.previousSignedJournalVerified!==true||
    !/^[A-Za-z0-9_.:@-]{1,128}$/.test(w.previousOwnerAccountId)){
    refuse('OFFLINE_REPAIR_REVOKE_OR_DPAPI_EPOCH_UNTRUSTED');
  }
  // Re-pairing reuses NO previous UAC grant. The separate new owner
  // local Windows consent is checked in assessCoreLinkedStageAndDelegation,
  // where it must match the NEW transaction and installer hash.
  // This source module does not and cannot attest real physical consent.
  return{
    status:'offline_repair_source_gate_only',
    newOwnerUacApprovedByThisModule:false,
    perCoreCommandUacRequired:'not_after_physically_accepted_broker',
    canInstall:false,canExecuteElevated:false,productionAccepted:false,
  };
}


/** Read-only, source-level post-cutover reconciliation, NOT an installer. */
export interface CoreAtomicIdentity {
  sha256:string;
  volumeIdentity:string;
  fileIdentity:string;
}
export interface CoreAtomicSwitchEvidence {
  provider:'trusted-native-win32-read-only'|'synthetic-fixture';
  phase:'preflight'|'reserved'|'write-dispatched-unknown'|'post-cutover-readback'|
    'rollback-dispatched-unknown'|'rollback-readback';
  transactionId:string;
  ownerAccountId:string;deviceId:string;ownerEpoch:number;
  externalSequence:number;minimumIndependentSequence:number;
  writeAheadJournalDurable:boolean;
  journalAuthenticatedByExternalAuthority:boolean;
  noPendingUnknownNativeMutation:boolean;
  postconditionWitnessVerified:boolean;
  beforeInstalled:CoreAtomicIdentity;
  stagedTarget:CoreAtomicIdentity;
  installedAfterCutover:CoreAtomicIdentity;
  previousRollbackBefore:CoreAtomicIdentity;
  previousRollbackAfter:CoreAtomicIdentity;
  postUpdater:CoreAtomicIdentity;
  nativePostImportGraphVerified:boolean;
  nativePostProtectedAclVerified:boolean;
  nativePostSignerVerified:boolean;
  nativeTaskImageHandleVerified:boolean;
  nativeTaskCreationIdentity:string;
  localWindowsConsentTransactionId:string;
}
const isCoreIdentity=(i:CoreAtomicIdentity):boolean=>
  !!i&&/^[a-f0-9]{64}$/.test(i.sha256)&&
  /^[A-Za-z0-9:._-]{8,128}$/.test(i.fileIdentity)&&
  /^[A-Za-z0-9:._-]{8,128}$/.test(i.volumeIdentity);
/**
 * Offline re-pair MUST clear stale DPAPI and task grants before atomic
 * image reconciliation. Even a complete synthetic success is NOT evidence
 * that a Windows task was installed or a high token acquired.
 */
export async function assessCoreAtomicRollbackSwitchSource(
  bootstrap:CoreBootstrapEvidence,
  stage:CoreStageManifest,stageSignature:string,
  stagePins:CoreStagePins,stageReadback:CoreStageReadback,
  dag:CoreSignedImportDag,dagSignature:string,
  dagPins:CoreImportDagPins,nativeDag:CoreNativeImportDagReadback,
  previous:CoreOfflineRePairWitness,
  evidence:CoreAtomicSwitchEvidence,
  inspect:CoreStageSignatureInspector,
):Promise<{
  status:'atomic_switch_source_readback_only';
  physicalSwitchAccepted:false;
  realWindowsUacEnrolled:false;
  canResume:false;canRollbackAutomatically:false;
  canDispatchCore:false;productionApproved:false;
}>{
  await assessCoreOfflineRePairBootstrap(
    bootstrap,stage,stageSignature,stagePins,stageReadback,
    dag,dagSignature,dagPins,nativeDag,previous,inspect);
  const broker=stage.files.find(f=>f.role==='broker');
  const rollback=stage.files.find(f=>f.role==='rollback');
  const updater=stage.files.find(f=>f.role==='updater');
  const b=bootstrap;
  const e=evidence;
  if(!broker||!rollback||!updater||!e||
    !['synthetic-fixture','trusted-native-win32-read-only'].includes(e.provider)||
    e.phase!=='post-cutover-readback'||
    e.transactionId!==b.record.transactionId||
    e.ownerAccountId!==b.record.ownerAccountId||
    e.deviceId!==b.record.deviceId||
    e.ownerEpoch!==b.record.ownerEpoch||
    !Number.isSafeInteger(e.externalSequence)||
    !Number.isSafeInteger(e.minimumIndependentSequence)||
    e.minimumIndependentSequence<1||
    e.externalSequence<e.minimumIndependentSequence||
    e.writeAheadJournalDurable!==true||
    e.journalAuthenticatedByExternalAuthority!==true||
    e.noPendingUnknownNativeMutation!==true||
    e.postconditionWitnessVerified!==true||
    e.nativePostImportGraphVerified!==true||
    e.nativePostProtectedAclVerified!==true||
    e.nativePostSignerVerified!==true||
    e.nativeTaskImageHandleVerified!==true||
    e.nativeTaskCreationIdentity!==b.task.processCreationIdentity||
    e.localWindowsConsentTransactionId!==b.physicalConsent.transactionId){
    refuse('ATOMIC_SWITCH_MUTATION_UNKNOWN_OR_UNATTESTED');
  }
  if(![
    e.beforeInstalled,e.stagedTarget,e.installedAfterCutover,
    e.previousRollbackBefore,e.previousRollbackAfter,e.postUpdater,
  ].every(isCoreIdentity))refuse('ATOMIC_SWITCH_IDENTITY_INVALID');
  if(e.beforeInstalled.sha256!==rollback.sha256||
    e.beforeInstalled.fileIdentity===e.installedAfterCutover.fileIdentity||
    e.beforeInstalled.volumeIdentity!==e.installedAfterCutover.volumeIdentity||
    e.stagedTarget.sha256!==broker.sha256||
    e.stagedTarget.fileIdentity!==broker.fileIdentity||
    e.stagedTarget.volumeIdentity!==broker.volumeIdentity||
    e.installedAfterCutover.sha256!==broker.sha256||
    e.installedAfterCutover.volumeIdentity!==broker.volumeIdentity||
    e.installedAfterCutover.fileIdentity!==broker.fileIdentity||
    e.previousRollbackBefore.sha256!==rollback.sha256||
    e.previousRollbackBefore.volumeIdentity!==rollback.volumeIdentity||
    e.previousRollbackBefore.fileIdentity!==rollback.fileIdentity||
    e.previousRollbackAfter.sha256!==rollback.sha256||
    e.previousRollbackAfter.volumeIdentity!==rollback.volumeIdentity||
    e.previousRollbackAfter.fileIdentity!==rollback.fileIdentity||
    e.postUpdater.sha256!==updater.sha256||
    e.postUpdater.volumeIdentity!==updater.volumeIdentity||
    e.postUpdater.fileIdentity!==updater.fileIdentity){
    refuse('ATOMIC_SWITCH_ROLLBACK_OR_POSTIMAGE_IDENTITY_CHANGED');
  }
  // Local/remote readbacks are possible to forge in a source fixture.
  // No actual Windows UAC owner consent, elevation, or atomic filesystem
  // transaction occurred here; side-effect replay remains disallowed.
  return{
    status:'atomic_switch_source_readback_only',
    physicalSwitchAccepted:false,realWindowsUacEnrolled:false,
    canResume:false,canRollbackAutomatically:false,
    canDispatchCore:false,productionApproved:false,
  };
}


/**
 * #709 native ACL v2 + #712 signed dispatch-permit fence interoperability.
 * These are injected READ-ONLY SOURCE records. Their shape is not proof that
 * a protected Windows Broker or real external CAS authority was deployed.
 */
export interface CoreNativeAclV2Entry {
  path:string;
  evidenceAvailable:boolean;
  broadLowTrustWriteFound:boolean;
  reparsePointDetected:boolean;
}
export interface CoreNativeAclV2Evidence {
  kind:'windows_core_broker_protected_tree_readonly_v2';
  requestEnvelopeVersion:1;
  protectedRoot:string;
  acceptedInputPaths:string[];
  inspectedFilesCount:number;
  inspectedEntries:CoreNativeAclV2Entry[];
  inputsInsideRoot:boolean;
  rejectedOutOfRootPaths:string[];
  allInspectedPathsHaveAclEvidence:boolean;
  anyInspectedPathUnsafe:boolean;
  importListIndependentlyEnumerated:false;
  signedImportManifestVerified:false;
  protectedCompleteImageTreeAttested:false;
  productionReady:false;
  elevatedCoreDispatchEnabled:false;
}
/** Mirrors #712 scope attributes, without claiming the actual CAS is deployed. */
export interface CoreInstallerDispatchPermit {
  // Source v2 is intentionally incompatible with v1 (no signed DAG/DPAPI).
  schemaVersion:2;
  kind:'core_installer_dispatch_permit_source_v2';
  ownerAccountId:string;
  deviceId:string;
  transactionId:string;
  ownerEpoch:number;
  grantGeneration:number;
  challengeNonce:string;
  brokerSha256:string;
  stageManifestSha256:string;
  signedImportDagSha256:string;
  rollbackSha256:string;
  dpapiBlobSha256:string;
  processCreationIdentity:string;
  externalSequence:number;
}
export interface CoreInstallerDispatchPins {
  /** Independently pinned authority key + expected nonce supplied per invocation. */
  authorityPublicKeyPem:string;
  ownerAccountId:string;
  deviceId:string;
  ownerEpoch:number;
  grantGeneration:number;
  expectedChallengeNonce:string;
  independentlyPinnedStageManifestSha256:string;
  independentlyPinnedImportDagSha256:string;
  minimumExternalSequence:number;
}
export interface CoreInstallerPermitWitness {
  signedPermit:CoreInstallerDispatchPermit;
  signatureBase64:string;
  independentlyAuthenticated:true;
  singleUseReserved:true;
  revoked:false;
  unknownMutation:false;
}
const permitFields=['schemaVersion','kind','ownerAccountId','deviceId',
  'transactionId','ownerEpoch','grantGeneration','challengeNonce',
  'brokerSha256','stageManifestSha256','signedImportDagSha256',
  'rollbackSha256','dpapiBlobSha256','processCreationIdentity',
  'externalSequence'] as const;
const aclKey=(s:string)=>path.win32.normalize(s).toLowerCase();
export function assessCoreNativeAclAndDispatchSource(
  stage:CoreStageManifest,
  stagePins:CoreStagePins,
  dagPins:CoreImportDagPins,
  bootstrap:CoreBootstrapEvidence,
  atomic:CoreAtomicSwitchEvidence,
  acl:CoreNativeAclV2Evidence,
  pins:CoreInstallerDispatchPins,
  witness:CoreInstallerPermitWitness,
):{
  status:'native_acl_and_permit_source_only';
  nativeHighTokenAttested:false;
  ownerOsConsentPhysicallyConfirmed:false;
  executionApproved:false;productionApproved:false;
}{
  if(!stage?.files||!bootstrap?.ownerKey||!atomic||
    !stagePins?.trustedProtectedRoot||!dagPins||!pins||
    !H.test(stagePins.manifestSha256)||
    !H.test(dagPins.independentGraphSha256)||
    stagePins.ownerAccountId!==bootstrap.record.ownerAccountId||
    stagePins.deviceId!==bootstrap.record.deviceId||
    stagePins.transactionId!==bootstrap.record.transactionId||
    stagePins.manifestSha256!==pins.independentlyPinnedStageManifestSha256||
    dagPins.independentGraphSha256!==pins.independentlyPinnedImportDagSha256){
    refuse('SIGNED_IMPORT_RELEASE_SCOPE_MISMATCH');
  }
  // #743's native ACL inspection is useful only for the EXACT root pinned
  // by the separately signed stage, never a different subtree report.
  const trustedRoot=aclKey(stagePins.trustedProtectedRoot).replace(/\\+$/,'');
  const underRoot=(p:string)=>aclKey(p).startsWith(trustedRoot+'\\');
  if(!/^[a-z]:\\/i.test(trustedRoot)||
    aclKey(acl?.protectedRoot??'').replace(/\\+$/,'')!==trustedRoot||
    !stage.files.every(f=>underRoot(f.path))||
    !underRoot(bootstrap.ownerKey.blobPath)){
    refuse('NATIVE_ACL_V2_SIGNED_ROOT_MISMATCH');
  }
  if(!acl||acl.kind!=='windows_core_broker_protected_tree_readonly_v2'||
    acl.requestEnvelopeVersion!==1||
    acl.inputsInsideRoot!==true||acl.rejectedOutOfRootPaths?.length!==0||
    acl.allInspectedPathsHaveAclEvidence!==true||
    acl.anyInspectedPathUnsafe!==false||
    acl.importListIndependentlyEnumerated!==false||
    acl.signedImportManifestVerified!==false||
    acl.protectedCompleteImageTreeAttested!==false||
    acl.productionReady!==false||acl.elevatedCoreDispatchEnabled!==false||
    !Array.isArray(acl.inspectedEntries)||
    !Array.isArray(acl.acceptedInputPaths)||
    !Number.isSafeInteger(acl.inspectedFilesCount)||
    acl.inspectedFilesCount<stage.files.length||
    !stage.files.every(f=>acl.acceptedInputPaths.some(p=>
      aclKey(p)===aclKey(f.path)))){
    refuse('NATIVE_ACL_V2_INCOMPLETE_OR_UNSAFE');
  }
  // Bind the exact signed imported files and *every* Windows ancestor to
  // the native provider's inspected evidence. A path-name-only v1 report
  // or a non-existent 8.3 alias cannot silently inherit a protected ACL.
  const required=new Set<string>();
  for(const f of [...stage.files,{path:bootstrap.ownerKey.blobPath}]){
    let current=aclKey(f.path);
    while(true){
      required.add(current);
      const parent=aclKey(path.win32.dirname(current));
      if(parent===current)break;
      current=parent;
    }
  }
  const listed=new Set<string>();
  for(const entry of acl.inspectedEntries){
    if(!entry||typeof entry.path!=='string'||
      entry.evidenceAvailable!==true||
      entry.broadLowTrustWriteFound!==false||
      entry.reparsePointDetected!==false){
      refuse('NATIVE_ACL_V2_INCOMPLETE_OR_UNSAFE');
    }
    const key=aclKey(entry.path);
    if(listed.has(key))refuse('NATIVE_ACL_V2_DUPLICATE_PATH');
    listed.add(key);
  }
  if([...required].some(p=>!listed.has(p))||
    !listed.has(aclKey(acl.protectedRoot))||
    !acl.acceptedInputPaths.some(p=>aclKey(p)===aclKey(bootstrap.ownerKey.blobPath))){
    refuse('NATIVE_ACL_V2_MISSING_SIGNED_IMPORT_OR_PARENT');
  }
  // #714's atomic readback and #712's permit MUST refer to the same
  // immutable signed stage; same SHA with a different file-ID is NOT enough.
  // Without this, calling only the v2/permit facade could combine evidence
  // from different cutovers, including a crash still marked UNKNOWN.
  const broker=stage.files.find(f=>f.role==='broker');
  const rollback=stage.files.find(f=>f.role==='rollback');
  const updater=stage.files.find(f=>f.role==='updater');
  if(!broker||!rollback||!updater||
    atomic.phase!=='post-cutover-readback'||
    atomic.noPendingUnknownNativeMutation!==true||
    atomic.writeAheadJournalDurable!==true||
    atomic.journalAuthenticatedByExternalAuthority!==true||
    atomic.postconditionWitnessVerified!==true||
    atomic.installedAfterCutover.sha256!==broker.sha256||
    atomic.installedAfterCutover.volumeIdentity!==broker.volumeIdentity||
    atomic.installedAfterCutover.fileIdentity!==broker.fileIdentity||
    atomic.previousRollbackAfter.sha256!==rollback.sha256||
    atomic.previousRollbackAfter.volumeIdentity!==rollback.volumeIdentity||
    atomic.previousRollbackAfter.fileIdentity!==rollback.fileIdentity||
    atomic.postUpdater.sha256!==updater.sha256||
    atomic.postUpdater.volumeIdentity!==updater.volumeIdentity||
    atomic.postUpdater.fileIdentity!==updater.fileIdentity||
    bootstrap.ownerKey.blobSha256!==bootstrap.record.dpapiBlobSha256||
    bootstrap.ownerKey.independentEpoch!==bootstrap.record.ownerEpoch){
    refuse('SIGNED_RELEASE_ATOMIC_READBACK_MISMATCH');
  }
  const p=witness?.signedPermit;
  if(!p||!pins||!witness||
    witness.independentlyAuthenticated!==true||
    witness.singleUseReserved!==true||
    witness.revoked!==false||witness.unknownMutation!==false||
    p.schemaVersion!==2||p.kind!=='core_installer_dispatch_permit_source_v2'||
    !ID.test(p.ownerAccountId)||!ID.test(p.deviceId)||
    p.ownerAccountId!==pins.ownerAccountId||
    p.deviceId!==pins.deviceId||
    p.ownerAccountId!==bootstrap.record.ownerAccountId||
    p.deviceId!==bootstrap.record.deviceId||
    p.transactionId!==bootstrap.record.transactionId||
    p.ownerEpoch!==bootstrap.record.ownerEpoch||
    p.ownerEpoch!==pins.ownerEpoch||
    !Number.isSafeInteger(p.grantGeneration)||p.grantGeneration<1||
    p.grantGeneration!==pins.grantGeneration||
    !/^[a-f0-9]{64}$/.test(p.challengeNonce)||
    p.challengeNonce!==pins.expectedChallengeNonce||
    !Number.isSafeInteger(p.externalSequence)||
    p.externalSequence<pins.minimumExternalSequence||
    p.externalSequence!==atomic.externalSequence||
    p.brokerSha256!==atomic.installedAfterCutover.sha256||
    p.stageManifestSha256!==stagePins.manifestSha256||
    p.signedImportDagSha256!==dagPins.independentGraphSha256||
    p.rollbackSha256!==stage.files.find(f=>f.role==='rollback')?.sha256||
    p.rollbackSha256!==atomic.previousRollbackAfter.sha256||
    p.dpapiBlobSha256!==bootstrap.ownerKey.blobSha256||
    p.dpapiBlobSha256!==bootstrap.record.dpapiBlobSha256||
    p.processCreationIdentity!==atomic.nativeTaskCreationIdentity||
    atomic.ownerEpoch!==p.ownerEpoch||
    atomic.transactionId!==p.transactionId){
    refuse('DISPATCH_PERMIT_OWNER_NONCE_EPOCH_STALE');
  }
  // An out-of-band Ed25519 authority signature prevents plain JSON
  // ownerEpoch/nonce replacement. Only the real off-host non-restorable
  // CAS could establish uniqueness and revoke ordering at runtime.
  detached(canon(p,permitFields),witness.signatureBase64,pins.authorityPublicKeyPem);
  return{
    status:'native_acl_and_permit_source_only',
    nativeHighTokenAttested:false,
    ownerOsConsentPhysicallyConfirmed:false,
    executionApproved:false,productionApproved:false,
  };
}
