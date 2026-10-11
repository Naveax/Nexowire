import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  validateAdminBridgeModeIntent,
  verifyAdminBridgeModeReceipt,
  type AdminBridgeModeIntent,
} from '../src/protocol/admin-bridge-intent.js';

const now=new Date('2026-10-10T15:00:00Z');
const digest='a'.repeat(64);
function intent(mode:'auto'|'on'|'off'='auto'):AdminBridgeModeIntent {
  return {
    type:'admin-bridge.mode-intent',version:1,requestId:randomUUID(),
    deviceId:'device-1',ownerAccountId:'owner-1',credentialBinding:digest,
    desiredMode:mode,issuedAt:'2026-10-10T14:59:40Z',
    expiresAt:'2026-10-10T15:01:20Z',
  };
}
const context=()=>({
  deviceId:'device-1',ownerAccountId:'owner-1',credentialBinding:digest,
  now,hasConsumedRequestId:()=>false,
});

function receipt(issued:AdminBridgeModeIntent,result:'applied'|'failed'='applied'){
  return {
    type:'admin-bridge.mode-receipt' as const,
    version:1 as const,requestId:issued.requestId,
    deviceId:issued.deviceId,credentialBinding:digest,
    desiredMode:issued.desiredMode,
    observedAt:'2026-10-10T15:00:10Z',
    result,taskState:issued.desiredMode==='off'?'Disabled':'Running',
    taskVerified:true,
    brokerHealth:issued.desiredMode==='off'?'absent':'authenticated-ready',
    failureCode:result==='failed'?'BROKER_TASK_DENIED':null,
  };
}

test('device owner and current pairing are required before taking a mode intent',()=>{
  const valid=intent('off');
  assert.equal(validateAdminBridgeModeIntent(valid,context()).desiredMode,'off');
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,deviceId:'other'},context()),/BRIDGE_INTENT_IDENTITY_MISMATCH/);
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,ownerAccountId:'other'},context()),/BRIDGE_INTENT_IDENTITY_MISMATCH/);
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,credentialBinding:'b'.repeat(64)},context()),/BRIDGE_INTENT_IDENTITY_MISMATCH/);
  assert.throws(()=>validateAdminBridgeModeIntent(valid,{...context(),credentialBinding:'b'.repeat(64)}),/BRIDGE_INTENT_IDENTITY_MISMATCH/);
});

test('expired, future, overly long and replayed intents are refused',()=>{
  const valid=intent();
  assert.throws(()=>validateAdminBridgeModeIntent(valid,{...context(),now:new Date('2026-10-10T15:01:20Z')}),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,issuedAt:'2026-10-10T15:00:06Z',expiresAt:'2026-10-10T15:01:20Z'},context()),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,expiresAt:'2026-10-10T15:04:00Z'},context()),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,expiresAt:valid.issuedAt},context()),/BRIDGE_INTENT_EXPIRED_OR_INVALID/);
  assert.throws(()=>validateAdminBridgeModeIntent(valid,{...context(),hasConsumedRequestId:()=>true}),/BRIDGE_INTENT_REPLAY/);
});

test('intent parser rejects unexpected fields, bad modes and wrong protocol versions',()=>{
  const valid=intent();
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,capability:'shell.exec'},context()));
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,desiredMode:'uninstall'},context()));
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,version:2},context()));
  assert.throws(()=>validateAdminBridgeModeIntent({...valid,requestId:'not-a-uuid'},context()));
});

test('verified OFF requires disabled scheduler AND absent Broker listener',()=>{
  const valid=intent('off');
  const ok=verifyAdminBridgeModeReceipt(receipt(valid),valid);
  assert.equal(ok.applied,true);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid),taskState:'Running'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid),brokerHealth:'authenticated-ready'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid),brokerHealth:'unverified'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
});

test('ON and AUTO require running task and authenticated Broker health',()=>{
  for (const mode of ['on','auto'] as const){
    const valid=intent(mode);
    assert.equal(verifyAdminBridgeModeReceipt(receipt(valid),valid).applied,true);
    assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid),taskState:'Ready'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
    assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid),brokerHealth:'unverified'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
  }
});

test('stale and wrong-device receipts are never counted as applied',()=>{
  const valid=intent('on');
  const sample=receipt(valid);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,requestId:randomUUID()},valid),/BRIDGE_RECEIPT_IDENTITY_MISMATCH/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,deviceId:'device-2'},valid),/BRIDGE_RECEIPT_IDENTITY_MISMATCH/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,credentialBinding:'b'.repeat(64)},valid),/BRIDGE_RECEIPT_IDENTITY_MISMATCH/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,desiredMode:'off'},valid),/BRIDGE_RECEIPT_IDENTITY_MISMATCH/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,observedAt:'2026-10-10T15:04:00Z'},valid),/BRIDGE_RECEIPT_STALE/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,taskVerified:false},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...sample,failureCode:'IGNORED_ERROR'},valid),/BRIDGE_RECEIPT_UNVERIFIED_POSTCONDITION/);
});

test('applied receipts require observed OS evidence strictly inside intent window',()=>{
  for(const mode of ['off','on','auto'] as const){
    const issued=intent(mode);
    const original=receipt(issued);
    assert.equal(verifyAdminBridgeModeReceipt({
      ...original,observedAt:'2026-10-10T15:01:19.999Z',
    },issued).applied,true);
    for(const bad of [
      '2026-10-10T14:59:35Z',
      '2026-10-10T14:59:39.999Z',
      '2026-10-10T15:01:20Z',
      '2026-10-10T15:01:24.999Z',
    ]){
      assert.throws(()=>verifyAdminBridgeModeReceipt({
        ...original,observedAt:bad,
      },issued),/BRIDGE_RECEIPT_STALE/,mode+' '+bad);
    }
  }
});

test('failure receipts can report after expiry within the existing skew budget',()=>{
  const issued=intent('off');
  assert.equal(verifyAdminBridgeModeReceipt({
    ...receipt(issued,'failed'),observedAt:'2026-10-10T15:01:24.999Z',
  },issued).applied,false);
  assert.throws(()=>verifyAdminBridgeModeReceipt({
    ...receipt(issued,'failed'),observedAt:'2026-10-10T15:01:25.001Z',
  },issued),/BRIDGE_RECEIPT_STALE/);
});

test('receipt verifier rejects invalid intent lifetime even when the receipt itself matches',()=>{
  for(const mode of ['on','off','auto'] as const){
    const source=intent(mode);
    const invalid=[
      {...source,issuedAt:'2026-10-10T14:59:00.000Z',
        expiresAt:'2026-10-10T15:01:00.001Z'},
      {...source,issuedAt:'2026-10-10T15:00:50.000Z',
        expiresAt:'2026-10-10T15:00:50.000Z'},
      {...source,issuedAt:'2026-10-10T15:01:00.000Z',
        expiresAt:'2026-10-10T15:00:00.000Z'},
    ];
    for(const malformed of invalid){
      assert.throws(()=>verifyAdminBridgeModeReceipt(
        receipt(malformed),malformed,
      ),/BRIDGE_RECEIPT_INTENT_WINDOW_INVALID/);
      assert.throws(()=>verifyAdminBridgeModeReceipt(
        receipt(malformed,'failed'),malformed,
      ),/BRIDGE_RECEIPT_INTENT_WINDOW_INVALID/);
    }
  }
});

test('receipt verifier permits exactly 120 seconds of signed intent lifetime',()=>{
  const exactlyBounded={
    ...intent('on'),
    issuedAt:'2026-10-10T14:59:00.000Z',
    expiresAt:'2026-10-10T15:01:00.000Z',
  };
  assert.equal(verifyAdminBridgeModeReceipt(receipt(exactlyBounded),exactlyBounded).applied,true);
});

test('receipt verifier rejects extra unreviewed intent fields before accepting evidence',()=>{
  const source=intent('off');
  const injected={...source,permissionToRun:true};
  assert.throws(()=>verifyAdminBridgeModeReceipt(
    receipt(source),injected,
  ));
});

test('failed receipts remain failed even when task state appears correct',()=>{
  const valid=intent('on');
  assert.equal(verifyAdminBridgeModeReceipt(receipt(valid,'failed'),valid).applied,false);
  assert.throws(()=>verifyAdminBridgeModeReceipt({...receipt(valid,'failed'),failureCode:null},valid),/BRIDGE_RECEIPT_FAILURE_CODE_REQUIRED/);
});
