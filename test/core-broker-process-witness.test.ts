import test from 'node:test';
import assert from 'node:assert/strict';
import {assessBrokerRuntimeIdentity,type BrokerRuntimeWitnessContext} from '../src/security/core-broker-process-witness.js';
const sha='a'.repeat(64);
const e={pid:49222,creationFiletime:'134092000001239777',volumeSerialHex:'a0b1c2d3',
 fileIdHex:'a0'.repeat(16),runningImageSha256:sha,ownerEpoch:17,deviceId:'device-1'};
const ctx=():BrokerRuntimeWitnessContext=>({
 trustedObservationSource:'signed-local-high-token-broker',observedProcess:{...e},
 expectedDeviceId:e.deviceId,currentOwnerEpoch:e.ownerEpoch,
 signedPublisherPinned:true,signedReleaseAndRollbackManifestVerified:true,
 protectedExeAndAncestorAclVerified:true,protectedImportsAndUpdaterTreeVerified:true,
 imageHandleFileIdentityVerified:true,processHandleDaclRejectsLowPrivDupHandle:true,
 tokenHighAndEnabledAdministratorsVerified:true,pendingMutationUnknown:false,ledgerAvailable:true,
});
const get=(observed:unknown,c=ctx())=>{c.observedProcess=observed;return assessBrokerRuntimeIdentity(e,c)};
test('all green synthetic process identity never enables production elevated dispatch',()=>{
 const r=get(e);assert.equal(r.reason,'PRODUCTION_EXECUTOR_NOT_INSTALLED');
 assert.equal(r.ownerCoreRootElevatedDispatchEnabled,false);
 assert.equal(r.pidOnlyTaskkillAllowed,false);assert.equal(r.productionReady,false);
});
test('PID reuse and different kernel FILETIME are denied',()=>{
 assert.equal(get({...e,pid:e.pid+1}).reason,'PID_REUSED_OR_CREATION_TIME_MISMATCH');
 assert.equal(get({...e,creationFiletime:'134092000001239778'}).reason,
  'PID_REUSED_OR_CREATION_TIME_MISMATCH');
});
test('replaced signed image hash, file ID and volume identity never pass',()=>{
 for(const patch of [{runningImageSha256:'b'.repeat(64)},{fileIdHex:'b0'.repeat(16)},
 {volumeSerialHex:'12345678'}]){
  assert.equal(get({...e,...patch}).reason,'RUNNING_IMAGE_REPLACED_OR_WRONG_FILE_ID');
 }
});
test('owner epoch, pairing device and observation source must match',()=>{
 const c=ctx();c.currentOwnerEpoch=18;
 assert.equal(get(e,c).reason,'OWNER_DEVICE_EPOCH_INVALID');
 assert.equal(get({...e,deviceId:'other'}).reason,'OWNER_DEVICE_EPOCH_INVALID');
 const d=ctx();d.trustedObservationSource='unverified';
 assert.equal(get(e,d).reason,'OBSERVATION_SOURCE_UNVERIFIED');
});
test('signed manifest, protected imported updater and full parent ACL each gate',()=>{
 for(const k of ['signedPublisherPinned','signedReleaseAndRollbackManifestVerified',
   'imageHandleFileIdentityVerified'] as const){
  const c=ctx();c[k]=false;
  assert.equal(get(e,c).reason,'SIGNED_RELEASE_OR_IMAGE_TRUST_UNVERIFIED');
 }
 for(const k of ['protectedExeAndAncestorAclVerified','protectedImportsAndUpdaterTreeVerified'] as const){
  const c=ctx();c[k]=false;
  assert.equal(get(e,c).reason,'FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED');
 }
});
test('PROCESS_DUP_HANDLE isolation and high token need independent evidence',()=>{
 const a=ctx();a.processHandleDaclRejectsLowPrivDupHandle=false;
 assert.equal(get(e,a).reason,'PROCESS_DUP_HANDLE_BOUNDARY_UNVERIFIED');
 const b=ctx();b.tokenHighAndEnabledAdministratorsVerified=false;
 assert.equal(get(e,b).reason,'HIGH_TOKEN_BROKER_UNVERIFIED');
});
test('lost ACK and missing external replay ledger forbid retry',()=>{
 for(const change of [{pendingMutationUnknown:true},{ledgerAvailable:false}]){
  const c=ctx();Object.assign(c,change);
  const result=get(e,c);
  assert.equal(result.reason,'PENDING_EFFECT_UNKNOWN_NO_REPLAY');
  assert.equal(result.status,'unknown');assert.equal(result.retrySafe,false);
 }
});
test('unavailable process identity and forged untyped report stay denied',()=>{
 assert.equal(get({pid:e.pid}).reason,'NATIVE_PROCESS_EVIDENCE_UNAVAILABLE');
 assert.equal(assessBrokerRuntimeIdentity({...e,creationFiletime:'INVALID'},ctx()).reason,
  'INVALID_EXPECTED_PROCESS');
});
