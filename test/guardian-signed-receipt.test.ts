import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPrivateKey} from 'node:crypto';
import {
  guardianPublicKeyId,
  signGuardianModeReceipt,
  verifyGuardianSignedModeReceipt,
  type GuardianReceiptToSign,
} from '../src/protocol/guardian-signed-receipt.js';

const keys=generateKeyPairSync('ed25519');
const other=generateKeyPairSync('ed25519');
const issuedAt='2026-10-10T15:00:00.000Z';
const expiresAt='2026-10-10T15:02:00.000Z';
const observedAt='2026-10-10T15:01:00.000Z';
const rev='preference-audit-123';

function payload(
  desiredMode:'auto'|'on'|'off'='on',
):GuardianReceiptToSign {
  const requestId='11111111-1111-4111-8111-111111111111';
  const deviceId='device-1',credentialBinding='a'.repeat(64);
  return {
    type:'guardian.signed-bridge-receipt',version:1,
    intent:{
      type:'admin-bridge.mode-intent',version:1,requestId,deviceId,
      ownerAccountId:'owner-1',credentialBinding,desiredMode,
      issuedAt,expiresAt,
    },
    preferenceRevision:rev,
    receipt:{
      type:'admin-bridge.mode-receipt',version:1,
      requestId,deviceId,credentialBinding,desiredMode,observedAt,
      result:'applied',
      taskState:desiredMode==='off'?'Disabled':'Running',
      taskVerified:true,
      brokerHealth:desiredMode==='off'?'absent':'authenticated-ready',
      failureCode:null,
    },
    keyId:guardianPublicKeyId(keys.publicKey),
  };
}

const context=(p=payload())=>({
  expectedIntent:p.intent,
  currentPreferenceRevision:p.preferenceRevision,
  registeredDevicePublicKey:keys.publicKey,
  now:new Date('2026-10-10T15:01:05.000Z'),
});

test('genuine Ed25519 Guardian signature authenticates exact ON and OFF receipt transcripts',()=>{
  for(const mode of ['on','auto','off'] as const){
    const p=payload(mode);
    const envelope=signGuardianModeReceipt(p,keys.privateKey);
    const verified=verifyGuardianSignedModeReceipt(envelope,context(p));
    assert.equal(verified.verifiedSignature,true);
    assert.equal(verified.applied,true);
    assert.equal(verified.requestId,p.intent.requestId);
    assert.equal(verified.keyId,p.keyId);
    assert.match(envelope.signature,/^[A-Za-z0-9_-]{86}$/);
  }
});

test('signature cannot be replayed for a different intent, preference revision or pairing',()=>{
  const p=payload();
  const envelope=signGuardianModeReceipt(p,keys.privateKey);
  const cases=[
    {...context(p),currentPreferenceRevision:'new-preference'},
    {...context(p),expectedIntent:{...p.intent,requestId:'22222222-2222-4222-8222-222222222222'}},
    {...context(p),expectedIntent:{...p.intent,ownerAccountId:'other-owner'}},
    {...context(p),expectedIntent:{...p.intent,credentialBinding:'b'.repeat(64)}},
    {...context(p),expectedIntent:{...p.intent,desiredMode:'off' as const}},
    {...context(p),expectedIntent:{...p.intent,expiresAt:'2026-10-10T15:01:45.000Z'}},
  ];
  for(const ctx of cases){
    assert.throws(()=>verifyGuardianSignedModeReceipt(envelope,ctx),
      /GUARDIAN_RECEIPT_CURRENT_INTENT_OR_REVISION_MISMATCH/);
  }
});

test('device signing key must be registered and a rotated key revokes old receipt',()=>{
  const p=payload();
  const sig=signGuardianModeReceipt(p,keys.privateKey);
  assert.throws(
    ()=>verifyGuardianSignedModeReceipt(sig,{
      ...context(p),registeredDevicePublicKey:other.publicKey,
    }),/GUARDIAN_RECEIPT_UNREGISTERED_KEY/,
  );
  assert.throws(()=>guardianPublicKeyId(keys.privateKey),
    /GUARDIAN_RECEIPT_UNTRUSTED_PUBLIC_KEY_TYPE/);
  assert.throws(()=>signGuardianModeReceipt(p,keys.publicKey),
    /GUARDIAN_RECEIPT_UNTRUSTED_PRIVATE_KEY_TYPE/);
});

test('tampered task, health, failure state, time and signature all fail verification',()=>{
  const p=payload();
  const sig=signGuardianModeReceipt(p,keys.privateKey);
  const tampered=[
    {...sig,receipt:{...sig.receipt,brokerHealth:'unverified'}},
    {...sig,receipt:{...sig.receipt,taskVerified:false}},
    {...sig,receipt:{...sig.receipt,taskState:'Ready'}},
    {...sig,receipt:{...sig.receipt,result:'failed',failureCode:'TASK_FAILED'}},
    {...sig,receipt:{...sig.receipt,observedAt:'2026-10-10T15:01:01.000Z'}},
    {...sig,signature:(sig.signature.startsWith('A')?'B':'A')+sig.signature.slice(1)},
    {...sig,preferenceRevision:'rev-forged'},
  ];
  for(const modified of tampered){
    assert.throws(()=>verifyGuardianSignedModeReceipt(modified,context(p)));
  }
});

test('a signed unverified health postcondition is still NOT an applied receipt',()=>{
  const p=payload();
  const invalid={
    ...p,
    receipt:{...p.receipt,brokerHealth:'unverified' as const},
  };
  const sig=signGuardianModeReceipt(invalid,keys.privateKey);
  assert.throws(()=>verifyGuardianSignedModeReceipt(sig,context(p)),
    /BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
});

test('explicit signed failure is verifiable but never counted as applied',()=>{
  const p=payload();
  const fail={
    ...p,
    receipt:{
      ...p.receipt,result:'failed' as const,
      taskVerified:false,
      brokerHealth:'unverified' as const,
      taskState:'Unknown' as const,
      failureCode:'BROKER_OFFLINE',
    },
  };
  const sig=signGuardianModeReceipt(fail,keys.privateKey);
  const checked=verifyGuardianSignedModeReceipt(sig,context(p));
  assert.equal(checked.verifiedSignature,true);
  assert.equal(checked.applied,false);
});

test('expired, pre-issued, extra-field and malformed signatures fail closed',()=>{
  const p=payload();
  const sig=signGuardianModeReceipt(p,keys.privateKey);
  assert.throws(()=>verifyGuardianSignedModeReceipt(sig,{
    ...context(p),now:new Date(expiresAt),
  }),/GUARDIAN_RECEIPT_EXPIRED/);
  assert.throws(()=>verifyGuardianSignedModeReceipt(sig,{
    ...context(p),now:new Date('2026-10-10T14:59:54.000Z'),
  }),/GUARDIAN_RECEIPT_EXPIRED/);
  assert.throws(()=>verifyGuardianSignedModeReceipt({...sig,secret:'leak'},context(p)));
  assert.throws(()=>verifyGuardianSignedModeReceipt({...sig,signature:'bad'},context(p)));
});

test('signed transcript uses canonical fields rather than arbitrary JSON property order',()=>{
  const p=payload();
  const r=signGuardianModeReceipt(p,keys.privateKey);
  const permutation={
    signature:r.signature,keyId:r.keyId,receipt:r.receipt,
    preferenceRevision:r.preferenceRevision,intent:r.intent,
    version:r.version,type:r.type,
  };
  assert.equal(verifyGuardianSignedModeReceipt(permutation,context(p)).applied,true);
  const badSign=signGuardianModeReceipt({...p,keyId:'b'.repeat(64)},keys.privateKey);
  assert.throws(()=>verifyGuardianSignedModeReceipt(badSign,context(p)),
    /GUARDIAN_RECEIPT_UNREGISTERED_KEY/);
});
