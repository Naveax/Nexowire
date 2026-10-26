import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {
  guardianKeyEnrollmentSigningBytes,verifyGuardianKeyEnrollmentProof,
} from '../src/protocol/guardian-key-enrollment-proof.js';
import {
  guardianPublicKeyId,signGuardianModeReceipt,verifyGuardianSignedModeReceipt,
} from '../src/protocol/guardian-signed-receipt.js';
import {assessBridgeGuardianReadOnlyInventory} from '../src/agent/bridge-guardian-readonly-observer.js';
import {
  BRIDGE_GUARDIAN_TASK_NAME,BRIDGE_GUARDIAN_POWERSHELL,
  BRIDGE_GUARDIAN_LAUNCHER,BRIDGE_GUARDIAN_SOURCE_ROOT,
} from '../src/agent/bridge-guardian-task-preflight.js';

const keyPair=generateKeyPairSync('ed25519');
const rotated=generateKeyPairSync('ed25519');
const sid='S-1-5-21-100-200-300-1001';
const time='2026-10-20T15:01:00.000Z';
const challenge={
  type:'guardian.key-enrollment-challenge' as const,
  version:1 as const,requestId:'11111111-1111-4111-8111-111111111111',
  deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:'a'.repeat(64),
  nonce:randomBytes(32).toString('base64url'),
  purpose:'bridge-mode-receipts' as const,
  issuedAt:'2026-10-20T15:00:00.000Z',
  expiresAt:'2026-10-20T15:02:00.000Z',
};
const publicKeySpki=keyPair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
const proof={
  type:'guardian.key-enrollment-proof' as const,version:1 as const,
  challenge,publicKeySpki,
  signature:sign(null,guardianKeyEnrollmentSigningBytes({
    challenge,publicKeySpki,
  }),keyPair.privateKey).toString('base64url'),
};
const context=(overrides:Record<string,unknown>={})=>({
  deviceId:challenge.deviceId,ownerAccountId:challenge.ownerAccountId,
  currentCredentialBinding:challenge.credentialBinding,
  ownerApprovedRequestId:challenge.requestId,
  now:new Date(time),hasConsumedChallenge:()=>false,
  ...overrides,
});
function inventory(){
  return {
    auditOnly:true,privilegedOperationPerformed:false,
    installed:true,lookupVerified:true,status:'SNAPSHOT_ONLY',
    currentUserSid:sid,
    snapshot:{
      name:BRIDGE_GUARDIAN_TASK_NAME,taskPath:'\\',state:'Running',
      principal:{userSid:sid,runLevel:'Highest',logonType:'Interactive'},
      actions:[{
        execute:BRIDGE_GUARDIAN_POWERSHELL,
        arguments:'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+BRIDGE_GUARDIAN_LAUNCHER+'"',
        workingDirectory:BRIDGE_GUARDIAN_SOURCE_ROOT,
      }],
      triggers:[{type:'Logon',userSid:sid,enabled:true}],
    },
  };
}

test('valid independently signed challenge and mock source ACL do NOT attest physical Guardian',()=>{
  const possession=verifyGuardianKeyEnrollmentProof(proof,context());
  assert.equal(possession.possessionVerified,true);
  assert.equal(possession.enrollmentAuthorized,false);
  const report=assessBridgeGuardianReadOnlyInventory(JSON.stringify(inventory()),{
    expectedUserSid:sid,
    // Fixture-only callback, never an independent physical ACL authority.
    verifyProtectedSource:()=>{},
  });
  assert.equal(report.status,'source-acl-verified');
  assert.equal(report.sourceAclVerified,true);
  assert.equal(report.hubChannelVerified,false);
  assert.equal(report.remoteActuationAuthorized,false);
  const intent={
    type:'admin-bridge.mode-intent' as const,version:1 as const,
    requestId:challenge.requestId,deviceId:challenge.deviceId,
    ownerAccountId:challenge.ownerAccountId,
    credentialBinding:challenge.credentialBinding,desiredMode:'on' as const,
    issuedAt:challenge.issuedAt,expiresAt:challenge.expiresAt,
  };
  const signed=signGuardianModeReceipt({
    type:'guardian.signed-bridge-receipt',version:1,
    intent,preferenceRevision:'owner-revision-123',
    receipt:{
      type:'admin-bridge.mode-receipt',version:1,
      requestId:intent.requestId,deviceId:intent.deviceId,
      credentialBinding:intent.credentialBinding,desiredMode:intent.desiredMode,
      observedAt:time,result:'applied',taskState:'Running',taskVerified:true,
      brokerHealth:'authenticated-ready',failureCode:null,
    },
    keyId:guardianPublicKeyId(keyPair.publicKey),
  },keyPair.privateKey);
  const verified=verifyGuardianSignedModeReceipt(signed,{
    expectedIntent:intent,currentPreferenceRevision:'owner-revision-123',
    registeredDevicePublicKey:keyPair.publicKey,now:new Date('2026-10-20T15:01:05.000Z'),
  });
  assert.equal(verified.verifiedSignature,true);
  assert.equal(verified.applied,true); // Signed CLAIM in a test, not OS proof.
  assert.equal(possession.enrollmentAuthorized,false);
  assert.equal(report.remoteActuationAuthorized,false);
  assert.equal(report.hubChannelVerified,false);
});

test('independent Guardian trust rejects missing source ACL and revoked pairing/key challenge',()=>{
  const denied=assessBridgeGuardianReadOnlyInventory(JSON.stringify(inventory()),{
    expectedUserSid:sid,
    verifyProtectedSource:()=>{throw new Error('UNTRUSTED_ANCESTOR_MODIFY')},
  });
  assert.equal(denied.status,'task-identity-only');
  assert.equal(denied.sourceAclVerified,false);
  assert.equal(denied.remoteActuationAuthorized,false);
  for(const injected of [
    {currentCredentialBinding:'b'.repeat(64)},
    {ownerAccountId:'other-owner'},
    {deviceId:'other-device'},
    {hasConsumedChallenge:()=>true},
    {now:new Date(challenge.expiresAt)},
  ]){
    assert.throws(()=>verifyGuardianKeyEnrollmentProof(proof,context(injected)));
  }
  const valid=verifyGuardianKeyEnrollmentProof(proof,context());
  assert.notEqual(valid.publicKeyFingerprint,guardianPublicKeyId(rotated.publicKey));
  const report=assessBridgeGuardianReadOnlyInventory(JSON.stringify({
    ...inventory(),status:'ABSENT',installed:false,snapshot:null,
  }),{expectedUserSid:sid});
  assert.equal(report.remoteActuationAuthorized,false);
  assert.equal(report.status,'absent');
});
