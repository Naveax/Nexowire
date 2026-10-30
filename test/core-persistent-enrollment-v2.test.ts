import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {persistentEnrollmentBytes,persistentEnrollmentHash,persistentSessionBytes,persistentSessionChallengeBytes,
  verifyPersistentEnrollmentSession,type PersistentEnrollmentV2,type PersistentSessionV2,
} from '../src/protocol/core-persistent-enrollment-v2.js';

const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const der=key.publicKey.export({format:'der',type:'spki'});
const initial=1700000000000;
function signed<T>(payload:T,bytes:Buffer){return {payload,signatureBase64:
  sign('sha256',bytes,{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};}
function fixture(nowMs=initial+1000){
  const grant:PersistentEnrollmentV2={version:2,algorithm:'ES256-P1363',scope:'physical-console',
    ownerAccountId:'owner-account-0001',ownerSid:'S-1-5-21-100-200-300-1001',deviceId:randomUUID(),
    installationId:randomUUID(),enrollmentId:randomUUID(),machineBindingSha256:'a'.repeat(64),
    issuerSpkiSha256:createHash('sha256').update(der).digest('hex'),generation:1,
    consentedAtMs:initial,expiresAt:null};
  const session:PersistentSessionV2={version:2,enrollmentSha256:persistentEnrollmentHash(grant),
    nonce:randomUUID(),audience:'nexowire.local-enrollment.session',bootId:randomUUID(),
    windowsSessionId:1,ownerSid:grant.ownerSid,logonLuid:'0000000000001234',
    observedAtMs:nowMs,validUntilMs:nowMs+10000};
  return {grant:signed(grant,persistentEnrollmentBytes(grant)),
    session:signed(session,persistentSessionBytes(session)),pinnedSpkiDer:der,nowMs,
    expected:{ownerAccountId:grant.ownerAccountId,ownerSid:grant.ownerSid,deviceId:grant.deviceId,
      installationId:grant.installationId,machineBindingSha256:grant.machineBindingSha256,
      enrollmentId:grant.enrollmentId,generation:1,revoked:false,nonce:session.nonce,
      bootId:session.bootId,windowsSessionId:1,logonLuid:session.logonLuid}};
}
test('old consent remains valid with a fresh witness, never grants dispatch',()=>{
  const f=fixture(initial+10*365*86400000),r=verifyPersistentEnrollmentSession(f);
  assert.equal(r.consentedAtMs,initial);assert.equal(r.expiresAt,null);
  assert.equal(r.mayDispatch,false);assert.ok(Object.isFrozen(r));
});
test('reboot accepts the same signed grant with new boot/session evidence',()=>{
  const f=fixture(),oldGrant=structuredClone(f.grant);
  const bootId=randomUUID(),nonce=randomUUID(),logonLuid='0000000000005678';
  const p={...f.session.payload,bootId,nonce,logonLuid,windowsSessionId:2};
  f.session=signed(p,persistentSessionBytes(p));
  Object.assign(f.expected,{bootId,nonce,logonLuid,windowsSessionId:2});
  verifyPersistentEnrollmentSession(f);assert.deepEqual(f.grant,oldGrant);
});
for(const [field,value] of Object.entries({ownerAccountId:'other-owner',ownerSid:'S-1-5-18',
  deviceId:randomUUID(),installationId:randomUUID(),machineBindingSha256:'b'.repeat(64),
  enrollmentId:randomUUID(),generation:2,revoked:true,nonce:randomUUID(),bootId:randomUUID(),
  windowsSessionId:2,logonLuid:'0000000000009999'})){
  test('reject changed protected expectation: '+field,()=>{
    const f=fixture();Object.assign(f.expected,{[field]:value});
    assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);
  });
}
test('expired and future session, backwards/invalid clock fail closed',()=>{
  for(const clock of [initial,initial+11000,NaN,Infinity,0]){
    const f=fixture();f.nowMs=clock;
    assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);
  }
});
test('tampered signatures, wrong key, unknown fields and v1 downgrade rejected',()=>{
  const mutations=[
    (f:ReturnType<typeof fixture>)=>{f.grant.signatureBase64=Buffer.alloc(64).toString('base64');},
    (f:ReturnType<typeof fixture>)=>{f.session.signatureBase64=f.grant.signatureBase64;},
    (f:ReturnType<typeof fixture>)=>{f.pinnedSpkiDer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'});},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.grant.payload,{extra:true});},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.session.payload,{version:1});},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.grant.payload,{expiresAt:initial+5000});},
  ];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);}
});
test('overlong witness validity and cross-grant session cannot be signed as valid input',()=>{
  const f=fixture();assert.throws(()=>persistentSessionBytes({...f.session.payload,validUntilMs:f.nowMs+30001}));
  const other=fixture();f.session=other.session;
  assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);
});
test('authority challenge and device witness have distinct signature domains',()=>{
  const f=fixture();
  assert.notDeepEqual(persistentSessionChallengeBytes(f.session.payload),persistentSessionBytes(f.session.payload));
  f.session=signed(f.session.payload,persistentSessionChallengeBytes(f.session.payload));
  assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);
});
test('session zero cannot represent physical console enrollment',()=>{
  const f=fixture();
  assert.throws(()=>persistentSessionBytes({...f.session.payload,windowsSessionId:0}));
});
