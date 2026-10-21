import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainHypervElevation, validHypervVmId,
  type HypervElevationSnapshot,
} from '../src/protocol/hyperv-elevation-evidence.js';

const VM_ID = '3a4b5c6d-7e8f-4091-a2b3-4c5d6e7f8090';

function facts(patch: Partial<HypervElevationSnapshot> = {}): HypervElevationSnapshot {
  return {
    capability: 'hyperv.vm.start',
    deviceId: 'naveax-fixture',
    vmName: 'ReVoltVPN-Ubuntu-Lab',
    vmId: VM_ID,
    agentConnected: true,
    currentProcessElevated: false,
    processIntegrity: 'medium',
    broker: {
      authenticatedHealth: 'unverified',
      elevatedToken: 'unverified',
      versionMatch: 'unverified',
      capabilityAllowed: false,
    },
    ownerPolicyApproved: true,
    localApproval: 'verified',
    dispatch: 'not_sent',
    ...patch,
  };
}

test('#617 medium integrity administrator deny-only is not elevated Broker authority', () => {
  const r = explainHypervElevation(facts());
  assert.equal(r.windows.currentProcessElevated, false);
  assert.equal(r.windows.processIntegrity, 'medium');
  assert.equal(r.execution.status, 'denied');
  assert.equal(r.execution.denialSource, 'windows');
  assert.equal(r.execution.code, 'HYPERV_ELEVATED_TOKEN_UNAVAILABLE');
  assert.equal(r.execution.effectVerified, false);
  assert.equal(r.execution.automaticallyRetryable, false);
});

test('#617 UAC RunAs disconnection is UNKNOWN, never user approval or failed-only', () => {
  const r = explainHypervElevation(facts({
    vmId: null,
    localApproval: 'not_verified',
    dispatch: 'lost_confirmation',
    ownerPolicyApproved: false,
  }));
  assert.equal(r.execution.status, 'unknown');
  assert.equal(r.execution.denialSource, 'undetermined');
  assert.equal(r.execution.effectVerified, false);
  assert.equal(r.execution.automaticallyRetryable, false);
});

test('#617 successful transport ACK is not proven Hyper-V Running state', () => {
  const r = explainHypervElevation(facts({
    currentProcessElevated: true,
    processIntegrity: 'high',
    broker: {
      authenticatedHealth: 'verified',
      elevatedToken: 'verified',
      versionMatch: 'verified',
      capabilityAllowed: true,
    },
    dispatch: 'ack_unverified',
  }));
  assert.equal(r.execution.status, 'unknown');
  assert.equal(r.execution.effectVerified, false);
});

test('#617 CORE/FULL policy alone cannot imply OS elevation or skip local approval', () => {
  const r = explainHypervElevation(facts({
    localApproval: 'pending',
    broker: {
      authenticatedHealth: 'verified',
      elevatedToken: 'verified',
      versionMatch: 'verified',
      capabilityAllowed: true,
    },
  }));
  assert.equal(r.execution.status, 'pending');
  assert.equal(r.execution.code, 'HYPERV_LOCAL_APPROVAL_UNVERIFIED');
  assert.equal(r.execution.effectVerified, false);
});

test('#617 reject arbitrary names and require an exact immutable VMId before any mutation', () => {
  assert.equal(validHypervVmId(VM_ID), true);
  assert.equal(validHypervVmId('ReVoltVPN-Ubuntu-Lab'), false);
  assert.equal(validHypervVmId('*'), false);
  assert.equal(explainHypervElevation(facts({ vmId: null })).execution.code,
    'HYPERV_SCOPED_VM_ID_REQUIRED');
  assert.throws(() => explainHypervElevation(facts({
    vmName: 'ReVoltVPN-Ubuntu-Lab; Start-Process powershell',
  })), /HYPERV_TARGET_INVALID/);
  assert.throws(() => explainHypervElevation(facts({ vmName: 'test*' })),
    /HYPERV_TARGET_INVALID/);
});

test('#617 identity, approval and offline denials have distinct origin fields', () => {
  const deniedPolicy = explainHypervElevation(facts({ ownerPolicyApproved: false }));
  assert.equal(deniedPolicy.execution.denialSource, 'policy');
  const rejected = explainHypervElevation(facts({ localApproval: 'rejected' }));
  assert.equal(rejected.execution.denialSource, 'user');
  const offline = explainHypervElevation(facts({ agentConnected: false }));
  assert.equal(offline.execution.denialSource, 'nexowire');
  for (const e of [deniedPolicy, rejected, offline]) {
    assert.equal(e.execution.status, 'denied');
    assert.equal(e.execution.automaticallyRetryable, false);
  }
});

test('#617 Broker must have authenticated health, version and token attestation together', () => {
  const r = explainHypervElevation(facts({
    currentProcessElevated: null,
    broker: {
      authenticatedHealth: 'verified',
      elevatedToken: 'verified',
      versionMatch: 'failed',
      capabilityAllowed: true,
    },
  }));
  assert.equal(r.execution.status, 'denied');
  assert.equal(r.execution.denialSource, 'nexowire');
  assert.equal(r.execution.code, 'HYPERV_BROKER_NOT_ATTESTED');
});

test('#617 status is diagnostic, never mutating or an execution permit', () => {
  const r = explainHypervElevation(facts({
    capability: 'hyperv.vm.status',
    localApproval: 'not_verified',
    vmId: null,
  }));
  assert.equal(r.windows.elevationRequired, 'unverified');
  // Get-VM can require Hyper-V Administrators membership even for read-only access.
  assert.notEqual(r.execution.status, 'succeeded');
  assert.equal(r.execution.effectVerified, false);
});
