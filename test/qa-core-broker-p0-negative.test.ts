import test from 'node:test';
import assert from 'node:assert/strict';
import {explainDeviceAuthorization,type DeviceAuthorizationFacts} from '../src/security/authorization-explain.js';
import {isPrivilegedBrokerCapability,privilegeRequirement} from '../src/security/privilege.js';

// These are source-only policy and negative admission checks. No privileged
// command, installed Broker, VM, UAC, ACL, service or real desktop is touched.
const NOW=new Date('2026-10-21T13:00:00.000Z');
const tick=(seconds:number)=>new Date(NOW.getTime()+seconds*1000).toISOString();
function facts(overrides:Partial<DeviceAuthorizationFacts>={}):DeviceAuthorizationFacts{
 return {
  deviceId:'qa-device',ownerAccountId:'owner-a',requesterAccountId:'owner-a',
  requesterRole:'user',accessMode:'full',online:true,
  privilegeMode:'broker',adminBridgeReady:true,
  rootLease:{ownerAccountId:'owner-a',expiresAt:tick(600)},
  corePreference:{ownerAccountId:'owner-a',enabled:true,updatedAt:tick(-60)},
  bridgePreference:{ownerAccountId:'owner-a',desiredMode:'on',updatedAt:tick(-60)},
  now:NOW,...overrides,
 };
}
test('P0 CORE owner intent persists independently of expiring ROOT but never impersonates high token',()=>{
 const r=explainDeviceAuthorization(facts({rootLease:null}),'shell.exec');
 assert.equal(r.core.enabled,true);
 assert.equal(r.core.duration,'indefinite-revocable');
 assert.equal(r.core.state,'PAUSED_UNVERIFIED');
 assert.equal(r.root.leaseUnexpired,false);
 assert.equal(r.windows.adminToken,'unverified');
 assert.equal(r.operation.elevatedExecutionProven,false);
});
test('P0 ROOT cannot be granted by another owner, stale login or expired time',()=>{
 const denied=explainDeviceAuthorization(facts({
  requesterAccountId:'foreign-owner',
 }),'shell.exec');
 assert.equal(denied.root.leaseUnexpired,false);
 assert.equal(denied.core.enabled,false);
 assert.equal(denied.operation.decision,'denied');
 const expired=explainDeviceAuthorization(facts({
  rootLease:{ownerAccountId:'owner-a',expiresAt:tick(-1)},
 }),'shell.exec');
 assert.equal(expired.root.leaseUnexpired,false);
 assert.equal(expired.root.policyActive,false);
});
test('P0 CORE revoke/re-pair/safe/device-offline makes entitlement non-effective',()=>{
 const revoked=explainDeviceAuthorization(facts({corePreference:null}),'shell.exec');
 assert.equal(revoked.core.enabled,false);
 const repaired=explainDeviceAuthorization(facts({ownerAccountId:'new-owner'}),'shell.exec');
 assert.equal(repaired.core.enabled,false);
 assert.equal(repaired.operation.decision,'denied');
 const safe=explainDeviceAuthorization(facts({accessMode:'safe'}),'shell.exec');
 assert.equal(safe.core.enabled,false);
 const offline=explainDeviceAuthorization(facts({online:false}),'shell.exec');
 assert.equal(offline.operation.decision,'denied');
});
test('P0 UAC local approval and signed Broker identity cannot be forged by ready telemetry',()=>{
 const r=explainDeviceAuthorization(facts(),'windows.service.control');
 assert.equal(r.adminBridge.agentReportedReady,true);
 assert.equal(r.adminBridge.authenticatedBrokerHealth,'unverified');
 assert.equal(r.adminBridge.preferenceApplied,false);
 assert.equal(r.windows.uacApproval,'unverified');
 assert.equal(r.windows.physicalConsoleApproval,'unverified');
 assert.equal(r.operation.elevatedExecutionProven,false);
});
test('P0 existing standard FULL shell never silently elevates or authorizes unknown VM',()=>{
 assert.equal(privilegeRequirement('shell.exec',{}),'standard');
 assert.equal(isPrivilegedBrokerCapability('shell.exec'),false);
 assert.equal(isPrivilegedBrokerCapability('hyperv.vm.start'),false);
});
test('P0 RED ROOT policy must expire at 15min maximum, never accept oversized stale lease',()=>{
 const r=explainDeviceAuthorization(facts({
  rootLease:{ownerAccountId:'owner-a',expiresAt:tick(901)},
 }),'shell.exec');
 assert.equal(r.root.leaseUnexpired,false,
  'BLOCKED: 15-minute maximum must be enforced from authenticated lease issue time, not only an arbitrary future expiry');
});
test('P0 RED signed CORE Broker executor must be separately privileged and explicit',()=>{
 assert.equal(privilegeRequirement('windows.elevated.shell.exec',{}),'elevated',
  'BLOCKED: CORE is broad real Windows elevated execution, not SAFE alias or service-only allowlist');
});
test('P0 RED approved CORE signed-Broker endpoint must be explicitly registered',()=>{
 assert.equal(isPrivilegedBrokerCapability('windows.elevated.shell.exec'),true,
  'BLOCKED: add explicit authenticated owner/session/epoch-gated elevated executor; never blindly promote generic shell.exec');
});
