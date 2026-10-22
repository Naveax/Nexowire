import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  projectVerifiedCoreUi,nativeUiSigningBytes,externalUiSigningBytes,
  type AccessStatusLike,type NativeRuntimeAssessmentLike,
  type NativeUiReceiptV2,type ExternalUiEpochV2,type UiTrustedPinsV2,
  type UiEvidenceV2,
} from '../src/diagnostics/core-effective-native-cas-ui-gate.js';

const at=new Date('2026-10-21T19:00:00.000Z');
const nkey=generateKeyPairSync('ed25519');
const ckey=generateKeyPairSync('ed25519');
const foreign=generateKeyPairSync('ed25519');
const hash='a'.repeat(64),cred='b'.repeat(64),session='c'.repeat(64);
const owner='owner',device='device',deviceEpoch='de-17',sessionEpoch='se-8';
const nonce='d'.repeat(64);
const access:AccessStatusLike={requestedMode:'CORE',state:'EFFECTIVE',effective:true,
  verifiedNativeHighToken:true,actualElevatedTokenVerified:true,
  brokerSourceAclVerified:true,authoritySource:'independent-protected-windows-broker',
  canDispatch:false};
// This reproduces #700's current output flags even for synthetic all-positive source facts.
const current700:NativeRuntimeAssessmentLike={actualHighIntegrityBrokerAccepted:false,
  productionReady:false,reason:'PRODUCTION_EXECUTOR_NOT_INSTALLED'};
// Hypothetical physically accepted runtime is synthetic only; never observed on #700.
const hypothetical:NativeRuntimeAssessmentLike={actualHighIntegrityBrokerAccepted:true,
  productionReady:true,reason:'SYNTHETIC_ONLY',
  installedBrokerProcessAttested:true,fullTransitiveImportInventoryVerified:true,
  separateLowPrivilegeTokenBoundaryVerified:true,
  protectedJobHandleInheritanceAndDaclVerified:true,
  signedReleaseAndRollbackManifestVerified:true,
  nativeEffectiveLowPrivilegeAccessCheckCompleted:true,
  finalLaunchInstalledHighBrokerReattested:true,
  nativeEffectCommitAtomicVsRevokeVerified:true};
const native:NativeUiReceiptV2={schema:'nexowire.qa.ui.native-effective-v2',
  ownerId:owner,deviceId:device,credentialHash:cred,sessionHash:session,
  deviceEpoch,sessionEpoch,challengeNonce:nonce,ownerEpoch:4,grantGeneration:8,
  brokerImageSha256:hash,brokerVersion:'1.0.5',brokerPid:412,
  creationFiletime:'134041932000000000',volumeSerialHex:'a1b2c3d4',
  fileIdHex:'1111111122222222',observedAt:at.toISOString(),
  highTokenWithEnabledAdministrators:true,protectedPublisherAndRelease:true,
  protectedExeAndAncestorAcl:true,protectedImportAndUpdaterTree:true,
  protectedProcessHandleBoundary:true,authenticatedNativeBroker:true,
  localBootstrapApproved:true};
const cas:ExternalUiEpochV2={schema:'nexowire.qa.ui.external-epoch-v2',
  ownerId:owner,deviceId:device,deviceEpoch,sessionEpoch,challengeNonce:nonce,
  ownerEpoch:4,grantGeneration:8,revoked:false,revoking:false,
  observedAt:at.toISOString()};
const pins:UiTrustedPinsV2={nativeKey:nkey.publicKey,externalCasKey:ckey.publicKey,
  ownerId:owner,deviceId:device,credentialHash:cred,sessionHash:session,
  currentDeviceEpoch:deviceEpoch,currentSessionEpoch:sessionEpoch,
  currentReadbackNonce:nonce,
  installedNativeSignerPhysicallyAccepted:true,
  externalCasMonotonicAuthorityPhysicallyAccepted:true,
  finalExternalCasNativeEffectCommitPhysicallyAccepted:true,
  currentOwnerEpoch:4,currentGrantGeneration:8,installedImageSha256:hash,
  installedVersion:'1.0.5',currentBrokerPid:412,
  currentBrokerCreationFiletime:'134041932000000000',
  currentVolumeSerialHex:'a1b2c3d4',currentFileIdHex:'1111111122222222',now:at};
function signed(b=native,c=cas):UiEvidenceV2{return {
  native:{statement:b,signature:sign(null,nativeUiSigningBytes(b),nkey.privateKey).toString('base64url')},
  external:{statement:c,signature:sign(null,externalUiSigningBytes(c),ckey.privateKey).toString('base64url')},
}}
const evaluate=(a=access,r:NativeRuntimeAssessmentLike|null=current700,
  e:UiEvidenceV2|null=signed(),p=pins)=>projectVerifiedCoreUi(a,r,e,p);
function denied(a=access,r:NativeRuntimeAssessmentLike|null=hypothetical,
  e:UiEvidenceV2|null=signed(),p=pins){
  const result=evaluate(a,r,e,p);
  assert.equal(result.effective,false);
  assert.equal(result.state,'PAUSED_UNVERIFIED');
  assert.equal(result.canDispatch,false);
  assert.equal(result.uacProvenByAppearance,false);
  return result;
}
test('#700 RED/native SOURCE never establishes EFFECTIVE, even with #669 and #702 synthetic claims',()=>{
  assert.equal(denied(access,current700).reason,'NATIVE_RUNTIME_NOT_PHYSICALLY_ACCEPTED');
  assert.equal(denied(access,{...current700,reason:'FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED'}).effective,false);
  assert.equal(denied(access,{...hypothetical,productionReady:false}).effective,false);
  assert.equal(denied(access,{...hypothetical,pendingEffectUnknown:true}).effective,false);
});
test('CORE requested alone, Agent brokerReady, badge, HTTP 401, consent.exe are not authority',()=>{
  const untrusted={...access,state:'PAUSED_UNVERIFIED' as const,effective:false};
  assert.equal(denied(untrusted).reason,'ACCESS_NOT_EFFECTIVE');
  const getter=new Proxy({...untrusted},{get(t,k,r){
    if(['coreBadge','coreEffective','consentExeSeen','brokerHttpStatus','agentBrokerReady'].includes(String(k)))
      throw Error('UNTRUSTED_UI_STATE_READ');
    return Reflect.get(t,k,r);
  }});
  denied(getter);
  denied({...access,actualElevatedTokenVerified:false});
  denied({...access,brokerSourceAclVerified:false});
});
test('reconnect requires signed native+CAS epochs; old signed proof is denied while still fresh',()=>{
  const after={...pins,currentDeviceEpoch:'de-18',currentSessionEpoch:'se-9',now:new Date(at.getTime()+1)};
  assert.equal(denied(access,hypothetical,signed(),after).reason,'SIGNED_NATIVE_OR_CAS_INVALID');
  const b={...native,deviceEpoch:'de-18',sessionEpoch:'se-9',observedAt:after.now.toISOString()};
  const c={...cas,deviceEpoch:'de-18',sessionEpoch:'se-9',observedAt:after.now.toISOString()};
  assert.equal(evaluate(access,hypothetical,signed(b,c),after).state,'EFFECTIVE');
  denied(access,hypothetical,signed(b,cas),after);
  denied(access,hypothetical,signed(native,c),after);
});
test('re-pair old credential, owner session or owner changes invalidate native and CAS evidence',()=>{
  denied(access,hypothetical,signed(),{...pins,credentialHash:'e'.repeat(64)});
  denied(access,hypothetical,signed(),{...pins,sessionHash:'f'.repeat(64)});
  denied(access,hypothetical,signed(),{...pins,ownerId:'other-owner'});
  denied(access,hypothetical,signed(),{...pins,currentOwnerEpoch:5,currentGrantGeneration:9});
});
test('reinstalled or replaced Broker: same version, stale signed SHA/PID/FileTime/fileId fail',()=>{
  denied(access,hypothetical,signed(),{...pins,installedImageSha256:'d'.repeat(64)});
  denied(access,hypothetical,signed(),{...pins,currentBrokerPid:413});
  denied(access,hypothetical,signed(),{...pins,currentBrokerCreationFiletime:'134041933000000000'});
  denied(access,hypothetical,signed(),{...pins,currentFileIdHex:'3333333344444444'});
  denied(access,hypothetical,signed(),{...pins,installedVersion:'1.0.6'});
});
test('independent high token, ancestor+import+updater ACL, publisher, process handle and UAC proof all required',()=>{
  for(const bad of [
    {highTokenWithEnabledAdministrators:false},{protectedPublisherAndRelease:false},
    {protectedExeAndAncestorAcl:false},{protectedImportAndUpdaterTree:false},
    {protectedProcessHandleBoundary:false},{authenticatedNativeBroker:false},
    {localBootstrapApproved:false},
  ])denied(access,hypothetical,signed({...native,...bad}));
});
test('external CAS rollback/revoke/unknown plus foreign signer remain fail-closed',()=>{
  denied(access,hypothetical,signed(native,{...cas,revoked:true}));
  denied(access,hypothetical,signed(native,{...cas,ownerEpoch:3}));
  denied(access,hypothetical,signed(),{...pins,currentGrantGeneration:9});
  denied(access,hypothetical,null);
  denied(access,hypothetical,signed(),{...pins,externalCasKey:foreign.publicKey});
  denied(access,hypothetical,signed(),{...pins,externalCasKey:nkey.publicKey});
});
test('#702 broker_dispatch_permit_v1 is never an external UI-status witness',()=>{
  const foreignSchema={...cas,schema:'broker_dispatch_permit_v1'} as unknown as ExternalUiEpochV2;
  // Even if signed with the CAS key, a one-use effect permit is not UI elevation evidence.
  denied(access,hypothetical,signed(native,foreignSchema));
});
test('positive synthetic pair can only inform status; NEVER authorizes dispatch or appearance-based UAC',()=>{
  const out=evaluate(access,hypothetical);
  assert.equal(out.state,'EFFECTIVE');
  assert.equal(out.canDispatch,false);
  assert.equal(out.uacProvenByAppearance,false);
  assert.equal(evaluate().state,'PAUSED_UNVERIFIED', '#700 native real source currently fails closed');
});

test('#709 current native PID/image-tree source PASS never substitutes physical HIGH token acceptance',()=>{
  const aclSourceOnly={...current700,reason:'PRODUCTION_EXECUTOR_NOT_INSTALLED'};
  assert.equal(denied(access,aclSourceOnly).reason,'NATIVE_RUNTIME_NOT_PHYSICALLY_ACCEPTED');
  assert.equal(denied(access,{...hypothetical,actualHighIntegrityBrokerAccepted:false}).effective,false);
  // Import/updater/source ACL may pass a read-only fixture while physical token is UNKNOWN.
  const treeOnly={...current700,reason:'FULL_PROTECTED_IMPORT_UPDATER_TREE_UNVERIFIED'};
  denied(access,treeOnly);
});
test('native key rotation, forged signed image and independently current signer both fail closed',()=>{
  const receipt=signed();
  denied(access,hypothetical,receipt,{...pins,nativeKey:foreign.publicKey});
  denied(access,hypothetical,receipt,{...pins,nativeKey:ckey.publicKey});
  const tampered={...receipt,native:{...receipt.native,statement:{
    ...receipt.native.statement,brokerImageSha256:'f'.repeat(64),
  }}};
  denied(access,hypothetical,tampered);
  denied(access,hypothetical,signed(),{...pins,currentVolumeSerialHex:'eeeeffff'});
});
test('#719 signed queued CAS readback is not CORE UI witness; 1ms old owner epoch stays denied',()=>{
  const queueReadback={...cas,schema:'nexowire.access.cas-readback.v1'} as unknown as ExternalUiEpochV2;
  // A valid CAS signature over a queued review is still not a native UI status proof.
  assert.equal(denied(access,hypothetical,signed(native,queueReadback)).reason,
    'SIGNED_NATIVE_OR_CAS_INVALID');
  const advanced={...pins,currentOwnerEpoch:5,currentGrantGeneration:9,
    now:new Date(at.getTime()+1)};
  assert.equal(denied(access,hypothetical,signed(),advanced).reason,
    'SIGNED_NATIVE_OR_CAS_INVALID');
  assert.equal(evaluate(access,hypothetical,signed(),pins).canDispatch,false);
});

test('#756 TEMP OS witness cannot promote mocked native flags to installed HIGH / complete import truth',()=>{
  const absent={...hypothetical};
  for(const key of [
    'installedBrokerProcessAttested',
    'fullTransitiveImportInventoryVerified',
    'separateLowPrivilegeTokenBoundaryVerified',
    'protectedJobHandleInheritanceAndDaclVerified',
    'signedReleaseAndRollbackManifestVerified',
    'nativeEffectiveLowPrivilegeAccessCheckCompleted',
  ] as const){
    denied(access,{...absent,[key]:false});
    const unknown={...absent} as Record<string,unknown>;
    delete unknown[key];
    denied(access,unknown as unknown as NativeRuntimeAssessmentLike);
    denied(access,{...absent,[key]:'true'} as unknown as NativeRuntimeAssessmentLike);
  }
});
test('source-green #757 nonce, native signature and #712 CAS cannot replace physical trust anchors',()=>{
  assert.equal(denied(access,hypothetical,signed(),{
    ...pins,installedNativeSignerPhysicallyAccepted:false,
  }).reason,'INDEPENDENT_PHYSICAL_AUTHORITIES_UNVERIFIED');
  assert.equal(denied(access,hypothetical,signed(),{
    ...pins,externalCasMonotonicAuthorityPhysicallyAccepted:false,
  }).reason,'INDEPENDENT_PHYSICAL_AUTHORITIES_UNVERIFIED');
  assert.equal(denied(access,hypothetical,signed(),{
    ...pins,externalCasMonotonicAuthorityPhysicallyAccepted:'true',
  } as unknown as UiTrustedPinsV2).effective,false);
});
test('#757 fresh per-review nonce and in-progress revoke fence stale signed receipt within 1ms',()=>{
  const fresh=new Date(at.getTime()+1);
  const newNonce='e'.repeat(64);
  denied(access,hypothetical,signed(),{...pins,now:fresh,currentReadbackNonce:newNonce});
  denied(access,hypothetical,signed(native,{...cas,revoking:true}));
  denied(access,hypothetical,signed({...native,challengeNonce:newNonce},cas),
    {...pins,currentReadbackNonce:newNonce,now:fresh});
  denied(access,hypothetical,signed(native,{...cas,challengeNonce:newNonce}),
    {...pins,currentReadbackNonce:newNonce,now:fresh});
  const n={...native,challengeNonce:newNonce,observedAt:fresh.toISOString()};
  const c={...cas,challengeNonce:newNonce,observedAt:fresh.toISOString()};
  assert.equal(evaluate(access,hypothetical,signed(n,c),
    {...pins,currentReadbackNonce:newNonce,now:fresh}).state,'EFFECTIVE');
});
test('#753 wrong-type JSON booleans/epochs do not manufacture UI EFFECTIVE',()=>{
  denied(access,hypothetical,signed({...native,localBootstrapApproved:'true'} as unknown as NativeUiReceiptV2));
  denied(access,hypothetical,signed(native,{...cas,revoking:'false'} as unknown as ExternalUiEpochV2));
  denied(access,hypothetical,signed(native,{...cas,ownerEpoch:'4'} as unknown as ExternalUiEpochV2));
  denied(access,hypothetical,signed(),{
    ...pins,currentOwnerEpoch:'4',
  } as unknown as UiTrustedPinsV2);
});

test('#767 source-only FINAL_SOURCE_CANDIDATE_ONLY and read-only CAS cannot promote UI status',()=>{
  const sourceOnly={...hypothetical,
    nativeEffectCommitAtomicVsRevokeVerified:false};
  assert.equal(denied(access,sourceOnly).reason,'NATIVE_ATOMIC_DISPATCH_UNVERIFIED');
  const staleInstalled={...hypothetical,finalLaunchInstalledHighBrokerReattested:false};
  assert.equal(denied(access,staleInstalled).reason,'NATIVE_ATOMIC_DISPATCH_UNVERIFIED');
  const readOnly={...pins,finalExternalCasNativeEffectCommitPhysicallyAccepted:false};
  assert.equal(denied(access,hypothetical,signed(),readOnly).reason,
    'NATIVE_ATOMIC_DISPATCH_UNVERIFIED');
  // A fully signed #767 final grant is a different source-only schema,
  // not a replacement for an independently signed UI-status CAS witness.
  const finalGrantClaim={...cas,
    schema:'nexowire.access.final-native-effect-grant.v1',
  } as unknown as ExternalUiEpochV2;
  assert.equal(denied(access,hypothetical,signed(native,finalGrantClaim)).reason,
    'SIGNED_NATIVE_OR_CAS_INVALID');
  const queuedReview={...cas,
    schema:'nexowire.access.cas-readback.v1',
  } as unknown as ExternalUiEpochV2;
  denied(access,hypothetical,signed(native,queuedReview));
  assert.equal(evaluate(access,hypothetical).canDispatch,false);
});
test('#767 final native commit and CAS fence unavailable or wrong typed is PAUSED even when source-green',()=>{
  for(const key of [
    'finalLaunchInstalledHighBrokerReattested',
    'nativeEffectCommitAtomicVsRevokeVerified',
  ] as const){
    const absent={...hypothetical} as Record<string,unknown>;
    delete absent[key];
    denied(access,absent as unknown as NativeRuntimeAssessmentLike);
    denied(access,{...hypothetical,[key]:'true'} as unknown as NativeRuntimeAssessmentLike);
  }
  const missing={...pins} as Record<string,unknown>;
  delete missing.finalExternalCasNativeEffectCommitPhysicallyAccepted;
  denied(access,hypothetical,signed(),missing as unknown as UiTrustedPinsV2);
  denied(access,hypothetical,signed(),{
    ...pins,finalExternalCasNativeEffectCommitPhysicallyAccepted:1,
  } as unknown as UiTrustedPinsV2);
  denied(access,hypothetical,signed(),{
    ...pins,finalExternalCasNativeEffectCommitPhysicallyAccepted:'true',
  } as unknown as UiTrustedPinsV2);
});
