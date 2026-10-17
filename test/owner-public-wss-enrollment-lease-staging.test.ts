import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  ProposedOwnerPublicWssEnrollmentLease,
  ProposedEnrolledOwnerQuotaWsSession,
} from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import {
  serializeOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';

const now=1_800_000_000_000;
const keys=generateKeyPairSync('ed25519');
const trusted:TrustedOwnerPublicWssEnrollmentContext={
  operatorId:'test-operator',keyId:'test-operator-key-01',
  operatorPublicKeyPem:keys.publicKey.export({
    format:'pem',type:'spki',
  }).toString(),
  accountId:'acct-7',deviceId:'device-9',
  activeSessionGeneration:14,minimumProfileRevision:9,nowMs:now,
};
const data:SignedOwnerPublicWssEnrollment={
  version:1,operatorId:trusted.operatorId,keyId:trusted.keyId,
  accountId:trusted.accountId,deviceId:trusted.deviceId,
  sessionGeneration:14,profileRevision:9,
  issuedAtMs:now-5_000,expiresAtMs:now+60_000,
  profile:{
    endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
    expectedHostname:'edge.example.com',
    trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
  },
  signature:'',
};
function signed():SignedOwnerPublicWssEnrollment{
  const v={...data,profile:{...data.profile}};
  v.signature=sign(null,serializeOwnerPublicWssEnrollment(v),
    keys.privateKey).toString('base64url');
  return v;
}

test('independent trusted state is freshly read before each request',async()=>{
  let reads=0;
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),async()=>{reads++;return {...trusted}},
  );
  assert.equal(lease.profile.endpoint,data.profile.endpoint);
  await lease.requireCurrent();
  await lease.requireCurrent();
  assert.equal(reads,3);
  lease.invalidate();
  await assert.rejects(lease.requireCurrent(),/invalidated/);
  assert.equal(reads,3);
});

test('session generation revocation invalidates lease permanently',async()=>{
  let epoch=14;
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),async()=>({...trusted,activeSessionGeneration:epoch}),
  );
  await lease.requireCurrent();
  epoch=15;
  await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
  epoch=14;
  await assert.rejects(lease.requireCurrent(),/invalidated/);
});

test('account/device/key/revision changes must fail closed',async()=>{
  for(const changed of [
    {deviceId:'another-device'},
    {accountId:'another-account'},
    {keyId:'rotated-operator-key'},
    {minimumProfileRevision:10},
  ]){
    let state={...trusted};
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      signed(),async()=>state,
    );
    state={...trusted,...changed};
    await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
  }
});

test('expiry and unavailable authority deny old enrollment',async()=>{
  let clock=now;
  let offline=false;
  const reader=async()=>{
    if(offline)throw new Error('owner offline');
    return {...trusted,nowMs:clock};
  };
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),reader,
  );
  await lease.requireCurrent();
  clock=now+60_000;
  await assert.rejects(lease.requireCurrent(),/expired|revoked|unavailable/);
  clock=now;
  await assert.rejects(lease.requireCurrent(),/invalidated/);
  const newLease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),reader,
  );
  offline=true;
  await assert.rejects(newLease.requireCurrent(),/unavailable/);
});

test('tampered initial enrollment cannot start public WSS dial',async()=>{
  const altered=signed();
  altered.profile={...altered.profile,trustedSpkiSha256:['b'.repeat(64)]};
  let reads=0;
  await assert.rejects(ProposedEnrolledOwnerQuotaWsSession.connect(
    altered,async()=>{reads++;return {...trusted}},
  ),/signature/);
  assert.equal(reads,1);
});

test('caller mutation after valid enrollment cannot switch endpoint',async()=>{
  const envelope=signed();
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    envelope,async()=>({...trusted}),
  );
  envelope.profile={
    ...envelope.profile,
    expectedHostname:'wrong.example.com',
    endpoint:'wss://wrong.example.com/internal/owner-quota/v1/outbound',
  };
  envelope.signature='A'.repeat(86);
  assert.equal(lease.profile.endpoint,data.profile.endpoint);
  await lease.requireCurrent();
});
