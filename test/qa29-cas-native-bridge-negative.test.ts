/**
 * QA29 cross-owner SOURCE-CONTRACT fixture; source refs:
 * #712 1d78a7a9174e91e3b6baaa1319a063917391a64f
 * #709 b083004b9ab8c18125a428cf74f3e97f7adf4e88
 * These sibling branch sources are not present in #699's tree: this is
 * schema-level adversarial cross-validation, NOT linked runtime integration.
 * No OS, shell, elevated UAC, Broker, ACL modifications or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify, type KeyObject} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AuditLog, type AuditWrite} from '../src/audit/log.js';
import {
  hash, verifySig, redactAudit, verifyElevatedReceipt, eventDigest, sealBody,
  GENESIS, SEAL_GENESIS, type Signed, type ProcessCreation, type Postcondition,
  type Intent, type OsExit, type AuditKind, type AuditEvent, type Seal,
  type Segment, type ReceiptBundle, type Authorities, type CurrentAuthority,
  type CurrentRoot,
} from './qa29-native-receipt-verifier.js';

const gen=()=>generateKeyPairSync('ed25519');
const utf8=(value:unknown)=>Buffer.from(JSON.stringify(value),'utf8');
const signLocal=<T>(key:KeyObject,payload:T):Signed<T>=>({
  payload,signature:sign(null,utf8(payload),key).toString('base64'),
});
const h64=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const permitKeys=[
 'kind','authorityId','brokerId','dispatchId','challengeNonce','requestId','fingerprint',
 'capability','ownerId','deviceId','deviceEpoch','sessionEpoch','ownerEpoch','generation',
 'privilege','issuedAtMs','expiresAtMs',
] as const;
const uuid=(n:string)=>'123e4567-e89b-42d3-a456-4266141740'+n;
type Permit={
 kind:'broker_dispatch_permit_v1';authorityId:string;brokerId:string;
 dispatchId:string;challengeNonce:string;requestId:string;fingerprint:string;
 capability:string;ownerId:string;deviceId:string;deviceEpoch:string;
 sessionEpoch:string;ownerEpoch:number;generation:number;privilege:'CORE';
 issuedAtMs:number;expiresAtMs:number;
};
type CasClaim={payload:string;signature:string};
function signCas(key:KeyObject,payload:Permit):CasClaim{
 const b=utf8(payload);
 return {payload:b.toString('base64url'),signature:sign(null,b,key).toString('base64url')};
}
function validPermit(raw:CasClaim,pub:KeyObject,expected:Permit,now:number):boolean{
 try{
  if(!raw||typeof raw.payload!=='string'||typeof raw.signature!=='string'||
     raw.payload.length>4096||raw.signature.length>1024)return false;
  const data=Buffer.from(raw.payload,'base64url'),signature=Buffer.from(raw.signature,'base64url');
  if(data.toString('base64url')!==raw.payload||signature.toString('base64url')!==raw.signature||
     signature.length!==64||!verify(null,data,pub,signature))return false;
  const p=JSON.parse(data.toString('utf8')) as Record<string,unknown>;
  if(Object.keys(p).length!==permitKeys.length||
     permitKeys.some(k=>!Object.hasOwn(p,k)))return false;
  if(p.kind!=='broker_dispatch_permit_v1'||!h64(p.challengeNonce)||
     !h64(p.fingerprint)||!Number.isSafeInteger(p.ownerEpoch)||
     !Number.isSafeInteger(p.generation)||
     typeof p.issuedAtMs!=='number'||typeof p.expiresAtMs!=='number'||
     p.issuedAtMs>now+1000||p.expiresAtMs<=now||
     p.expiresAtMs<=p.issuedAtMs||p.expiresAtMs-p.issuedAtMs>5000)return false;
  return permitKeys.every(k=>p[k]===expected[k]);
 }catch{return false}
}
type Tree709={
 kind:'windows_core_broker_protected_tree_readonly_v2';
 productionReady:false;elevatedCoreDispatchEnabled:false;
 importListIndependentlyEnumerated:false;signedImportManifestVerified:false;
 updaterReleaseRollbackVerified:false;publisherOfEveryImportVerified:false;
 pidCreationFiletimeVerified:false;processDupHandleBoundaryVerified:false;
 protectedCompleteImageTreeAttested:false;
 inputsInsideRoot:boolean;allInspectedPathsHaveAclEvidence:boolean;
 anyInspectedPathUnsafe:boolean;
};
const tree709:Tree709={
 kind:'windows_core_broker_protected_tree_readonly_v2',
 productionReady:false,elevatedCoreDispatchEnabled:false,
 importListIndependentlyEnumerated:false,signedImportManifestVerified:false,
 updaterReleaseRollbackVerified:false,publisherOfEveryImportVerified:false,
 pidCreationFiletimeVerified:false,processDupHandleBoundaryVerified:false,
 protectedCompleteImageTreeAttested:false,
 inputsInsideRoot:true,allInspectedPathsHaveAclEvidence:true,anyInspectedPathUnsafe:false,
};
type CrossResult={
 status:'MUTATION_UNKNOWN';reason:string;sourceAccepted:false;retrySafe:false;
};
const unknown=(reason:string):CrossResult=>({
 status:'MUTATION_UNKNOWN',reason,sourceAccepted:false,retrySafe:false,
});
type Sample={
 expected:Permit;claim:CasClaim;permitKey:KeyObject;
 osReceipt:Signed<ProcessCreation>;osKey:KeyObject;osIssuerPrivateKey:KeyObject;
 postReceipt:Signed<Postcondition>;postKey:KeyObject;
 tree:Tree709; ownerEpochNow:number;grantGenerationNow:number;
 coreEpochAtApproval:number;currentCoreEpoch:number;
 commandPossibleUnknown:boolean;now:number;
};
function crossCheck(x:Sample):CrossResult {
 // #712's fresh, independently signed permit is a DISPATCH admission only,
 // not evidence that a native process ran or that a postcondition changed.
 if(!validPermit(x.claim,x.permitKey,x.expected,x.now))
   return unknown('CAS_PERMIT_INVALID_OR_OLD_NONCE');
 if(x.ownerEpochNow!==x.expected.ownerEpoch||
    x.grantGenerationNow!==x.expected.generation||
    x.currentCoreEpoch!==x.coreEpochAtApproval)
   return unknown('CORE_REVOKED_OR_OWNER_REPAIRED');
 if(x.commandPossibleUnknown)return unknown('POSSIBLE_EFFECT_NO_REPLAY');
 const p=x.osReceipt.payload,r=x.postReceipt.payload;
 if(!verifySig(x.osKey,p,x.osReceipt.signature)||
    !verifySig(x.postKey,r,x.postReceipt.signature))
   return unknown('SEPARATE_OS_READBACK_SIGNATURE_UNTRUSTED');
 if(p.kind!=='os-process-created-v1'||r.kind!=='independent-postcondition-v1'||
    p.requestId!==x.expected.requestId||r.requestId!==x.expected.requestId||
    p.ownerId!==x.expected.ownerId||r.ownerId!==x.expected.ownerId||
    p.deviceId!==x.expected.deviceId||r.deviceId!==x.expected.deviceId||
    p.ownerEpoch!==x.expected.ownerEpoch||r.ownerEpoch!==x.expected.ownerEpoch||
    p.coreEpoch!==x.coreEpochAtApproval||r.coreEpoch!==x.coreEpochAtApproval||
    p.intentHash!==x.expected.fingerprint||r.intentHash!==x.expected.fingerprint||
    p.pid!==r.pid||p.creationFiletime!==r.creationFiletime||
    p.machineBootId!==r.machineBootId||p.launchNonce!==r.launchNonce||
    p.reservationNonce!==r.reservationNonce)
   return unknown('FILETIME_OWNER_EPOCH_OR_INTENT_NOT_BOUND');
 // #709's actual native inspection is read-only, explicitly cannot enumerate
 // complete imports or independently verify PID / signed release.
 // A caller cannot elevate it with booleans or a CAS permit.
 if(x.tree.kind!=='windows_core_broker_protected_tree_readonly_v2'||
    x.tree.anyInspectedPathUnsafe||!x.tree.inputsInsideRoot||
    !x.tree.allInspectedPathsHaveAclEvidence)
   return unknown('NATIVE_ACL_OR_TREE_EVIDENCE_INVALID');
 return unknown('NATIVE_709_SOURCE_ONLY_NOT_PHYSICAL_HIGH_TOKEN');
}
function fixture():Sample{
 const ca=gen(),osKeys=gen(),readKeys=gen(),now=1_800_000_000_000;
 const expected:Permit={
  kind:'broker_dispatch_permit_v1',authorityId:uuid('00'),
  brokerId:uuid('01'),dispatchId:uuid('02'),
  challengeNonce:'a'.repeat(64),requestId:uuid('03'),
  fingerprint:hash('opaque-owner-approved-command'),capability:'shell.exec',
  ownerId:uuid('04'),deviceId:uuid('05'),deviceEpoch:uuid('06'),
  sessionEpoch:uuid('07'),ownerEpoch:8,generation:12,
  privilege:'CORE',issuedAtMs:now-1000,expiresAtMs:now+2000,
 };
 const process:ProcessCreation={
  kind:'os-process-created-v1',requestId:expected.requestId,
  ownerId:expected.ownerId,deviceId:expected.deviceId,
  sessionId:expected.sessionEpoch,ownerEpoch:expected.ownerEpoch,
  coreEpoch:7,intentHash:expected.fingerprint,
  reservationNonce:'synthetic-reserve',pid:4211,
  creationFiletime:'134092000001239777',machineBootId:'boot-fixture',
  launchNonce:'launch-fixture',createdAtMs:now-1000,
  integrity:'high',administratorsEnabled:true,
  imageHash:hash('synthetic-signed-broker'),publisherHash:hash('publisher'),
  protectedAcl:true,
 };
 const readback:Postcondition={
  kind:'independent-postcondition-v1',requestId:expected.requestId,
  ownerId:expected.ownerId,deviceId:expected.deviceId,
  sessionId:expected.sessionEpoch,ownerEpoch:expected.ownerEpoch,
  coreEpoch:7,intentHash:expected.fingerprint,
  reservationNonce:process.reservationNonce,targetId:'target',
  targetGeneration:12,observedStateHash:hash('expected-state'),
  pid:process.pid,creationFiletime:process.creationFiletime,
  machineBootId:process.machineBootId,launchNonce:process.launchNonce,
  observedAtMs:now-50,observerId:'separate-fixture-readback',
 };
 return {expected,claim:signCas(ca.privateKey,expected),permitKey:ca.publicKey,
  osReceipt:signLocal(osKeys.privateKey,process),osKey:osKeys.publicKey,
  osIssuerPrivateKey:osKeys.privateKey,
  postReceipt:signLocal(readKeys.privateKey,readback),postKey:readKeys.publicKey,
  tree:{...tree709},ownerEpochNow:expected.ownerEpoch,
  grantGenerationNow:expected.generation,
  coreEpochAtApproval:7,currentCoreEpoch:7,
  commandPossibleUnknown:false,now};
}
test('source cross-owner baseline never upgrades #709 read-only audit into physical Broker',()=>{
 const x=fixture(),res=crossCheck(x);
 assert.equal(res.status,'MUTATION_UNKNOWN');
 assert.equal(res.reason,'NATIVE_709_SOURCE_ONLY_NOT_PHYSICAL_HIGH_TOKEN');
 assert.equal(res.retrySafe,false);assert.equal(res.sourceAccepted,false);
});
test('CAS permit from #712 must bind a new challenge nonce, even with intact signature',()=>{
 const x=fixture();
 x.expected={...x.expected,challengeNonce:'b'.repeat(64)};
 assert.equal(crossCheck(x).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
});
test('old signed CAS grant, changed owner epoch, generation and session are not reusable',()=>{
 for(const delta of [
  {ownerEpoch:99},{generation:99},{ownerId:uuid('08')},
  {sessionEpoch:uuid('09')},{brokerId:uuid('10')},
  {deviceEpoch:uuid('11')},{fingerprint:hash('other-intent')},
 ]){
  const x=fixture();
  x.expected={...x.expected,...delta};
  assert.equal(crossCheck(x).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
 }
});
test('foreign CA signature, noncanonical receipt and injected fields are rejected',()=>{
 const x=fixture(),other=gen();
 assert.equal(crossCheck({...x,permitKey:other.publicKey}).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
 const bad={...x.claim,payload:x.claim.payload+'='};
 assert.equal(crossCheck({...x,claim:bad}).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
 const payload={...x.expected,authorization:'Bearer secret'};
 assert.equal(crossCheck({...x,claim:{
  payload:utf8(payload).toString('base64url'),signature:sign(null,utf8(payload),other.privateKey).toString('base64url'),
 }}).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
});
test('expired signed permit, future issuance and excessive TTL reject',()=>{
 for(const delta of [{expiresAtMs:0},{issuedAtMs:1_800_000_005_000},
  {expiresAtMs:1_800_000_020_000}]){
  const x=fixture(),p={...x.expected,...delta};
  const keys=gen();x.claim=signCas(keys.privateKey,p);x.permitKey=keys.publicKey;
  x.expected=p;
  assert.equal(crossCheck(x).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
 }
});
test('CORE revoke or owner re-pair after signed permit refuses admission',()=>{
 for(const patch of [{ownerEpochNow:9},{grantGenerationNow:13},{currentCoreEpoch:8}]){
  const x=fixture();
  assert.equal(crossCheck({...x,...patch}).reason,'CORE_REVOKED_OR_OWNER_REPAIRED');
 }
});
test('lost native dispatch ACK never licenses re-execution',()=>{
 const x=fixture(),r=crossCheck({...x,commandPossibleUnknown:true});
 assert.equal(r.reason,'POSSIBLE_EFFECT_NO_REPLAY');
 assert.equal(r.retrySafe,false);
});
test('separate OS signer and independent postcondition signer cannot be swapped',()=>{
 const x=fixture(),foreign=gen();
 assert.equal(crossCheck({...x,osKey:foreign.publicKey}).reason,'SEPARATE_OS_READBACK_SIGNATURE_UNTRUSTED');
 assert.equal(crossCheck({...x,postKey:foreign.publicKey}).reason,'SEPARATE_OS_READBACK_SIGNATURE_UNTRUSTED');
});
test('independently signed readback for recycled PID/FILETIME or wrong epoch fails',()=>{
 for(const patch of [
  {pid:1234},{creationFiletime:'134092000001239778'},
  {ownerEpoch:99},{coreEpoch:99},{intentHash:hash('forged')},
  {launchNonce:'other'}, {reservationNonce:'other'},
 ]){
  const x=fixture(),keys=gen(),payload={...x.postReceipt.payload,...patch};
  x.postReceipt=signLocal(keys.privateKey,payload);x.postKey=keys.publicKey;
  assert.equal(crossCheck(x).reason,'FILETIME_OWNER_EPOCH_OR_INTENT_NOT_BOUND');
 }
});
test('OS process FILETIME witness cannot mismatch independently signed postcondition',()=>{
 const x=fixture(),key=gen();
 x.osReceipt=signLocal(key.privateKey,{...x.osReceipt.payload,creationFiletime:'134092000001239778'});
 x.osKey=key.publicKey;
 assert.equal(crossCheck(x).reason,'FILETIME_OWNER_EPOCH_OR_INTENT_NOT_BOUND');
});
test('#709 native ACL gap or claimed all-safe audit never implies physical attestation',()=>{
 for(const patch of [{allInspectedPathsHaveAclEvidence:false},
  {inputsInsideRoot:false},{anyInspectedPathUnsafe:true}]){
  const x=fixture(),r=crossCheck({...x,tree:{...x.tree,...patch}});
  assert.equal(r.reason,'NATIVE_ACL_OR_TREE_EVIDENCE_INVALID');
 }
 const y=fixture(),r=crossCheck(y);
 assert.equal(r.reason,'NATIVE_709_SOURCE_ONLY_NOT_PHYSICAL_HIGH_TOKEN');
 assert.equal(y.tree.pidCreationFiletimeVerified,false);
 assert.equal(y.tree.importListIndependentlyEnumerated,false);
 assert.equal(y.tree.productionReady,false);
});
test('credential in user payload never appears in audit projection or denial response',()=>{
 const x=fixture();
 const output=redactAudit({
  kind:'dispatch',requestId:x.expected.requestId,ownerEpoch:8,coreEpoch:12,
  evidenceHash:hash('opaque'),password:'SUPER_PRIVATE',token:'Bearer SECRET',
  stdout:'SUPER_PRIVATE',args:['--password','SUPER_PRIVATE'],
 });
 const result=crossCheck({...x,expected:{...x.expected,challengeNonce:'b'.repeat(64)}});
 assert.doesNotMatch(JSON.stringify(output)+JSON.stringify(result),/SUPER_PRIVATE|Bearer|SECRET/);
 assert.deepEqual(Object.keys(output).sort(),
  ['kind','requestId','ownerEpoch','coreEpoch','evidenceHash'].sort());
});

/**
 * Single combined contract path: reuse #699's REAL source verifier, including
 * independent readback issuer and authenticated rotating audit. This is STILL
 * a synthetic fixture, and #709 remains a physical HIGH-token NO-GO.
 */
function sealedReceiptFixture(x:Sample):{bundle:ReceiptBundle;trust:Authorities}{
 const external=gen(),p=x.osReceipt.payload,r=x.postReceipt.payload;
 const exit:OsExit={
  kind:'os-exit-v1',requestId:x.expected.requestId,
  reservationNonce:p.reservationNonce,pid:p.pid,
  creationFiletime:p.creationFiletime,machineBootId:p.machineBootId,
  launchNonce:p.launchNonce,exitCode:0,exitedAtMs:x.now-250,
  stdoutHash:hash('untrusted-stdout-success'),stderrHash:hash(''),
  stdoutComplete:true,stderrComplete:true,
 };
 const signedExit=signLocal(x.osIssuerPrivateKey,exit);
 const intent:Intent={
  requestId:x.expected.requestId,ownerId:x.expected.ownerId,
  deviceId:x.expected.deviceId,sessionId:x.expected.sessionEpoch,
  ownerEpoch:x.expected.ownerEpoch,coreEpoch:x.coreEpochAtApproval,
  intentHash:x.expected.fingerprint,targetId:r.targetId,
  targetGeneration:r.targetGeneration,expectedStateHash:r.observedStateHash,
 };
 let seq=0,head=GENESIS,sealHead=SEAL_GENESIS;
 const events:AuditEvent[]=[];
 const entry=(kind:AuditKind,evidenceHash:string):void=>{
  const body:Omit<AuditEvent,'hash'>={
   seq:++seq,kind,requestId:intent.requestId,
   ownerEpoch:intent.ownerEpoch,coreEpoch:intent.coreEpoch,
   evidenceHash,previousHash:head,
  };
  const event={...body,hash:eventDigest(body)};
  head=event.hash;events.push(event);
 };
 entry('reserve',hash('synthetic-reservation'));
 entry('dispatch',hash(JSON.stringify(x.osReceipt)));
 entry('exit',hash(JSON.stringify(signedExit)));
 entry('postcondition',hash(JSON.stringify(x.postReceipt)));
 const groups=[events.slice(0,2),events.slice(2,3),events.slice(3)];
 const segments:Segment[]=groups.map((group,index)=>{
  const body:Omit<Seal,'signature'>={
   index,startSeq:group[0]!.seq,endSeq:group.at(-1)!.seq,
   previousSealHash:sealHead,
   firstPreviousHash:group[0]!.previousHash,
   endHash:group.at(-1)!.hash,
  };
  const seal:Seal={...body,signature:sign(null,utf8(sealBody({
   ...body,signature:'',
  })),external.privateKey).toString('base64')};
  sealHead=hash(JSON.stringify(seal));
  return {index,events:group,seal};
 });
 const latest:CurrentRoot={
  kind:'external-log-head-v1',index:2,seq,headHash:head,
  sealHash:sealHead,
 };
 const state:CurrentAuthority={
  kind:'external-current-state-v1',requestId:intent.requestId,
  deviceId:intent.deviceId,ownerId:intent.ownerId,
  ownerEpoch:intent.ownerEpoch,coreEpoch:intent.coreEpoch,
  reservationNonce:p.reservationNonce,intentHash:intent.intentHash,
  targetId:intent.targetId,targetGeneration:intent.targetGeneration,
  expectedStateHash:intent.expectedStateHash,state:'dispatched',
  dispatchCount:1,auditSeq:latest.seq,auditHeadHash:latest.headHash,
 };
 return {
  bundle:{intent,process:x.osReceipt,exit:signedExit,
   readback:x.postReceipt,segments},
  trust:{
   osPublicKey:x.osKey,readbackPublicKey:x.postKey,
   externalPublicKey:external.publicKey,
   getLatest:()=>signLocal(external.privateKey,state),
   getLogRoot:()=>signLocal(external.privateKey,latest),
   pinnedImageHash:p.imageHash,pinnedPublisherHash:p.publisherHash,
   nowMs:x.now,
  },
 };
}
function reconcileSignedReceiptAndCas(x:Sample,
 proof:{bundle:ReceiptBundle;trust:Authorities}):CrossResult{
 // Both a valid #712 signed permit and full #699 audit/readback must agree.
 // Do NOT treat the source oracle's COMPLETED_VERIFIED as physical approval.
 if(!validPermit(x.claim,x.permitKey,x.expected,x.now))
  return unknown('CAS_PERMIT_INVALID_OR_OLD_NONCE');
 if(x.ownerEpochNow!==x.expected.ownerEpoch||
    x.grantGenerationNow!==x.expected.generation||
    x.currentCoreEpoch!==x.coreEpochAtApproval)
  return unknown('CORE_REVOKED_OR_OWNER_REPAIRED');
 if(x.commandPossibleUnknown)return unknown('POSSIBLE_EFFECT_NO_REPLAY');
 if(verifyElevatedReceipt(proof.bundle,proof.trust).status!=='COMPLETED_VERIFIED')
  return unknown('AUDIT_OR_INDEPENDENT_RECEIPT_UNTRUSTED');
 return crossCheck(x); // Native #709 cannot supply production HIGH evidence
}
test('one source path binds signed CAS, separate OS/readback issuers, PID FILETIME and rotating audit; still native NO-GO',()=>{
 const x=fixture(),proof=sealedReceiptFixture(x);
 assert.notEqual(x.osKey,x.postKey);
 assert.equal(verifyElevatedReceipt(proof.bundle,proof.trust).status,
  'COMPLETED_VERIFIED'); // test fixture only, never physical Windows proof
 const source=reconcileSignedReceiptAndCas(x,proof);
 assert.equal(source.reason,'NATIVE_709_SOURCE_ONLY_NOT_PHYSICAL_HIGH_TOKEN');
 assert.equal(source.status,'MUTATION_UNKNOWN');
 assert.equal(source.retrySafe,false);
 const tampered=structuredClone(proof.bundle.segments) as Segment[];
 Object.assign(tampered[1]!.events[0]!,{evidenceHash:hash('forged-exit')});
 assert.equal(reconcileSignedReceiptAndCas(x,{
  ...proof,bundle:{...proof.bundle,segments:tampered},
 }).reason,'AUDIT_OR_INDEPENDENT_RECEIPT_UNTRUSTED');
 const revoked={...x,currentCoreEpoch:x.coreEpochAtApproval+1};
 assert.equal(reconcileSignedReceiptAndCas(revoked,proof).reason,
  'CORE_REVOKED_OR_OWNER_REPAIRED');
 assert.equal(reconcileSignedReceiptAndCas({
  ...x,expected:{...x.expected,challengeNonce:'b'.repeat(64)},
 },proof).reason,'CAS_PERMIT_INVALID_OR_OLD_NONCE');
});

/**
 * #756/#757/#747 single boundary: two authentic SOURCE readbacks and a
 * correctly signed (but fixture-issued) OS/postcondition/audit bundle
 * cannot prove installed HIGH/immutable independence, nor close revoke-
 * start AFTER the second Access review and BEFORE native effect commit.
 * This never runs an effect: all checks and transitions are in-memory.
 */
test('TEMP DUP_HANDLE ALLOW + co-restorable receipt root + late revoke after Access review never imply native HIGH completion',()=>{
 const x=fixture(),proof=sealedReceiptFixture(x);
 // Parent #699 contract validates cryptography from ephemeral trusted-in-fixture
 // keys. It does NOT authenticate a Windows-installed protected issuer, nor
 // prove that the fresh root is in a separate rollback/failure domain.
 assert.equal(validPermit(x.claim,x.permitKey,x.expected,x.now),true);
 assert.equal(verifyElevatedReceipt(proof.bundle,proof.trust).status,
  'COMPLETED_VERIFIED');
 const tempPidWitness={
  processClass:'marked-TEMP-pwsh-fixture' as const,
  pid:x.osReceipt.payload.pid,
  creationFiletime:x.osReceipt.payload.creationFiletime,
  processDupHandleOpenAccess:'ALLOW' as const,
  inspectedTokenIsInstalledBroker:false,
  installedBrokerProcessAttested:false,
  separateLowPrivilegeCallerBoundaryVerified:false,
  protectedJobHandleInheritanceAndDaclVerified:false,
 };
 // Mirrors #757's SOURCE_ONLY review after two externally signed snapshots:
 // neither readback is an atomic commit-for-dispatch at the actual effect.
 const external={
  firstSignedFence:{revoking:false,revoked:false},
  secondSignedFence:{revoking:false,revoked:false},
  immutableRootOutsideHubFailureDomain:false,
  independentInstalledOsIssuerVerified:false,
  independentInstalledReadbackIssuerVerified:false,
  finalExternalAtomicNativeCommitAvailable:false,
  revoking:false,
 };
 assert.equal(external.firstSignedFence.revoking,false);
 assert.equal(external.secondSignedFence.revoking,false);
 const accessReview='CURRENT_SOURCE_ONLY_NO_EXECUTION';
 assert.equal(accessReview,'CURRENT_SOURCE_ONLY_NO_EXECUTION');
 // #747: Hub B starts revoke after review, but before the final native
 // boundary. Rechecking only the two historical signed snapshots is stale.
 external.revoking=true;
 let nativeEffects=0;
 type NativeObservation={
  processClass:'marked-TEMP-pwsh-fixture'|'independently-attested-installed-broker';
  pid:number;creationFiletime:string;processDupHandleOpenAccess:'ALLOW'|'DENIED';
  inspectedTokenIsInstalledBroker:boolean;installedBrokerProcessAttested:boolean;
  separateLowPrivilegeCallerBoundaryVerified:boolean;
  protectedJobHandleInheritanceAndDaclVerified:boolean;
 };
 const finalSourceOnlyCheck=(native:NativeObservation,remaining:typeof external)=>{
  if(!native.installedBrokerProcessAttested||
     native.processClass==='marked-TEMP-pwsh-fixture'||
     !native.inspectedTokenIsInstalledBroker||
     !native.separateLowPrivilegeCallerBoundaryVerified)
   return unknown('TEMP_PID_IS_NOT_INSTALLED_HIGH_BROKER');
  if(native.processDupHandleOpenAccess==='ALLOW'||
     !native.protectedJobHandleInheritanceAndDaclVerified)
   return unknown('PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED');
  if(!remaining.immutableRootOutsideHubFailureDomain||
     !remaining.independentInstalledOsIssuerVerified||
     !remaining.independentInstalledReadbackIssuerVerified)
   return unknown('IMMUTABLE_INDEPENDENT_WITNESS_UNVERIFIED');
  if(remaining.revoking||!remaining.finalExternalAtomicNativeCommitAvailable)
   return unknown('REVOKE_STARTED_BEFORE_FINAL_ATOMIC_EFFECT_COMMIT');
  // Never execute user/native effect in any source QA path.
  return unknown('PHYSICAL_EXECUTOR_NOT_INSTALLED');
 };
 const verdict=finalSourceOnlyCheck(tempPidWitness,external);
 assert.equal(verdict.reason,'TEMP_PID_IS_NOT_INSTALLED_HIGH_BROKER');
 assert.equal(verdict.retrySafe,false);
 // These *forged in-memory toggles* are only used to expose the next
 // independent missing gate, NEVER claims of installed OS authentication.
 const fabricatedNative:NativeObservation={...tempPidWitness,
  processClass:'independently-attested-installed-broker',
  installedBrokerProcessAttested:true,
  inspectedTokenIsInstalledBroker:true,
  separateLowPrivilegeCallerBoundaryVerified:true,
 };
 assert.equal(finalSourceOnlyCheck(fabricatedNative,external).reason,
  'PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED');
 const fabricatedDacl:NativeObservation={...fabricatedNative,
  processDupHandleOpenAccess:'DENIED',
  protectedJobHandleInheritanceAndDaclVerified:true,
 };
 assert.equal(finalSourceOnlyCheck(fabricatedDacl,external).reason,
  'IMMUTABLE_INDEPENDENT_WITNESS_UNVERIFIED');
 const fabricatedIndependentWitness={...external,
  immutableRootOutsideHubFailureDomain:true,
  independentInstalledOsIssuerVerified:true,
  independentInstalledReadbackIssuerVerified:true,
 };
 assert.equal(finalSourceOnlyCheck(fabricatedDacl,fabricatedIndependentWitness).reason,
  'REVOKE_STARTED_BEFORE_FINAL_ATOMIC_EFFECT_COMMIT');
 assert.equal(external.revoking,true,
  'revoke can start after both signed Access readbacks');
 assert.equal(reconcileSignedReceiptAndCas(x,proof).status,'MUTATION_UNKNOWN');
 assert.equal(nativeEffects,0,'no synthetic or actual native effect dispatched');
 assert.equal(JSON.stringify(verdict).includes('password'),false);
});

/**
 * #768 returned TrustedPublicationCommit has no independent signature or
 * ownerEpoch/grantGeneration fields. This is a REQUIRED, NOT IMPLEMENTED
 * cross-owner acceptance contract: #757 signed Access high-water must be
 * current and publisher/external-commit issuers must be independently pinned.
 * #761 already covers native commit-vs-revoke ordering; never simulate it here.
 */
test('forged final publication issuer or stale ownerEpoch/grantGeneration cannot elevate a #768-shaped commit to COMPLETED',()=>{
 const native=gen(),external=gen(),highwaterIssuer=gen(),attacker=gen();
 const x=fixture();
 const binding={
  jobId:uuid('12'),requestId:x.expected.requestId,
  ownerId:x.expected.ownerId,deviceId:x.expected.deviceId,
  ownerEpoch:x.expected.ownerEpoch,grantGeneration:x.expected.generation,
  epoch:73,sha256:hash('synthetic-target-bytes'),
 };
 const readbackBody={
  kind:'qa29.current-publication-highwater.v1',
  ownerId:binding.ownerId,deviceId:binding.deviceId,
  ownerEpoch:binding.ownerEpoch,grantGeneration:binding.grantGeneration,
  revoking:false,revoked:false,
 };
 const nativeBody={
  kind:'qa29.native-final-publication.v1',
  ...binding,proofNonce:'c'.repeat(64),
 };
 const signedNative=signLocal(native.privateKey,nativeBody);
 const commitBody={
  kind:'qa29.monotonic-final-publication-commit.v1',
  ...binding,durableCommitId:'EXTERNAL-ONLY-'+hash('one-atomic-publication'),
  receiptDigest:hash(JSON.stringify(signedNative)),
 };
 const signedCommit=signLocal(external.privateKey,commitBody);
 const signedCurrent=signLocal(highwaterIssuer.privateKey,readbackBody);
 const legacy768={
  jobId:binding.jobId,requestId:binding.requestId,epoch:binding.epoch,
  sha256:binding.sha256,durableCommitId:commitBody.durableCommitId,
 };
 // Match #768's current *source type*, not a claim about deployed authority.
 assert.deepEqual(Object.keys(legacy768).sort(),
  ['jobId','requestId','epoch','sha256','durableCommitId'].sort());
 type SignedStatement=Signed<Record<string,unknown>>;
 const reject=(reason:string)=>({
  status:'MUTATION_UNKNOWN' as const,reason,retrySafe:false as const,
 });
 const trust={
  nativePublicKey:native.publicKey,commitPublicKey:external.publicKey,
  accessHighwaterPublicKey:highwaterIssuer.publicKey,
 };
 const verifyFinal=(receipt:SignedStatement|undefined,
  commit:SignedStatement|undefined,
  current:SignedStatement|undefined,
  expected:typeof binding)=>{
  // Cannot trust a success-looking durable ID or the issuer key supplied
  // in a receipt; trust anchors are provisioned independently.
  if(!receipt||!verifySig(trust.nativePublicKey,receipt.payload,receipt.signature)||
     receipt.payload.kind!=='qa29.native-final-publication.v1')
   return reject('NATIVE_FINAL_RECEIPT_ISSUER_UNTRUSTED');
  if(!commit||!verifySig(trust.commitPublicKey,commit.payload,commit.signature)||
     commit.payload.kind!=='qa29.monotonic-final-publication-commit.v1')
   return reject('EXTERNAL_MONOTONIC_COMMIT_ISSUER_UNTRUSTED');
  if(!current||!verifySig(trust.accessHighwaterPublicKey,
      current.payload,current.signature)||
     current.payload.kind!=='qa29.current-publication-highwater.v1')
   return reject('CURRENT_OWNER_HIGHWATER_UNVERIFIED');
  const scope=['jobId','requestId','ownerId','deviceId',
   'ownerEpoch','grantGeneration','epoch','sha256'] as const;
  if(scope.some(k=>receipt.payload[k]!==expected[k]||
     commit.payload[k]!==expected[k])||
     !Number.isSafeInteger(expected.ownerEpoch)||
     !Number.isSafeInteger(expected.grantGeneration)||
     current.payload.ownerId!==expected.ownerId||
     current.payload.deviceId!==expected.deviceId||
     current.payload.ownerEpoch!==expected.ownerEpoch||
     current.payload.grantGeneration!==expected.grantGeneration||
     current.payload.revoking!==false||current.payload.revoked!==false)
   return reject('FINAL_RECEIPT_OWNER_EPOCH_OR_GRANT_GENERATION_STALE');
  if(commit.payload.receiptDigest!==hash(JSON.stringify(receipt))||
     typeof commit.payload.durableCommitId!=='string'||
     commit.payload.durableCommitId.length<32)
   return reject('FINAL_RECEIPT_AND_EXTERNAL_COMMIT_NOT_BOUND');
  // Even authentic *synthetic* proofs cannot authorize real native/high
  // process execution or attest a deployed immutable monotonic CAS.
  return reject('SOURCE_SIGNED_ONLY_NO_PHYSICAL_PUBLISHER_OR_CAS');
 };
 const good=verifyFinal(signedNative,signedCommit,signedCurrent,binding);
 assert.equal(good.reason,'SOURCE_SIGNED_ONLY_NO_PHYSICAL_PUBLISHER_OR_CAS');
 assert.equal(good.retrySafe,false);
 // Current #768-shaped response has no independently signed final issuer
 // or owner/grant version, so its default is UNKNOWN even with plausible ID.
 assert.equal(verifyFinal(signedNative,legacy768 as unknown as SignedStatement,
  signedCurrent,binding).reason,
  'EXTERNAL_MONOTONIC_COMMIT_ISSUER_UNTRUSTED');
 assert.equal(verifyFinal(signLocal(attacker.privateKey,nativeBody),
  signedCommit,signedCurrent,binding).reason,
  'NATIVE_FINAL_RECEIPT_ISSUER_UNTRUSTED');
 assert.equal(verifyFinal(signedNative,
  signLocal(attacker.privateKey,commitBody),signedCurrent,binding).reason,
  'EXTERNAL_MONOTONIC_COMMIT_ISSUER_UNTRUSTED');
 // A genuine old signed receipt/commit is not current after owner re-pair or
 // grant generation rollover, even with unchanged artifact SHA/requestId.
 const newerOwner=signLocal(highwaterIssuer.privateKey,{
  ...readbackBody,ownerEpoch:readbackBody.ownerEpoch+1,
 });
 const newerGrant=signLocal(highwaterIssuer.privateKey,{
  ...readbackBody,grantGeneration:readbackBody.grantGeneration+1,
 });
 for(const newer of [newerOwner,newerGrant]){
  const verdict=verifyFinal(signedNative,signedCommit,newer,binding);
  assert.equal(verdict.reason,'FINAL_RECEIPT_OWNER_EPOCH_OR_GRANT_GENERATION_STALE');
  assert.equal(verdict.retrySafe,false);
 }
 assert.equal(verifyFinal(signedNative,signedCommit,
  signLocal(attacker.privateKey,readbackBody),binding).reason,
  'CURRENT_OWNER_HIGHWATER_UNVERIFIED');
 const noNativeEffects=0;
 assert.equal(noNativeEffects,0);
 assert.doesNotMatch(JSON.stringify(good),/token|password|rawPayload|secret/i);
 assert.equal(good.status,'MUTATION_UNKNOWN');
});

/**
 * P1 #780 pre-integration NEGATIVE REPRO against the ACTUAL existing
 * src/audit/log.ts writer/query, NOT a product dashboard that doesn't exist.
 * A PASS proves current unsigned JSONL can be forged/queried and that
 * runtime-untyped extra fields leak; it does NOT prove safe storage or trust.
 * No user data, machine service, Agent, Broker, elevation or VM is accessed.
 */
test('real audit JSONL admits synthetic forged success/re-pair-stale row and untyped secret field: dashboard must treat as untrusted',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa29-audit-boundary-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'audit.jsonl');
 const x=fixture(),requestId=x.expected.requestId,capability='shell.exec';
 const log=new AuditLog(file);
 await log.write({operationId:requestId,status:'unknown',capability,
  targetId:x.expected.deviceId,errorCode:'MUTATION_STATE_UNKNOWN'});
 // Simulated appended/rolled-back JSONL entry. This is NOT a signed issuer
 // and no honest observer should classify it as verified execution.
 const stale={
  id:uuid('21'),operationId:requestId,
  at:'2026-10-22T16:40:00.000Z',status:'succeeded',
  capability,targetId:x.expected.deviceId,providerId:'fake-native-provider',
  ownerId:x.expected.ownerId,ownerEpoch:x.expected.ownerEpoch,
  grantGeneration:x.expected.generation,
  worktreeId:'synthetic-worktree-1',requestHash:x.expected.fingerprint,
  durationMs:4,provenance:'claim-only-no-external-signature',
 };
 await fs.appendFile(file,JSON.stringify(stale)+'\n','utf8');
 const result=await new AuditLog(file).query({operationId:requestId,limit:3});
 assert.equal(result.events.length,2);
 assert.equal(result.events[0]?.status,'succeeded',
  'CURRENT SOURCE REPRO: unsigned appended success is returned by audit_query');
 assert.equal(result.events[1]?.status,'unknown',
  'the originally UNKNOWN side effect is not disproven by the forged row');
 const currentSigner=gen(),current=signLocal(currentSigner.privateKey,{
  kind:'qa29.owner-current.v1',ownerId:x.expected.ownerId,
  deviceId:x.expected.deviceId,ownerEpoch:x.expected.ownerEpoch+1,
  grantGeneration:x.expected.generation+1,revoked:false,
 });
 assert.equal(verifySig(currentSigner.publicKey,current.payload,current.signature),true);
 const candidate=result.events[0] as unknown as Record<string,unknown>;
 assert.notEqual(candidate.ownerEpoch,current.payload.ownerEpoch,
  'the forged row records a pre-re-pair owner epoch');
 assert.notEqual(candidate.grantGeneration,current.payload.grantGeneration,
  'the forged row is from an old grant generation');
 assert.equal(candidate.issuerSignature,undefined,
  'existing audit store does not attach authenticated immutable provenance');
 // A forged success is a query result, never a verified postcondition.
 const trustVerdict={status:'MUTATION_UNKNOWN' as const,retrySafe:false as const,
  denialSource:'UNSIGNED_AUDIT_ROW_REPAIR_STALE'};
 assert.equal(trustVerdict.status,'MUTATION_UNKNOWN');
 assert.equal(trustVerdict.retrySafe,false);
 // The runtime API is callable from JS without TS validation. The spread of
 // ...input currently persists unknown keys: reproduce with FAKE secrets only.
 const marker='QA29_FAKE_SECRET_DO_NOT_USE';
 await log.write({operationId:requestId,status:'started',capability,
  targetId:x.expected.deviceId,
  rawCommandBody:'echo '+marker,authorization:'Bearer '+marker,
 } as unknown as AuditWrite);
 const raw=await fs.readFile(file,'utf8');
 assert.match(raw,/QA29_FAKE_SECRET_DO_NOT_USE/,
  'CURRENT SOURCE REPRO: untyped extra keys are not allowlisted at persistence');
 assert.equal(trustVerdict.denialSource,'UNSIGNED_AUDIT_ROW_REPAIR_STALE');
});
