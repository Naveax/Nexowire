import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspectReadonlyNativeAvailability,
} from '../src/diagnostics/core-native-provider-availability.js';
import {
  type BrokerExpectation,
  type ReadonlyEvidenceProviders,
  type RunningImage, type HighToken, type ImageTree,
  type OwnerEpoch, type ExternalEpoch, type StatusOnly,
} from '../src/diagnostics/core-broker-filetime-cas-evidence.js';

const now=Date.parse('2026-10-22T00:00:00.000Z');
const identity={
  pid:12008,
  creationFiletime:'134058540000000000',
  volumeSerialHex:'abcdef12',
  fileIdHex:'0011223344556677',
  imageSha256:'a'.repeat(64),
};
const expected:BrokerExpectation={
  identity,publisherThumbprint:'b'.repeat(40),
  ownerId:'synthetic-owner',deviceId:'synthetic-device',
  minGeneration:42,statusRequestId:'nonce-42',
  nowMs:now,maxAgeMs:5000,
};
const observed=<T>(value:T)=>({state:'reported' as const,observedAtMs:now,value});
function green():ReadonlyEvidenceProviders{
  return{
    signedImage:async()=>observed<RunningImage>({
      identity,running:true,authenticodeVerified:true,
      pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
    }),
    highToken:async()=>observed<HighToken>({
      pid:12008,creationFiletime:identity.creationFiletime,
      integrity:'high',administratorsEnabled:true,sameProcessTokenVerified:true,
    }),
    protectedTree:async()=>observed<ImageTree>({
      ancestorAclProtected:true,importsIndependentlyEnumerated:true,
      signedImportManifestVerified:true,importsAclProtected:true,
      updaterAndImportsAclProtected:true,noLowTrustWriteOrReplace:true,
      lowPrivilegeDupHandleDenied:true,
    }),
    ownerGrant:async()=>observed<OwnerEpoch>({
      ownerId:'synthetic-owner',deviceId:'synthetic-device',
      ownerEpoch:100,generation:42,active:true,signed:true,revocationChecked:true,
    }),
    externalCas:async()=>observed<ExternalEpoch>({
      ownerId:'synthetic-owner',deviceId:'synthetic-device',
      ownerEpoch:100,generation:42,signedReceipt:true,
      independentlyNonCoRestorable:true,linearizableWithRevoke:true,revoked:false,
    }),
    status:async()=>observed<StatusOnly>({
      requestId:'nonce-42',responseRequestId:'nonce-42',
      httpStatus:200,fromCache:false,consentExeVisible:false,
      requestedCorePreference:false,
    }),
  };
}
test('uninstalled native read-only providers are UNAVAILABLE, not installed HIGH',async()=>{
  const r=await inspectReadonlyNativeAvailability(undefined,expected);
  assert.equal(r.provider,'UNAVAILABLE');
  assert.equal(r.probeState.signedImage,'unavailable');
  assert.equal(r.probeState.highToken,'unavailable');
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
  assert.equal(r.highTokenObservation,'UNAVAILABLE_OR_NOT_HIGH');
  assert.equal(r.authorizationGranted,false);
  assert.equal(r.diagnosis.status,'BLOCKED');
  assert.ok(r.diagnosis.reasons.includes('SIGNED_IMAGE_UNAVAILABLE'));
});
test('missing signed-image native reader cannot be replaced by a HIGH claim',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),signedImage:undefined,
  },expected);
  assert.equal(r.provider,'PARTIAL');
  assert.equal(r.highTokenObservation,'HIGH_CLAIM_UNATTESTED');
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
  assert.ok(r.diagnosis.reasons.includes('SIGNED_IMAGE_UNAVAILABLE'));
  assert.equal(r.effectiveCore,false);
});
test('all-green *reported* native reader claims are NOT installed HIGH attestation',async()=>{
  const r=await inspectReadonlyNativeAvailability(green(),expected);
  assert.equal(r.provider,'REPORTED_UNATTESTED');
  assert.equal(r.highTokenObservation,'HIGH_CLAIM_UNATTESTED');
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
  assert.equal(r.independentWitnessDeployed,'NOT_PROVEN');
  assert.equal(r.diagnosis.status,'UNVERIFIED');
  assert.equal(r.diagnosis.effectiveElevation,'NOT_PROVEN');
  assert.equal(r.diagnosis.dispatchAllowed,false);
});
test('same PID with wrong 64-bit Windows FILETIME cannot prove actual HIGH Broker token',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),highToken:async()=>observed<HighToken>({
      pid:12008,creationFiletime:'134058540000000001',
      integrity:'high',administratorsEnabled:true,sameProcessTokenVerified:true,
    }),
  },expected);
  assert.equal(r.highTokenObservation,'UNAVAILABLE_OR_NOT_HIGH');
  assert.ok(r.diagnosis.reasons.includes('TOKEN_PROCESS_FILETIME_MISMATCH'));
  assert.equal(r.effectiveCore,false);
});
test('wrong running-image FILETIME is different from token/PID coincidence',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),signedImage:async()=>observed<RunningImage>({
      identity:{...identity,creationFiletime:'134058540000000002'},
      running:true,authenticodeVerified:true,
      pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
    }),
  },expected);
  assert.ok(r.diagnosis.reasons.includes('PID_CREATION_FILETIME_MISMATCH'));
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
});
test('unauthenticated or cached HTTP 401 and CORE UI preference do not mint EFFECTIVE CORE',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),status:async()=>observed<StatusOnly>({
      requestId:'cached-old',responseRequestId:'cached-old',
      httpStatus:401,fromCache:true,consentExeVisible:true,
      requestedCorePreference:true,
    }),
  },expected);
  for(const code of [
    'UNAUTHENTICATED_401_NOT_ELEVATION','REPLAYED_STATUS_CACHE',
    'STATUS_REQUEST_UNCORRELATED','CONSENT_EXE_NOT_APPROVAL',
    'CORE_PREFERENCE_NOT_EFFECTIVE',
  ]){
    assert.ok(r.diagnosis.reasons.includes(code as never));
  }
  assert.equal(r.effectiveCore,false);
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
});
test('old CORE grant generation cannot override current external CAS epoch/generation',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),ownerGrant:async()=>observed<OwnerEpoch>({
      ownerId:'synthetic-owner',deviceId:'synthetic-device',
      ownerEpoch:99,generation:41,active:true,signed:true,revocationChecked:true,
    }),
  },expected);
  assert.ok(r.diagnosis.reasons.includes('CORE_OWNER_GRANT_STALE_OR_REVOKED'));
  assert.ok(r.diagnosis.reasons.includes('CACHED_CORE_EPOCH_MISMATCH'));
  assert.equal(r.independentWitnessDeployed,'NOT_PROVEN');
});
test('real externally independent CAS is still NOT PROVEN by synthetic provider claim',async()=>{
  const r=await inspectReadonlyNativeAvailability(green(),expected);
  assert.equal(r.independentWitnessDeployed,'NOT_PROVEN');
  assert.equal(r.diagnosis.authorized,false);
  assert.equal(r.diagnosis.replaySafe,false);
});
test('missing external witness is unavailable even if CORE grant is signed',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),externalCas:undefined,
  },expected);
  assert.equal(r.probeState.externalCas,'unavailable');
  assert.ok(r.diagnosis.reasons.includes('EXTERNAL_CAS_UNAVAILABLE'));
  assert.equal(r.authorizationGranted,false);
});
test('incomplete imported/updater ACL and unverified DUP_HANDLE stay blocked',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),protectedTree:async()=>observed<ImageTree>({
      ancestorAclProtected:true,importsIndependentlyEnumerated:false,
      signedImportManifestVerified:false,importsAclProtected:true,
      updaterAndImportsAclProtected:false,noLowTrustWriteOrReplace:true,
      lowPrivilegeDupHandleDenied:false,
    }),
  },expected);
  assert.ok(r.diagnosis.reasons.includes('FULL_IMPORT_UPDATER_ACL_UNVERIFIED'));
});
test('provider exceptions never disclose secrets or silently become status PASS',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),signedImage:async()=>{throw new Error('DO_NOT_SHOW_BEARER_TOKEN');},
  },expected);
  assert.equal(r.probeState.signedImage,'unavailable');
  assert.ok(r.diagnosis.reasons.includes('SIGNED_IMAGE_UNAVAILABLE'));
  assert.equal(JSON.stringify(r).includes('DO_NOT_SHOW_BEARER_TOKEN'),false);
});
test('each read-only native callback is called only once per snapshot',async()=>{
  let counts=0;
  const g=green();
  const r=await inspectReadonlyNativeAvailability({
    ...g,signedImage:async()=>{counts++;return g.signedImage!();},
  },expected);
  assert.equal(counts,1);
  assert.equal(r.installedHighBroker,'NOT_PROVEN');
});
test('malformed provider response remains UNAVAILABLE and causes rejection',async()=>{
  const r=await inspectReadonlyNativeAvailability({
    ...green(),signedImage:async()=>({bogus:'safe'} as never),
  },expected);
  assert.equal(r.probeState.signedImage,'unavailable');
  assert.equal(r.diagnosis.status,'BLOCKED');
});
