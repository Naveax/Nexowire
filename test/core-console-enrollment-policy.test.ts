import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {
  canonicalCoreConsoleEnrollment,
  evaluateCoreConsoleEnrollment,
  type CoreConsoleEnrollmentV1,
  type CoreConsoleCurrentReadback,
} from '../src/agent/core-console-enrollment-policy.js';
const {publicKey,privateKey} = generateKeyPairSync('ed25519');
const der = publicKey.export({format:'der',type:'spki'});
const enrollment: CoreConsoleEnrollmentV1 = {
  version:1,scope:'physical-console',
  ownerAccountId:'owner-account-0001',
  deviceId:'naveax-device-0001',
  installationId:'agent-install-0001',
  enrollmentId:'local-consent-0001',
  ownerEpoch:8,grantGeneration:4,revokeEpoch:2,
  approvedLocallyAtMs:1_700_000_000_000,
  issuerSpkiSha256:createHash('sha256').update(der).digest('hex'),
};
const readback: CoreConsoleCurrentReadback = {
  ownerAccountId:enrollment.ownerAccountId,deviceId:enrollment.deviceId,
  installationId:enrollment.installationId,
  ownerEpoch:8,grantGeneration:4,revokeEpoch:2,
  coreEnabled:true,accessMode:'full',deviceOnline:true,bridgeVerified:true,
};
function fixture(){
  return {
    certificate:{
      enrollment,
      signatureBase64:sign(null,canonicalCoreConsoleEnrollment(enrollment),privateKey).toString('base64'),
    },
    pinnedLocalSpkiDer:der as Uint8Array|null,
    trustedCurrentReadback:readback as CoreConsoleCurrentReadback|null,
    requestedOwnerAccountId:enrollment.ownerAccountId,
    requestedDeviceId:enrollment.deviceId,
    requestedInstallationId:enrollment.installationId,
    nowMs:1_800_000_000_000,
    desktop:'default' as const,
  };
}
test('indefinite CORE policy remains ineligible without physical native admission',()=>{
  const e=evaluateCoreConsoleEnrollment(fixture());
  assert.equal(e.duration,'indefinite-revocable');
  assert.equal(e.expiresAt,null);
  assert.equal(e.policyEligible,true);
  assert.equal(e.mayDispatch,false);
});
test('CORE preference alone cannot create on-device enrollment or native permission',()=>{
  for(const patch of [{certificate:null},{pinnedLocalSpkiDer:null},
                      {trustedCurrentReadback:null}]){
    const e=evaluateCoreConsoleEnrollment({...fixture(),...patch});
    assert.equal(e.policyEligible,false);
    assert.equal(e.mayDispatch,false);
    assert.equal(e.reason,'LOCAL_ENROLLMENT_REQUIRED');
  }
});
test('CORE fails closed after SAFE, revoke, new ownerEpoch and missing Broker proof',()=>{
  const altered=[
    {...readback,accessMode:'safe' as const},
    {...readback,coreEnabled:false},
    {...readback,revokeEpoch:3},
    {...readback,ownerEpoch:9},
    {...readback,grantGeneration:5},
    {...readback,bridgeVerified:false},
    {...readback,deviceOnline:false},
  ];
  for(const state of altered){
    const e=evaluateCoreConsoleEnrollment({...fixture(),trustedCurrentReadback:state});
    assert.equal(e.policyEligible,false,JSON.stringify(state));
  }
});
test('CORE never applies to a borrowed device or wrong local installation',()=>{
  for(const patch of [{requestedOwnerAccountId:'another-owner-0001'},
      {requestedDeviceId:'another-device-0001'},
      {requestedInstallationId:'another-install-0001'}]){
    const e=evaluateCoreConsoleEnrollment({...fixture(),...patch});
    assert.equal(e.reason,'OWNER_DEVICE_MISMATCH');
  }
});
test('CORE does not control lock screen, UAC secure desktop or private worker',()=>{
  for(const desktop of ['secure','locked','private','unknown'] as const){
    const e=evaluateCoreConsoleEnrollment({...fixture(),desktop});
    assert.equal(e.reason,'PHYSICAL_DESKTOP_NOT_ALLOWED');
  }
});
test('tampered, forged, or newly selected issuer keys cannot mint CORE authorization',()=>{
  const normal=fixture();
  const modified={...normal.certificate,
    enrollment:{...enrollment,grantGeneration:7}};
  const forged={...normal.certificate,signatureBase64:'A'.repeat(88)};
  const wrongKey=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'});
  for(const patch of [
    {certificate:modified},
    {certificate:forged},
    {pinnedLocalSpkiDer:wrongKey},
  ]){
    const e=evaluateCoreConsoleEnrollment({...normal,...patch});
    assert.equal(e.policyEligible,false);
    assert.equal(e.mayDispatch,false);
  }
});
test('invalid untrusted fields, future local consent and invalid clock fail closed',()=>{
  const normal=fixture();
  const invalid={
    ...enrollment,
    unrecognizedAdminOverride:true,
  };
  const fake={...normal.certificate,enrollment:invalid as CoreConsoleEnrollmentV1};
  for(const patch of [
    {certificate:fake},
    {nowMs:100},
    {nowMs:Number.NaN},
  ]){
    const e=evaluateCoreConsoleEnrollment({...normal,...patch});
    assert.equal(e.policyEligible,false);
  }
});
