import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainDeviceAuthorization, type DeviceAuthorizationFacts } from '../src/security/authorization-explain.js';

const now=new Date('2026-10-18T15:00:00.000Z');
const base:DeviceAuthorizationFacts={
  deviceId:'test-device',ownerAccountId:'owner-a',
  requesterAccountId:'owner-a',requesterRole:'user',
  accessMode:'full',online:true,privilegeMode:'broker',adminBridgeReady:true,
  rootLease:{ownerAccountId:'owner-a',expiresAt:'2026-10-18T15:15:00.000Z'},
  rootSessionAuthorized:true,
  corePreference:{ownerAccountId:'owner-a',enabled:true,updatedAt:now.toISOString()},
  bridgePreference:{ownerAccountId:'owner-a',desiredMode:'on',updatedAt:now.toISOString()},
  now,
};
test('reported ON/OFF mismatch is an explicit non-applied error',()=>{
  const off=explainDeviceAuthorization({...base,
    bridgePreference:{ownerAccountId:'owner-a',desiredMode:'off',updatedAt:now.toISOString()}});
  assert.equal(off.adminBridge.runtimeConsistency,'REPORTED_MISMATCH');
  assert.equal(off.adminBridge.errorCode,'BRIDGE_REPORTED_MODE_MISMATCH');
  assert.equal(off.adminBridge.preferenceApplied,false);
  assert.equal(off.operation.decision,'denied');
  const on=explainDeviceAuthorization({...base,adminBridgeReady:false});
  assert.equal(on.adminBridge.runtimeConsistency,'REPORTED_MISMATCH');
  assert.ok(on.operation.reasons.includes('BRIDGE_REPORTED_MODE_MISMATCH'));
  const auto=explainDeviceAuthorization({...base,
    bridgePreference:{ownerAccountId:'owner-a',desiredMode:'auto',updatedAt:now.toISOString()}});
  assert.equal(auto.adminBridge.runtimeConsistency,'UNVERIFIED');
  assert.equal(auto.adminBridge.preferenceApplied,false);
});
test('session ROOT and durable CORE never prove Windows UAC, physical console, Guardian or upstream admission',()=>{
  const result=explainDeviceAuthorization(base,'windows.service.control');
  assert.equal(result.root.policyActive,true);
  assert.equal(result.root.sessionBound,true);
  assert.equal(result.core.enabled,true);
  assert.equal(result.core.state,'PAUSED_UNVERIFIED');
  assert.equal(result.windows.adminToken,'unverified');
  assert.equal(result.windows.uacApproval,'unverified');
  assert.equal(result.windows.physicalConsoleApproval,'unverified');
  assert.equal(result.adminBridge.deviceTaskState,'unverified');
  assert.equal(result.adminBridge.authenticatedBrokerHealth,'unverified');
  assert.equal(result.operation.elevatedExecutionProven,false);
  assert.equal(result.operation.providerAuthorizationProven,false);
  assert.equal(result.operation.decision,'not-proven');
});
test('owner, service account, revoked CORE and expired ROOT deny or pause as appropriate',()=>{
  const outsiders=[
    {...base,requesterAccountId:'outsider'},
    {...base,requesterRole:'service' as const},
    {...base,ownerAccountId:'transferred-owner'},
    {...base,accessMode:'safe' as const},
    {...base,online:false},
  ];
  for(const input of outsiders){
    const result=explainDeviceAuthorization(input,'windows.service.control');
    assert.equal(result.operation.decision,'denied');
    assert.equal(result.operation.elevatedExecutionProven,false);
    assert.equal(result.root.policyActive,false);
  }
  const expired=explainDeviceAuthorization({...base,now:new Date('2026-10-18T15:15:00.000Z')});
  assert.equal(expired.root.policyActive,false);
  const revoked=explainDeviceAuthorization({...base,rootSessionAuthorized:false,
    corePreference:{ownerAccountId:'owner-a',enabled:false,updatedAt:now.toISOString()}});
  assert.equal(revoked.root.policyActive,false);
  assert.equal(revoked.core.enabled,false);
  assert.equal(revoked.core.state,'OFF');
});
test('browser shows preference/Agent mismatch as error instead of applied task state',()=>{
  const js=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(js,/bridgeReportedMismatch/);
  assert.match(js,/BRIDGE_REPORTED_MODE_MISMATCH/);
  assert.match(js,/Guardian kanıtı yok/);
  assert.doesNotMatch(js,/bridgePreference\.applied\s*=\s*true/);
});
