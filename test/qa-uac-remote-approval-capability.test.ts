import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWindowsUacStatus} from '../src/agent/windows-uac-status.js';
import {explainDeviceAuthorization, type DeviceAuthorizationFacts} from '../src/security/authorization-explain.js';
import {capabilitiesForPlatform, isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {requiredCapabilityForMcpTool} from '../src/mcp/tool-capabilities.js';
import {
  UAC_REMOTE_APPROVAL_MATRIX,
  type BrokerFixture,
} from './fixtures/uac-remote-approval-matrix.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');

/** All data is synthetic. No process, desktop, UAC or privileged RPC is touched. */
function ownerFacts(overrides: Partial<DeviceAuthorizationFacts> = {}): DeviceAuthorizationFacts {
  return {
    deviceId: 'synthetic-win-device',
    ownerAccountId: 'owner-epoch-2',
    requesterAccountId: 'owner-epoch-2',
    requesterRole: 'user',
    accessMode: 'full',
    online: true,
    privilegeMode: 'broker',
    adminBridgeReady: true,
    rootLease: {
      ownerAccountId: 'owner-epoch-2',
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    },
    corePreference: {
      ownerAccountId: 'owner-epoch-2', enabled: true, updatedAt: NOW.toISOString(),
    },
    bridgePreference: {
      ownerAccountId: 'owner-epoch-2', desiredMode: 'on', updatedAt: NOW.toISOString(),
    },
    now: NOW,
    ...overrides,
  };
}

function simulatedBroker(kind: BrokerFixture) {
  if (kind === 'none') return undefined;
  return {
    probe: async () => {
      if (kind === 'probe-error') throw new Error('Synthetic transport failure');
      return { reachable: true, elevated: kind === 'reported-elevated', version: '1.0.5' };
    },
  };
}

test('synthetic local/remote UAC matrix checks the production read-only observer, never grants approval', async t => {
  assert.equal(new Set(UAC_REMOTE_APPROVAL_MATRIX.map(f => f.id)).size, UAC_REMOTE_APPROVAL_MATRIX.length);
  for (const fixture of UAC_REMOTE_APPROVAL_MATRIX) {
    await t.test(fixture.id, async () => {
      const observation = await inspectWindowsUacStatus({
        platform: 'win32',
        accessMode: fixture.accessMode,
        broker: simulatedBroker(fixture.broker),
        consentCount: async () => {
          if (fixture.consent === 'enumeration-error') throw new Error('Synthetic access denied');
          return fixture.consent;
        },
      });
      assert.equal(observation.observation, fixture.expectedObservation);
      assert.equal(observation.recommendedAction, fixture.expectedAction);
      assert.equal(observation.autoClickConsentSupported, false);
      assert.equal(observation.currentSessionOnly, true);
      assert.equal(observation.brokerElevated, fixture.broker === 'reported-elevated');
      assert.ok(!('uacApproved' in observation));
      assert.ok(!('remoteControlApproved' in observation));
      const authorization = explainDeviceAuthorization(
        ownerFacts({accessMode: fixture.accessMode}),
        'windows.task.control',
      );
      // Even a test double reporting an elevated Broker or a remote-assistance UIAccess
      // policy cannot turn a control-plane snapshot into authenticated Windows proof.
      assert.equal(authorization.windows.uacApproval, 'unverified');
      assert.equal(authorization.windows.adminToken, 'unverified');
      assert.equal(authorization.windows.physicalConsoleApproval, 'unverified');
      assert.equal(authorization.adminBridge.authenticatedBrokerHealth, 'unverified');
      assert.equal(authorization.operation.elevatedExecutionProven, false);
      assert.equal(authorization.operation.providerAuthorizationProven, false);
      assert.notEqual(authorization.operation.decision, 'allowed');
      if (fixture.expectedAction === 'use_preapproved_installer_broker') {
        assert.match(observation.message, /preapproved|pre-approved/i);
        assert.notEqual(observation.observation, 'unknown');
      }
    });
  }
});

test('a pending consent process and apparent CORE/ROOT/Broker readiness are NOT an OS grant', async () => {
  const snapshot = await inspectWindowsUacStatus({
    platform: 'win32',
    accessMode: 'full',
    consentCount: async () => 3,
    broker: {probe: async () => ({reachable: true, elevated: true, version: '1.0.5'})},
  });
  assert.equal(snapshot.observation, 'pending');
  assert.equal(snapshot.brokerElevated, true);
  assert.equal(snapshot.autoClickConsentSupported, false);
  const auth = explainDeviceAuthorization(ownerFacts(), 'windows.service.control');
  assert.equal(auth.core.enabled, true);
  assert.equal(auth.core.state, 'PAUSED_UNVERIFIED');
  assert.equal(auth.root.leaseUnexpired, true);
  assert.equal(auth.root.policyActive, false);
  assert.equal(auth.adminBridge.preferenceApplied, false);
  assert.equal(auth.operation.decision, 'not-proven');
  assert.ok(auth.operation.reasons.includes('BROKER_LOCAL_ATTESTATION_REQUIRED'));
  assert.ok(auth.operation.reasons.includes('UAC_APPROVAL_UNVERIFIED'));
});

test('owner re-pair, revoke, SAFE, offline and 15-minute ROOT boundary are fail-closed', () => {
  const ownerChanged = explainDeviceAuthorization(
    ownerFacts({ownerAccountId: 'owner-epoch-3'}), 'windows.task.control',
  );
  assert.equal(ownerChanged.operation.decision, 'denied');
  assert.equal(ownerChanged.core.enabled, false);
  const revoked = explainDeviceAuthorization(ownerFacts({
    corePreference: {ownerAccountId: 'owner-epoch-2', enabled: false, updatedAt: NOW.toISOString()},
    rootLease: null,
  }), 'windows.task.control');
  assert.equal(revoked.core.enabled, false);
  assert.equal(revoked.root.policyActive, false);
  assert.equal(revoked.operation.elevatedExecutionProven, false);
  const safe = explainDeviceAuthorization(ownerFacts({accessMode: 'safe'}), 'windows.task.control');
  assert.equal(safe.operation.decision, 'denied');
  const offline = explainDeviceAuthorization(ownerFacts({online: false}), 'windows.task.control');
  assert.equal(offline.operation.decision, 'denied');
  const rootBoundary = explainDeviceAuthorization(ownerFacts({
    now: new Date(NOW.getTime() + 15 * 60_000),
  }), 'windows.task.control');
  assert.equal(rootBoundary.root.leaseUnexpired, false);
  assert.equal(rootBoundary.root.policyActive, false);
  assert.equal(rootBoundary.operation.elevatedExecutionProven, false);
});

test('unobservable Secure Desktop and lost approval/execute ACK cannot be represented as success', async () => {
  const unseen = await inspectWindowsUacStatus({
    platform: 'win32', accessMode: 'full',
    consentCount: async () => { throw new Error('Synthetic secure desktop access denied'); },
    broker: {probe: async () => ({reachable: true, elevated: true, version: '1.0.5'})},
  });
  assert.equal(unseen.observation, 'unknown');
  assert.equal(unseen.recommendedAction, 'investigate_process_visibility');
  assert.equal(unseen.autoClickConsentSupported, false);
  // The production explanation accepts no UAC completion or mutation ACK input.
  // On an unconfirmed RPC outcome, the caller must reconcile independently, never
  // assert completion or automatically replay a privileged command.
  const unconfirmed = explainDeviceAuthorization(ownerFacts(), 'shell.exec');
  assert.equal(unconfirmed.operation.elevatedExecutionProven, false);
  assert.equal(unconfirmed.windows.uacApproval, 'unverified');
  assert.notEqual(unconfirmed.operation.decision, 'allowed');
});

test('the only UAC capability is an OS-local read-only observation, not remote approval', () => {
  const capabilities = capabilitiesForPlatform('win32');
  assert.ok(capabilities.includes('windows.uac.status'));
  assert.equal(isReadOnlyCapability('windows.uac.status'), true);
  assert.equal(requiredCapabilityForMcpTool('windows_uac_status'), 'windows.uac.status');
  for (const capability of [
    'windows.uac.approve', 'windows.uac.click', 'windows.secure_desktop.input',
    'windows.remote_assistance.approve',
  ]) {
    assert.ok(!capabilities.includes(capability), capability);
  }
});
