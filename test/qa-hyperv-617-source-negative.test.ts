import test from 'node:test';
import assert from 'node:assert/strict';
import {explainDeviceAuthorization, type DeviceAuthorizationFacts} from '../src/security/authorization-explain.js';
import {isPrivilegedBrokerCapability, privilegeRequirement} from '../src/security/privilege.js';

const NOW=new Date('2026-10-21T12:00:00.000Z');
function owner(overrides:Partial<DeviceAuthorizationFacts>={}):DeviceAuthorizationFacts{
 return {
  deviceId:'qa-hyperv-device',ownerAccountId:'qa-owner',
  requesterAccountId:'qa-owner',requesterRole:'user',accessMode:'full',
  online:true,privilegeMode:'broker',adminBridgeReady:true,
  rootLease:{ownerAccountId:'qa-owner',expiresAt:'2026-10-21T12:05:00.000Z'},
  corePreference:{ownerAccountId:'qa-owner',enabled:true,updatedAt:NOW.toISOString()},
  bridgePreference:{ownerAccountId:'qa-owner',desiredMode:'on',updatedAt:NOW.toISOString()},
  now:NOW,...overrides,
 };
}
test('#617 policy FULL/ROOT/CORE and Broker telemetry cannot prove admin token',()=>{
 const r=explainDeviceAuthorization(owner(),'hyperv.vm.start');
 assert.equal(r.access.mode,'full');
 assert.equal(r.core.enabled,true);
 assert.equal(r.adminBridge.requestedMode,'on');
 assert.equal(r.adminBridge.preferenceApplied,false);
 assert.equal(r.windows.adminToken,'unverified');
 assert.equal(r.operation.elevatedExecutionProven,false);
 assert.equal(r.operation.decision,'not-proven');
});
test('#617 owner policy deny and bridge OFF cannot authorize VM start',()=>{
 const a=explainDeviceAuthorization(owner({requesterAccountId:'foreign'}),'hyperv.vm.start');
 assert.equal(a.operation.decision,'denied');
 assert.ok(a.operation.reasons.includes('DEVICE_OWNER_MISMATCH'));
 const off=explainDeviceAuthorization(owner({bridgePreference:{
  ownerAccountId:'qa-owner',desiredMode:'off',updatedAt:NOW.toISOString(),
 }}),'hyperv.vm.start');
 assert.equal(off.operation.decision,'denied');
 assert.equal(off.adminBridge.preferenceApplied,false);
});
test('#617 local UAC physical console is unverified even with reported Broker ready',()=>{
 const r=explainDeviceAuthorization(owner(),'windows.service.control');
 assert.equal(r.windows.uacApproval,'unverified');
 assert.equal(r.windows.physicalConsoleApproval,'unverified');
 assert.equal(r.operation.elevatedExecutionProven,false);
 assert.ok(r.operation.reasons.includes('UAC_APPROVAL_UNVERIFIED'));
 assert.ok(r.operation.reasons.includes('PHYSICAL_CONSOLE_GRANT_UNVERIFIED'));
});
test('#617 signed/version-matched Broker cannot be asserted from ready bit or HTTP 401',()=>{
 const r=explainDeviceAuthorization(owner(),'hyperv.vm.start');
 assert.equal(r.adminBridge.agentReportedReady,true);
 assert.equal(r.adminBridge.authenticatedBrokerHealth,'unverified');
 assert.equal(r.adminBridge.deviceTaskState,'unverified');
 assert.equal(r.operation.elevatedExecutionProven,false);
});
test('#617 generic shell.exec may not silently enter elevated Broker',()=>{
 assert.equal(isPrivilegedBrokerCapability('shell.exec'),false);
 assert.equal(isPrivilegedBrokerCapability('powershell.execute'),false);
 assert.equal(isPrivilegedBrokerCapability('hyperv.vm.start'),false,
  'current main must deny unsupported Hyper-V mutation, never shell fallback');
});
test('#617 source P0 RED: typed hyperv.vm.start must not be treated standard',()=>{
 assert.equal(privilegeRequirement('hyperv.vm.start',{}),'elevated',
  'BLOCKED #617: add scoped typed Hyper-V privilege requirement before safe feature release');
});
test('#617 source P0 RED: scoped Hyper-V Broker contract must exist before accepting VM actions',()=>{
 assert.equal(isPrivilegedBrokerCapability('hyperv.vm.start'),true,
  'BLOCKED #617: verified Broker must explicitly allow only typed VM GUID scoped actions');
});
