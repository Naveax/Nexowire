import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {
  guardianKeyEnrollmentSigningBytes,
  verifyGuardianKeyEnrollmentProof,
  type GuardianKeyEnrollmentProof,
  type GuardianEnrollmentProofContext,
} from '../src/protocol/guardian-key-enrollment-proof.js';

const keys=generateKeyPairSync('ed25519');
const other=generateKeyPairSync('ed25519');
const spki=keys.publicKey.export({format:'der',type:'spki'}).toString('base64url');
const requestId='11111111-1111-4111-8111-111111111111';
const challenge={
  type:'guardian.key-enrollment-challenge' as const,
  version:1 as const,requestId,deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:'a'.repeat(64),
  nonce:randomBytes(32).toString('base64url'),
  purpose:'bridge-mode-receipts' as const,
  issuedAt:'2026-10-10T15:00:00.000Z',
  expiresAt:'2026-10-10T15:02:00.000Z',
};
function signed(
  current=challenge,
  publicKeySpki=spki,
  privateKey=keys.privateKey,
):GuardianKeyEnrollmentProof {
  return {
    type:'guardian.key-enrollment-proof',version:1,
    challenge:current,publicKeySpki,
    signature:sign(null,guardianKeyEnrollmentSigningBytes({
      challenge:current,publicKeySpki,
    }),privateKey).toString('base64url'),
  };
}
const context=():GuardianEnrollmentProofContext=>({
  deviceId:'device-1',ownerAccountId:'owner-1',
  currentCredentialBinding:challenge.credentialBinding,
  ownerApprovedRequestId:requestId,
  now:new Date('2026-10-10T15:01:00.000Z'),
  hasConsumedChallenge:()=>false,
});

test('Ed25519 proof binds owner, current paired device, nonce and explicit approved challenge',()=>{
  const proof=signed();
  const checked=verifyGuardianKeyEnrollmentProof(proof,context());
  assert.equal(checked.possessionVerified,true);
  assert.equal(checked.enrollmentAuthorized,false);
  assert.equal(checked.deviceId,'device-1');
  assert.equal(checked.requestId,requestId);
  assert.match(checked.publicKeyFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(checked),true);
});

test('device, owner, pairing and request approval mismatch fail before trust is granted',()=>{
  const p=signed();
  for(const modified of [
    {...context(),deviceId:'other-device'},
    {...context(),ownerAccountId:'other-owner'},
    {...context(),currentCredentialBinding:'b'.repeat(64)},
    {...context(),ownerApprovedRequestId:'22222222-2222-4222-8222-222222222222'},
  ]) {
    assert.throws(()=>verifyGuardianKeyEnrollmentProof(p,modified),
      /GUARDIAN_KEY_PROOF_CURRENT_OWNER_OR_PAIRING_MISMATCH/);
  }
});

test('enrollment challenge requires a bounded canonical lifetime and strong nonce',()=>{
  const p=signed();
  for(const date of [
    new Date('2026-10-10T15:02:00.000Z'),
    new Date('2026-10-10T14:59:54.000Z'),
  ]) {
    assert.throws(()=>verifyGuardianKeyEnrollmentProof(p,{
      ...context(),now:date,
    }),/GUARDIAN_KEY_PROOF_EXPIRED_OR_INVALID/);
  }
  for(const mutated of [
    {...challenge,expiresAt:'2026-10-10T15:04:00.000Z'},
    {...challenge,issuedAt:'2026-10-10T15:00:00Z'},
    {...challenge,nonce:'A'.repeat(43)},
  ]) {
    const proof=signed(mutated);
    assert.throws(()=>verifyGuardianKeyEnrollmentProof(proof,context()));
  }
});

test('replayed one-time challenge must be denied by trusted consumed register',()=>{
  const p=signed();
  assert.throws(()=>verifyGuardianKeyEnrollmentProof(p,{
    ...context(),hasConsumedChallenge:()=>true,
  }),/GUARDIAN_KEY_PROOF_REPLAY/);
});

test('tampered device fields, different public key and wrong private key invalidate signature',()=>{
  const p=signed();
  const mutated=[
    {...p,challenge:{...p.challenge,deviceId:'device-2'}},
    {...p,challenge:{...p.challenge,ownerAccountId:'owner-2'}},
    {...p,challenge:{...p.challenge,nonce:randomBytes(32).toString('base64url')}},
    {...p,publicKeySpki:other.publicKey.export({format:'der',type:'spki'}).toString('base64url')},
    {...p,signature:(p.signature.startsWith('A')?'B':'A')+p.signature.slice(1)},
    {...p,signature:'abc'},
  ];
  for(const candidate of mutated){
    assert.throws(()=>verifyGuardianKeyEnrollmentProof(candidate,context()));
  }
  assert.throws(
    ()=>verifyGuardianKeyEnrollmentProof(signed(challenge,spki,other.privateKey),context()),
    /GUARDIAN_KEY_PROOF_BAD_SIGNATURE/,
  );
});

test('unknown envelope fields, malformed SPKI and unsupported key algorithms fail closed',()=>{
  const p=signed();
  assert.throws(()=>verifyGuardianKeyEnrollmentProof({...p,debugCommand:'shell.exec'},context()));
  assert.throws(()=>verifyGuardianKeyEnrollmentProof({...p,publicKeySpki:'A'.repeat(70)},context()));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(
    ()=>verifyGuardianKeyEnrollmentProof(signed(
      challenge,rsa.publicKey.export({format:'der',type:'spki'}).toString('base64url'),
      rsa.privateKey,
    ),context()),
  );
});

test('proof contains no private key material and cannot authorize enrollment itself',()=>{
  const p=signed();
  assert.deepEqual(Object.keys(p).sort(),[
    'challenge','publicKeySpki','signature','type','version',
  ]);
  const result=verifyGuardianKeyEnrollmentProof(p,context());
  assert.equal(result.enrollmentAuthorized,false);
});
