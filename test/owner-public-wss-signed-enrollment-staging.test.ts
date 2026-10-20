import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  serializeOwnerPublicWssEnrollment,
  verifySignedOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';

const now=1_800_000_000_000;
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const ctx:TrustedOwnerPublicWssEnrollmentContext={
  operatorId:'nexowire-operator',keyId:'operator-key-1',
  operatorPublicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),
  accountId:'account-123',deviceId:'adc90bbb-9576-4b4c-b76a-600e5572ad7d',
  activeSessionGeneration:7,minimumProfileRevision:2,nowMs:now,
};
const unsigned:SignedOwnerPublicWssEnrollment={
  version:1,operatorId:ctx.operatorId,keyId:ctx.keyId,
  accountId:ctx.accountId,deviceId:ctx.deviceId,
  sessionGeneration:7,profileRevision:2,
  issuedAtMs:now-60_000,expiresAtMs:now+30*60_000,
  profile:{
    endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
    expectedHostname:'edge.example.com',
    trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
  },
  signature:'',
};
function enroll(changes:Partial<SignedOwnerPublicWssEnrollment>={}){
  const envelope={...unsigned,...changes};
  envelope.signature=sign(null,serializeOwnerPublicWssEnrollment(envelope),
    privateKey).toString('base64url');
  return envelope;
}

test('Ed25519 binds exact account/device/session and immutable WSS profile',()=>{
  const result=verifySignedOwnerPublicWssEnrollment(enroll(),ctx);
  assert.equal(result.endpoint,unsigned.profile.endpoint);
  assert.equal(result.expectedHostname,'edge.example.com');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.trustedSpkiSha256));
  assert.equal('authorizesToolExecution' in result,false);
});

test('tampered WSS endpoint, SPKI or account rejected',()=>{
  const good=enroll();
  for(const payload of [
    {...good,profile:{...good.profile,endpoint:'wss://evil.example.com/internal/owner-quota/v1/outbound'}},
    {...good,profile:{...good.profile,trustedSpkiSha256:['b'.repeat(64)]}},
    {...good,accountId:'another-account'},
    {...good,signature:'A'.repeat(86)},
  ]){
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(payload,ctx));
  }
});

test('independent account/device/session/key/revision context required',()=>{
  const good=enroll();
  for(const changed of [
    {...ctx,accountId:'other-account'},
    {...ctx,deviceId:'other-device'},
    {...ctx,activeSessionGeneration:8},
    {...ctx,minimumProfileRevision:3},
    {...ctx,keyId:'operator-key-2'},
  ]){
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(good,changed),/mismatch/);
  }
});

test('expiry, excessive TTL, future issue and wrong signing key rejected',()=>{
  for(const payload of [
    enroll({expiresAtMs:now}),
    enroll({expiresAtMs:now+2*24*60*60*1000}),
    enroll({issuedAtMs:now+61_000}),
  ]){
    assert.throws(()=>verifySignedOwnerPublicWssEnrollment(payload,ctx),
      /expired|clock/);
  }
  const alternate=generateKeyPairSync('ed25519');
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(enroll(),{
    ...ctx,operatorPublicKeyPem:alternate.publicKey.export({
      type:'spki',format:'pem',
    }).toString(),
  }),/signature/);
});

test('extra envelope/profile fields, bad signature and non-Ed25519 key denied',()=>{
  const good=enroll();
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
    {...good,authorizesToolExecution:true},ctx),/schema/);
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
    {...good,profile:{...good.profile,redirect:'wss://evil.example.com'}},
    ctx),/trust profile rejected/);
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
    {...good,signature:'not-base64'},ctx),/signature/);
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(enroll(),{
    ...ctx,operatorPublicKeyPem:rsa.publicKey.export({
      type:'spki',format:'pem',
    }).toString(),
  }),/signature/);
});

test('operator receipt rejects alternate base64url spelling of the same signed bytes',()=>{
  const good=enroll();
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const end=alphabet.indexOf(good.signature.at(-1)!);
  const altered=good.signature.slice(0,-1)+alphabet[end^1];
  assert.notEqual(altered,good.signature);
  assert.deepEqual(Buffer.from(altered,'base64url'),Buffer.from(good.signature,'base64url'));
  assert.throws(()=>verifySignedOwnerPublicWssEnrollment(
    {...good,signature:altered},ctx,
  ),/signature encoding/);
});
