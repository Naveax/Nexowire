import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessReadonlyBrokerEpoch,
  type BrokerExpectation, type ReadonlyEvidenceProviders,
  type RunningImage, type HighToken, type ImageTree,
  type OwnerEpoch, type ExternalEpoch, type StatusOnly, type Reason,
} from '../src/diagnostics/core-broker-filetime-cas-evidence.js';

const now=Date.parse('2026-10-21T18:50:00.000Z');
const identity={
  pid:4321,creationFiletime:'134058540000000000',
  volumeSerialHex:'a1b2c3d4',fileIdHex:'0011223344556677',
  imageSha256:'a'.repeat(64),
};
const expect:BrokerExpectation={
  identity,publisherThumbprint:'b'.repeat(40),
  ownerId:'fixture-owner',deviceId:'fixture-device',
  minGeneration:12,statusRequestId:'unique-request-12',
  nowMs:now,maxAgeMs:30000,
};
const reported=<T>(value:T,observedAtMs=now)=>({
  state:'reported' as const,observedAtMs,value,
});
function fixture():ReadonlyEvidenceProviders{
  return{
    signedImage:async()=>reported<RunningImage>({
      identity,running:true,authenticodeVerified:true,
      pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
    }),
    highToken:async()=>reported<HighToken>({
      pid:4321,creationFiletime:identity.creationFiletime,
      integrity:'high',administratorsEnabled:true,sameProcessTokenVerified:true,
    }),
    protectedTree:async()=>reported<ImageTree>({
      ancestorAclProtected:true,importsIndependentlyEnumerated:true,
      signedImportManifestVerified:true,importsAclProtected:true,
      updaterAndImportsAclProtected:true,noLowTrustWriteOrReplace:true,
      lowPrivilegeDupHandleDenied:true,
    }),
    ownerGrant:async()=>reported<OwnerEpoch>({
      ownerId:'fixture-owner',deviceId:'fixture-device',
      ownerEpoch:30,generation:12,active:true,signed:true,revocationChecked:true,
    }),
    externalCas:async()=>reported<ExternalEpoch>({
      ownerId:'fixture-owner',deviceId:'fixture-device',
      ownerEpoch:30,generation:12,signedReceipt:true,
      independentlyNonCoRestorable:true,linearizableWithRevoke:true,revoked:false,
    }),
    status:async()=>reported<StatusOnly>({
      requestId:'unique-request-12',responseRequestId:'unique-request-12',
      httpStatus:200,fromCache:false,consentExeVisible:false,
      requestedCorePreference:false,
    }),
  };
}
const check=(changes:ReadonlyEvidenceProviders={},expected=expect)=>
  assessReadonlyBrokerEpoch({...fixture(),...changes},expected);
function deny(report:Awaited<ReturnType<typeof assessReadonlyBrokerEpoch>>,code:Reason){
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.reasons.includes(code),JSON.stringify(report.reasons));
  assert.equal(report.effectiveCore,false);
  assert.equal(report.authorized,false);
  assert.equal(report.dispatchAllowed,false);
  assert.equal(report.replaySafe,false);
}

test('all-green injected observations remain UNVERIFIED, never EFFECTIVE CORE',async()=>{
  const r=await check();
  assert.equal(r.status,'UNVERIFIED');
  assert.equal(r.provenance,'untrusted_source_fixture');
  assert.equal(r.effectiveElevation,'NOT_PROVEN');
  assert.equal(r.authorized,false);
});
test('signed image UNAVAILABLE, even with status 200: fail closed',async()=>{
  deny(await check({signedImage:async()=>({state:'unavailable'})}),
    'SIGNED_IMAGE_UNAVAILABLE');
});
test('native signer probe omitted: unavailable, never trust owner CORE preference',async()=>{
  const status=await fixture().status!();
  deny(await check({signedImage:undefined,status:async()=>reported<StatusOnly>({
    ...status.value!,requestedCorePreference:true,
  })}),'SIGNED_IMAGE_UNAVAILABLE');
});
test('same PID reused with wrong 64-bit Win32 FILETIME rejects running image',async()=>{
  deny(await check({signedImage:async()=>reported<RunningImage>({
    identity:{...identity,creationFiletime:'134058540000000001'},
    running:true,authenticodeVerified:true,
    pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
  })}),'PID_CREATION_FILETIME_MISMATCH');
});
test('high token PID reused with wrong FILETIME cannot attest original process',async()=>{
  deny(await check({highToken:async()=>reported<HighToken>({
    pid:4321,creationFiletime:'134058540000000003',
    integrity:'high',administratorsEnabled:true,sameProcessTokenVerified:true,
  })}),'TOKEN_PROCESS_FILETIME_MISMATCH');
});
test('untrusted numeric-rounded FILETIME fails strict source identity parsing',async()=>{
  deny(await check({signedImage:async()=>reported<RunningImage>({
    identity:{...identity,creationFiletime:134058540000000000 as unknown as string},
    running:true,authenticodeVerified:true,
    pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
  })}),'UNSIGNED_OR_UNBOUND_IMAGE');
});
test('different handle file ID with equal PID/FILETIME is replacement',async()=>{
  deny(await check({signedImage:async()=>reported<RunningImage>({
    identity:{...identity,fileIdHex:'ff11223344556677'},
    running:true,authenticodeVerified:true,
    pinnedPublisherThumbprint:'b'.repeat(40),identityBoundToOpenHandle:true,
  })}),'RUNNING_FILE_ID_OR_HASH_MISMATCH');
});
test('Authenticode signed image from wrong publisher is untrusted',async()=>{
  deny(await check({signedImage:async()=>reported<RunningImage>({
    identity,running:true,authenticodeVerified:true,
    pinnedPublisherThumbprint:'c'.repeat(40),identityBoundToOpenHandle:true,
  })}),'PUBLISHER_PIN_MISMATCH');
});
test('signed image alone cannot replace medium token',async()=>{
  deny(await check({highToken:async()=>reported<HighToken>({
    pid:4321,creationFiletime:identity.creationFiletime,
    integrity:'medium',administratorsEnabled:false,sameProcessTokenVerified:true,
  })}),'HIGH_TOKEN_UNVERIFIED');
});
test('full signed image but unknown imported/updater ACL blocks',async()=>{
  const v=(await fixture().protectedTree!()).value!;
  deny(await check({protectedTree:async()=>reported<ImageTree>({
    ...v,updaterAndImportsAclProtected:false,
  })}),'FULL_IMPORT_UPDATER_ACL_UNVERIFIED');
});
test('import list self-reported complete but not independently enumerated blocks',async()=>{
  const v=(await fixture().protectedTree!()).value!;
  deny(await check({protectedTree:async()=>reported<ImageTree>({
    ...v,importsIndependentlyEnumerated:false,
  })}),'FULL_IMPORT_UPDATER_ACL_UNVERIFIED');
});
test('low privilege PROCESS_DUP_HANDLE boundary is not optional',async()=>{
  const v=(await fixture().protectedTree!()).value!;
  deny(await check({protectedTree:async()=>reported<ImageTree>({
    ...v,lowPrivilegeDupHandleDenied:false,
  })}),'FULL_IMPORT_UPDATER_ACL_UNVERIFIED');
});
test('unauthenticated HTTP 401 cannot prove signed high token',async()=>{
  const v=(await fixture().status!()).value!;
  deny(await check({status:async()=>reported<StatusOnly>({
    ...v,httpStatus:401,
  })}),'UNAUTHENTICATED_401_NOT_ELEVATION');
});
test('cached 401 + visible consent.exe + CORE preference never grants permission',async()=>{
  const v=(await fixture().status!()).value!;
  deny(await check({status:async()=>reported<StatusOnly>({
    ...v,httpStatus:401,fromCache:true,
    consentExeVisible:true,requestedCorePreference:true,
  })}),'REPLAYED_STATUS_CACHE');
});
test('replayed 401 with wrong status nonce remains uncorrelated',async()=>{
  const v=(await fixture().status!()).value!;
  deny(await check({status:async()=>reported<StatusOnly>({
    ...v,httpStatus:401,fromCache:true,
    requestId:'old-nonce',responseRequestId:'old-nonce',
  })}),'STATUS_REQUEST_UNCORRELATED');
});
test('stale locally cached CORE owner epoch conflicts with external CAS',async()=>{
  const v=(await fixture().ownerGrant!()).value!;
  deny(await check({ownerGrant:async()=>reported<OwnerEpoch>({
    ...v,ownerEpoch:29,generation:11,
  })}),'CACHED_CORE_EPOCH_MISMATCH');
});
test('stale owner epoch timestamp cannot be resuscitated by preference',async()=>{
  const v=(await fixture().ownerGrant!()).value!;
  deny(await check({ownerGrant:async()=>reported<OwnerEpoch>(
    v,now-120000,
  )}),'PROBE_STALE');
});
test('external witness unreachable is no authority, no auto replay',async()=>{
  deny(await check({externalCas:async()=>({state:'unavailable'})}),
    'EXTERNAL_CAS_UNAVAILABLE');
});
test('co-restorable synthetic CAS never counts as independent witness',async()=>{
  const v=(await fixture().externalCas!()).value!;
  deny(await check({externalCas:async()=>reported<ExternalEpoch>({
    ...v,independentlyNonCoRestorable:false,
  })}),'EXTERNAL_WITNESS_UNVERIFIED');
});
test('revoke wins over current locally signed CORE owner epoch',async()=>{
  const v=(await fixture().externalCas!()).value!;
  deny(await check({externalCas:async()=>reported<ExternalEpoch>({
    ...v,revoked:true,
  })}),'EXTERNAL_WITNESS_UNVERIFIED');
});
test('native provider errors are sanitized without leaking tokens',async()=>{
  const r=await check({signedImage:async()=>{throw new Error('HIDDEN_TOKEN_SECRET');}});
  deny(r,'SIGNED_IMAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(r).includes('HIDDEN_TOKEN_SECRET'),false);
});
test('malformed expectations reject before provider execution',async()=>{
  await assert.rejects(()=>check({},{
    ...expect,identity:{...identity,creationFiletime:'-2'},
  }),/INVALID_BROKER_DIAGNOSTIC_EXPECTATION/);
});
