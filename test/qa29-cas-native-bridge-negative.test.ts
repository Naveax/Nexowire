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
import {
  hash, verifySig, redactAudit, type Signed, type ProcessCreation,
  type Postcondition,
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
 osReceipt:Signed<ProcessCreation>;osKey:KeyObject;
 postReceipt:Signed<Postcondition>;postKey:KeyObject;
 tree:Tree709; ownerEpochNow:number;grantGenerationNow:number;
 commandPossibleUnknown:boolean;now:number;
};
function crossCheck(x:Sample):CrossResult {
 // #712's fresh, independently signed permit is a DISPATCH admission only,
 // not evidence that a native process ran or that a postcondition changed.
 if(!validPermit(x.claim,x.permitKey,x.expected,x.now))
   return unknown('CAS_PERMIT_INVALID_OR_OLD_NONCE');
 if(x.ownerEpochNow!==x.expected.ownerEpoch||
    x.grantGenerationNow!==x.expected.generation)
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
    p.coreEpoch!==x.expected.generation||r.coreEpoch!==x.expected.generation||
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
  coreEpoch:expected.generation,intentHash:expected.fingerprint,
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
  coreEpoch:expected.generation,intentHash:expected.fingerprint,
  reservationNonce:process.reservationNonce,targetId:'target',
  targetGeneration:12,observedStateHash:hash('expected-state'),
  pid:process.pid,creationFiletime:process.creationFiletime,
  machineBootId:process.machineBootId,launchNonce:process.launchNonce,
  observedAtMs:now-50,observerId:'separate-fixture-readback',
 };
 return {expected,claim:signCas(ca.privateKey,expected),permitKey:ca.publicKey,
  osReceipt:signLocal(osKeys.privateKey,process),osKey:osKeys.publicKey,
  postReceipt:signLocal(readKeys.privateKey,readback),postKey:readKeys.publicKey,
  tree:{...tree709},ownerEpochNow:expected.ownerEpoch,
  grantGenerationNow:expected.generation,
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
 for(const patch of [{ownerEpochNow:9},{grantGenerationNow:13}]){
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
