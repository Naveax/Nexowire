import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  guardianKeyEnrollmentSigningBytes,
} from '../src/protocol/guardian-key-enrollment-proof.js';
import {verifyAndConsumeGuardianEnrollmentChallenge} from '../src/product/d1-guardian-enrollment-challenge.js';
import type {D1DatabaseLike} from '../src/product/d1-control-plane-store.js';

const key=generateKeyPairSync('ed25519');
const challenge={
  type:'guardian.key-enrollment-challenge' as const,version:1 as const,
  requestId:'11111111-1111-4111-8111-111111111111',
  deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:'a'.repeat(64),
  nonce:randomBytes(32).toString('base64url'),
  purpose:'bridge-mode-receipts' as const,
  issuedAt:'2026-10-10T15:00:00.000Z',
  expiresAt:'2026-10-10T15:02:00.000Z',
};
function signed() {
  const publicKeySpki=key.publicKey.export({
    format:'der',type:'spki',
  }).toString('base64url');
  return {
    type:'guardian.key-enrollment-proof',version:1,
    challenge,publicKeySpki,
    signature:sign(null,guardianKeyEnrollmentSigningBytes({
      challenge,publicKeySpki,
    }),key.privateKey).toString('base64url'),
  };
}
const ctx=()=>({
  deviceId:challenge.deviceId,ownerAccountId:challenge.ownerAccountId,
  currentCredentialBinding:challenge.credentialBinding,
  ownerApprovedRequestId:challenge.requestId,
  now:new Date('2026-10-10T15:01:00.000Z'),
});

function dbFixture() {
  const state={used:false,calls:0,sql:'',params:[] as unknown[]};
  const db={
    prepare(sql:string) {
      state.sql=sql;
      return {
        bind(...values:unknown[]) {
          state.params=values;
          return this;
        },
        async run() {
          state.calls++;
          if(state.used) return {success:true,meta:{changes:0}};
          state.used=true;
          return {success:true,meta:{changes:1}};
        },
      };
    },
  } as unknown as D1DatabaseLike;
  return {db,state};
}

test('one signed proof can atomically consume a matching current-device challenge only once',async()=>{
  const f=dbFixture();
  const proof=signed();
  const ok=await verifyAndConsumeGuardianEnrollmentChallenge(f.db,proof,ctx());
  assert.equal(ok.possessionVerified,true);
  assert.equal(ok.challengeConsumed,true);
  assert.equal(ok.enrollmentAuthorized,false);
  assert.equal(ok.requestId,challenge.requestId);
  assert.match(ok.publicKeyFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(ok),true);
  assert.equal(f.state.calls,1);
  assert.match(f.state.sql,/UPDATE device_guardian_enrollment_challenges/);
  assert.match(f.state.sql,/d\.credential_hash = device_guardian_enrollment_challenges\.credential_binding/);
  assert.match(f.state.sql,/consumed_at IS NULL/);
  assert.match(f.state.sql,/d\.access_mode = 'full'/);
  assert.match(f.state.sql,/d\.admin_bridge_ready = 1/);
  await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(f.db,proof,ctx()),
    /GUARDIAN_ENROLLMENT_CHALLENGE_EXPIRED_CONSUMED_OR_REPAIRED/);
  assert.equal(f.state.calls,2);
});

test('unapproved request, pairing and owner mismatch cannot consume a challenge',async()=>{
  const proof=signed();
  for(const c of [
    {...ctx(),deviceId:'wrong-device'},
    {...ctx(),ownerAccountId:'wrong-owner'},
    {...ctx(),currentCredentialBinding:'b'.repeat(64)},
    {...ctx(),ownerApprovedRequestId:'22222222-2222-4222-8222-222222222222'},
  ]){
    const f=dbFixture();
    await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(f.db,proof,c));
    assert.equal(f.state.calls,0);
  }
});

test('expired proof or modified signature cannot touch database',async()=>{
  const proof=signed();
  const bad=[
    {...proof,signature:(proof.signature.startsWith('A')?'B':'A')+proof.signature.slice(1)},
    {...proof,challenge:{...proof.challenge,nonce:randomBytes(32).toString('base64url')}},
  ];
  for(const candidate of bad) {
    const f=dbFixture();
    await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(f.db,candidate,ctx()));
    assert.equal(f.state.calls,0);
  }
  const f=dbFixture();
  await assert.rejects(verifyAndConsumeGuardianEnrollmentChallenge(f.db,proof,{
    ...ctx(),now:new Date(challenge.expiresAt),
  }));
  assert.equal(f.state.calls,0);
});

test('migration stores nonce digest and no enrollment signer writes exist',()=>{
  const sql=readFileSync(new URL('../cloudflare/migrations/0018_guardian_enrollment_challenges.sql',import.meta.url),'utf8');
  assert.match(sql,/nonce_hash TEXT NOT NULL/);
  assert.match(sql,/consumed_at TEXT/);
  const src=readFileSync(new URL('../src/product/d1-guardian-enrollment-challenge.ts',import.meta.url),'utf8');
  assert.doesNotMatch(src,/INSERT INTO device_guardian_signing_keys|UPDATE device_guardian_signing_keys/);
});
