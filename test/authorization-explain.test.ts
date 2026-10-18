import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService, type ControlPlaneIdentity } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';
import { explainDeviceAuthorization, type DeviceAuthorizationFacts } from '../src/security/authorization-explain.js';

const NOW = new Date('2026-10-18T14:00:00.000Z');

function facts(overrides: Partial<DeviceAuthorizationFacts> = {}): DeviceAuthorizationFacts {
  return {
    deviceId: 'machine-1', ownerAccountId: 'account-1',
    requesterAccountId: 'account-1', requesterRole: 'user',
    accessMode: 'full', online: true, privilegeMode: 'broker',
    adminBridgeReady: true,
    rootLease: {
      ownerAccountId: 'account-1',
      expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    },
    corePreference: {ownerAccountId: 'account-1', enabled: true, updatedAt: NOW.toISOString()},
    bridgePreference: {ownerAccountId: 'account-1', desiredMode: 'on', updatedAt: NOW.toISOString()},
    now: NOW, ...overrides,
  };
}

test('FULL, ROOT, CORE and reported Broker are distinct from verified OS elevation', () => {
  const result = explainDeviceAuthorization(facts(), 'windows.service.control');
  assert.equal(result.version, 1);
  assert.equal(result.access.mode, 'full');
  assert.equal(result.root.leaseUnexpired, true);
  assert.equal(result.root.policyActive, false); // logout binding is not implemented
  assert.equal(result.root.sessionBound, false);
  assert.equal(result.core.enabled, true);
  assert.equal(result.core.duration, 'indefinite-revocable');
  assert.equal(result.core.state, 'PAUSED_UNVERIFIED');
  assert.equal(result.adminBridge.requestedMode, 'on');
  assert.equal(result.adminBridge.agentReportedReady, true);
  assert.equal(result.adminBridge.preferenceApplied, false);
  assert.equal(result.adminBridge.deviceTaskState, 'unverified');
  assert.equal(result.adminBridge.authenticatedBrokerHealth, 'unverified');
  assert.equal(result.windows.adminToken, 'unverified');
  assert.equal(result.windows.uacApproval, 'unverified');
  assert.equal(result.windows.physicalConsoleApproval, 'unverified');
  assert.equal(result.operation.privilegeRequirement, 'elevated');
  assert.equal(result.operation.decision, 'not-proven');
  assert.equal(result.operation.elevatedExecutionProven, false);
  assert.equal(result.operation.providerAuthorizationProven, false);
});

test('expired lease, restart/snapshot reuse and CORE without expiry never revive privilege', () => {
  const initial = facts();
  const expired = explainDeviceAuthorization({
    ...initial, now: new Date(NOW.getTime() + 31_000),
  });
  assert.equal(expired.root.policyActive, false);
  assert.equal(expired.root.leaseUnexpired, false);
  assert.equal(expired.root.expiresAt, null);
  assert.equal(expired.core.enabled, true);
  assert.equal(expired.operation.elevatedExecutionProven, false);
  const reboot = explainDeviceAuthorization(facts({online:false}));
  assert.equal(reboot.root.policyActive, false);
  assert.equal(reboot.core.state, 'PAUSED_UNVERIFIED');
  assert.equal(reboot.operation.decision, 'denied');
  assert.ok(reboot.operation.reasons.includes('DEVICE_OFFLINE'));
});

test('owner transfer, mismatched CORE/ROOT owners and service impersonation fail closed', () => {
  const switched = explainDeviceAuthorization(facts({
    ownerAccountId: 'new-owner', requesterAccountId: 'new-owner',
  }));
  assert.equal(switched.core.enabled, false);
  assert.equal(switched.root.policyActive, false);
  assert.equal(switched.core.updatedAt, null);
  const outsider = explainDeviceAuthorization(facts({requesterAccountId:'attacker'}));
  assert.equal(outsider.operation.decision, 'denied');
  assert.ok(outsider.operation.reasons.includes('DEVICE_OWNER_MISMATCH'));
  const service = explainDeviceAuthorization(facts({requesterRole:'service'}));
  assert.equal(service.operation.decision, 'denied');
  assert.ok(service.operation.reasons.includes('OWNER_IDENTITY_REQUIRED'));
});

test('SAFE, broker OFF and forged ready telemetry never claim applied work', () => {
  const safe = explainDeviceAuthorization(facts({accessMode:'safe'}));
  assert.equal(safe.root.policyActive,false);
  assert.equal(safe.core.enabled,false);
  assert.equal(safe.operation.decision,'denied');
  const off = explainDeviceAuthorization(facts({
    bridgePreference:{ownerAccountId:'account-1',desiredMode:'off',updatedAt:NOW.toISOString()},
  }));
  assert.equal(off.operation.decision,'denied');
  assert.equal(off.adminBridge.preferenceApplied,false);
  const telemetryLost = explainDeviceAuthorization(facts({adminBridgeReady:false}));
  assert.equal(telemetryLost.operation.decision,'not-proven');
  assert.ok(telemetryLost.operation.reasons.includes('BROKER_AGENT_TELEMETRY_NOT_READY'));
  assert.equal(telemetryLost.operation.elevatedExecutionProven,false);
});

test('owner-only HTTP endpoint reveals no other device, credentials or imaginary token proof',async()=>{
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store,{now:()=>NOW});
  const owner:ControlPlaneIdentity={accountId:'owner-exp',role:'user'};
  const other:ControlPlaneIdentity={accountId:'other-exp',role:'user'};
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:other.accountId});
  const pairing=await service.beginPairing(owner,'mine');
  const {device}=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  });
  await assert.rejects(
    service.setDeviceAccessMode({...owner,role:'service'},device.id,'full'),
    /OWNER_LOGIN_REQUIRED/,
  );
  await service.setDeviceAccessMode(owner,device.id,'full');
  await service.setDevicePresence(device.id,true,NOW.toISOString(),{privilegeMode:'broker',adminBridgeReady:true});
  const handler=createControlPlaneHttpHandler(service,{
    authenticate:async(request)=>{
      const token=request.headers.get('x-dev-identity');
      return token?JSON.parse(token) as ControlPlaneIdentity:null;
    },
  });
  const url='https://example.test/api/v1/me/devices/authorization-explain?deviceId='+device.id+'&capability=windows.task.control';
  const req=(identity:ControlPlaneIdentity|null,urlValue=url)=>new Request(urlValue,{
    headers:identity?{'x-dev-identity':JSON.stringify(identity)}:{},
  });
  assert.equal((await handler(req(null))).status,401);
  assert.equal((await handler(req(other))).status,404);
  assert.equal((await handler(req({...owner,role:'service'}))).status,403);
  const ok=await handler(req(owner));
  assert.equal(ok.status,200);
  assert.equal(ok.headers.get('cache-control'),'no-store');
  const result=await ok.json() as {operation:{privilegeRequirement:string;elevatedExecutionProven:boolean};adminBridge:{preferenceApplied:boolean}};
  assert.equal(result.operation.privilegeRequirement,'elevated');
  assert.equal(result.operation.elevatedExecutionProven,false);
  assert.equal(result.adminBridge.preferenceApplied,false);
  assert.equal((await handler(req(owner,url.replace('windows.task.control','bad!')))).status,400);
});

test('registry and per-user changes are classified from capability and input, not CORE',()=>{
  const machine=explainDeviceAuthorization(facts(),'windows.registry.set',{hive:'HKLM'});
  const user=explainDeviceAuthorization(facts(),'windows.registry.set',{hive:'HKCU'});
  assert.equal(machine.operation.privilegeRequirement,'elevated');
  assert.equal(user.operation.privilegeRequirement,'standard');
  assert.equal(user.operation.elevatedExecutionProven,false);
});
