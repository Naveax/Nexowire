import test from 'node:test';
import assert from 'node:assert/strict';
import { explainDeviceAuthorization, type DeviceAuthorizationFacts } from '../src/security/authorization-explain.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
function fact(overrides: Partial<DeviceAuthorizationFacts> = {}): DeviceAuthorizationFacts {
  return {
    deviceId: 'd-one', ownerAccountId: 'owner', requesterAccountId: 'owner', requesterRole: 'user',
    accessMode: 'full', online: true, privilegeMode: 'broker', adminBridgeReady: true,
    rootLease: { ownerAccountId: 'owner', expiresAt: new Date(NOW.getTime() + 900_000).toISOString() },
    corePreference: { ownerAccountId: 'owner', enabled: true, updatedAt: NOW.toISOString() },
    bridgePreference: { ownerAccountId: 'owner', desiredMode: 'on', updatedAt: NOW.toISOString() },
    now: NOW,
    ...overrides,
  };
}

for (const [seconds, unexpired] of [[0, true], [899, true], [900, false], [901, false]] as const) {
  test(`ROOT 15-minute clock boundary +${seconds}s cannot substitute for session/elevated token`, () => {
    const snap = explainDeviceAuthorization(fact({now:new Date(NOW.getTime()+seconds*1000)}), 'windows.service.control');
    assert.equal(snap.root.leaseUnexpired, unexpired);
    assert.equal(snap.root.policyActive, false);
    assert.equal(snap.root.sessionBound, false);
    assert.equal(snap.operation.elevatedExecutionProven, false);
    assert.equal(snap.windows.adminToken, 'unverified');
    assert.equal(snap.windows.uacApproval, 'unverified');
  });
}

test('CORE indefinite preference survives expired ROOT but cannot attest privileged Broker', () => {
  const snap = explainDeviceAuthorization(fact({now:new Date(NOW.getTime()+24*60*60*1000)}), 'windows.registry.set', {hive:'HKLM'});
  assert.equal(snap.root.leaseUnexpired,false);
  assert.equal(snap.core.enabled,true);
  assert.equal(snap.core.state,'PAUSED_UNVERIFIED');
  assert.equal(snap.core.duration,'indefinite-revocable');
  assert.equal(snap.adminBridge.agentReportedReady,true);
  assert.equal(snap.adminBridge.authenticatedBrokerHealth,'unverified');
  assert.equal(snap.adminBridge.preferenceApplied,false);
  assert.equal(snap.operation.privilegeRequirement,'elevated');
  assert.equal(snap.operation.elevatedExecutionProven,false);
});

for (const [label, overrides, reason] of [
  ['SAFE', {accessMode:'safe'}, 'ACCESS_MODE_SAFE'],
  ['offline', {online:false}, 'DEVICE_OFFLINE'],
  ['Broker OFF', {bridgePreference:{ownerAccountId:'owner',desiredMode:'off',updatedAt:NOW.toISOString()}}, 'BROKER_DESIRED_OFF'],
  ['foreign owner', {requesterAccountId:'foreign'}, 'DEVICE_OWNER_MISMATCH'],
] as const) {
  test(`${label} denies elevated operation despite claimed CORE and Broker telemetry`, () => {
    const snap=explainDeviceAuthorization(fact(overrides as Partial<DeviceAuthorizationFacts>),'windows.service.control');
    assert.equal(snap.operation.decision,'denied');
    assert.ok(snap.operation.reasons.includes(reason));
    assert.equal(snap.operation.elevatedExecutionProven,false);
  });
}

test('reported Broker ready does not attest authenticated UAC or physical console approval', () => {
  const snap=explainDeviceAuthorization(fact(), 'windows.task.control');
  assert.equal(snap.adminBridge.agentReportedPrivilegeMode,'broker');
  assert.equal(snap.adminBridge.agentReportedReady,true);
  assert.equal(snap.adminBridge.deviceTaskState,'unverified');
  assert.equal(snap.windows.physicalConsoleApproval,'unverified');
  assert.equal(snap.operation.providerAuthorizationProven,false);
  assert.equal(snap.operation.decision,'not-proven');
});