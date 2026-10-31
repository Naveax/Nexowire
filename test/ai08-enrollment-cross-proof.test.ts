/** AI-08: independently signed cross-enrollment and session-binding negatives.
 * Disposable ECDSA fixture ONLY. Not physical Windows consent, TPM, DPAPI, or
 * an authority granting CORE execution. Never contacts a device or network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  persistentEnrollmentBytes,persistentEnrollmentHash,persistentSessionBytes,
  verifyPersistentEnrollmentSession,
  type PersistentEnrollmentV2,type PersistentSessionV2,
} from '../src/protocol/core-persistent-enrollment-v2.js';

const TIME=1_800_000_000_000;
function fixture(){
  const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=signer.publicKey.export({type:'spki',format:'der'});
  const grant:PersistentEnrollmentV2={
    version:2,algorithm:'ES256-P1363',scope:'physical-console',
    ownerAccountId:'ai08-owner-local',
    ownerSid:'S-1-5-21-101-202-303-1001',
    deviceId:randomUUID(),installationId:randomUUID(),enrollmentId:randomUUID(),
    machineBindingSha256:'a'.repeat(64),
    issuerSpkiSha256:createHash('sha256').update(spki).digest('hex'),
    generation:7,consentedAtMs:TIME-1000,expiresAt:null,
  };
  const session:PersistentSessionV2={
    version:2,enrollmentSha256:persistentEnrollmentHash(grant),
    nonce:randomUUID(),audience:'nexowire.local-enrollment.session',
    bootId:randomUUID(),windowsSessionId:2,ownerSid:grant.ownerSid,
    logonLuid:'000000000000000a',observedAtMs:TIME,
    validUntilMs:TIME+30_000,
  };
  const signature=(bytes:Buffer)=>sign('sha256',bytes,{
    key:signer.privateKey,dsaEncoding:'ieee-p1363',
  }).toString('base64');
  const signedGrant={payload:grant,signatureBase64:signature(persistentEnrollmentBytes(grant))};
  const signedSession={payload:session,signatureBase64:signature(persistentSessionBytes(session))};
  const input={
    grant:signedGrant,session:signedSession,pinnedSpkiDer:spki,
    nowMs:TIME+1000,
    expected:{
      ownerAccountId:grant.ownerAccountId,ownerSid:grant.ownerSid,
      deviceId:grant.deviceId,installationId:grant.installationId,
      machineBindingSha256:grant.machineBindingSha256,
      enrollmentId:grant.enrollmentId,generation:grant.generation,
      revoked:false,nonce:session.nonce,bootId:session.bootId,
      windowsSessionId:session.windowsSessionId,logonLuid:session.logonLuid,
    },
  };
  return {input,signature,signer};
}

test('AI-08: valid grant is not a permit; cross-enrollment session cannot be reused',()=>{
  const a=fixture(),b=fixture();
  assert.equal(verifyPersistentEnrollmentSession(a.input).mayDispatch,false);
  const mixed={...a.input,session:b.input.session};
  assert.throws(()=>verifyPersistentEnrollmentSession(mixed),/V2_REJECTED/,
    'another signed session cannot authorize the current enrollment');
});

test('AI-08: signed wrong enrollment hash is rejected even with the pinned issuer',()=>{
  const f=fixture();
  const session=structuredClone(f.input.session);
  session.payload.enrollmentSha256='f'.repeat(64);
  session.signatureBase64=f.signature(persistentSessionBytes(session.payload));
  assert.throws(()=>verifyPersistentEnrollmentSession({...f.input,session}),
    /V2_REJECTED/,'validly signed but cross-grant session must fail scope binding');
});

test('AI-08: session signed by a different key is denied despite matching scope',()=>{
  const f=fixture(),other=fixture();
  const session=structuredClone(f.input.session);
  session.signatureBase64=other.signature(persistentSessionBytes(session.payload));
  assert.throws(()=>verifyPersistentEnrollmentSession({...f.input,session}),
    /V2_REJECTED/,'correct fields do not substitute for the pinned signer');
});

test('AI-08: stale or wrong pinned signing identity denies a valid enrollment',()=>{
  const f=fixture(),other=fixture();
  assert.throws(()=>verifyPersistentEnrollmentSession({
    ...f.input,pinnedSpkiDer:other.input.pinnedSpkiDer,
  }),/V2_REJECTED/,'a foreign SPKI cannot verify an otherwise valid signed grant');
  const grant=structuredClone(f.input.grant);
  grant.payload.issuerSpkiSha256='b'.repeat(64);
  grant.signatureBase64=f.signature(persistentEnrollmentBytes(grant.payload));
  const session=structuredClone(f.input.session);
  // Keep the proof pair internally coherent. The only remaining failure
  // should be the issuer-SPKI pin, not a stale session enrollment hash.
  session.payload.enrollmentSha256=persistentEnrollmentHash(grant.payload);
  session.signatureBase64=f.signature(persistentSessionBytes(session.payload));
  assert.throws(()=>verifyPersistentEnrollmentSession({...f.input,grant,session}),
    /V2_REJECTED/,'even a valid coherent proof pair may not override issuer pin');
});

test('AI-08: session validity is strict at expiry even for indefinite owner grant',()=>{
  const f=fixture();
  assert.equal(verifyPersistentEnrollmentSession({
    ...f.input,nowMs:f.input.session.payload.validUntilMs-1,
  }).mayDispatch,false);
  assert.throws(()=>verifyPersistentEnrollmentSession({
    ...f.input,nowMs:f.input.session.payload.validUntilMs,
  }),/V2_REJECTED/);
  assert.throws(()=>verifyPersistentEnrollmentSession({
    ...f.input,nowMs:f.input.session.payload.validUntilMs+1,
  }),/V2_REJECTED/);
});

test('AI-08: signed session rebind to foreign logon identity is not accepted',()=>{
  const f=fixture();
  for(const mutation of [
    {windowsSessionId:3},
    {logonLuid:'000000000000000b'},
    {ownerSid:'S-1-5-21-101-202-303-2002'},
  ]){
    const session=structuredClone(f.input.session);
    Object.assign(session.payload,mutation);
    session.signatureBase64=f.signature(persistentSessionBytes(session.payload));
    assert.throws(()=>verifyPersistentEnrollmentSession({...f.input,session}),
      /V2_REJECTED/,'validly signed foreign logon: '+JSON.stringify(mutation));
  }
});
