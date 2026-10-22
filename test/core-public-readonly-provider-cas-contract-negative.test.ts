import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService, type ControlPlaneIdentity } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

/**
 * #10 intentionally RED source-contract witness.
 *
 * The public read-only response is already fail-closed. This test targets
 * a NEW absence in its machine-readable reasons: "native provider absent"
 * is not the same thing as "an installed, signed HIGH Broker is attested",
 * and neither proves a real independent CAS dispatch authorization.
 *
 * This test makes NO request to a real Broker or machine. When the #04 /
 * public API owner selects stable reason names, reconcile the three
 * semantic codes here without weakening the fail-closed predicates.
 */
test('public CORE explanation explicitly distinguishes unavailable native provider, installed HIGH evidence and independent CAS dispatch', async () => {
  const now = new Date('2026-10-22T12:00:00.000Z');
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, { now: () => now });
  const owner: ControlPlaneIdentity = { accountId: 'qa10-owner', role: 'user' };
  await service.ensureAccount({ id: owner.accountId });

  const pairing = await service.beginPairing(owner, 'qa10-disposable-device');
  const { device } = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: 'a'.repeat(64),
  });

  await service.setDeviceAccessMode(owner, device.id, 'full');
  await service.setDevicePresence(device.id, true, now.toISOString(), {
    privilegeMode: 'broker',
    adminBridgeReady: true,
  });
  await service.setDeviceBridgePreference(owner, device.id, 'on');
  await service.setDeviceCorePreference(owner, device.id, true);

  // Public OWNER-ONLY, READ-ONLY route, entirely in an in-memory test store.
  // We deliberately do NOT register any native image/token/CAS provider.
  const handler = createControlPlaneHttpHandler(service, {
    authenticate: async req => {
      const raw = req.headers.get('x-dev-identity');
      return raw ? JSON.parse(raw) as ControlPlaneIdentity : null;
    },
  });
  const response = await handler(new Request(
    'https://example.test/api/v1/me/devices/authorization-explain' +
      '?deviceId=' + encodeURIComponent(device.id) +
      '&capability=windows.service.control',
    { headers: { 'x-dev-identity': JSON.stringify(owner) } },
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const readout = await response.json() as {
    core: { enabled: boolean; state: string };
    adminBridge: { requestedMode: string; agentReportedReady: boolean; preferenceApplied: boolean };
    windows: { adminToken: string };
    operation: {
      elevatedExecutionProven: boolean;
      providerAuthorizationProven: boolean;
      decision: string;
      reasons: string[];
    };
  };

  // Existing public safety behavior MUST stay unchanged.
  assert.equal(readout.core.enabled, true); // Owner's REQUESTED preference only
  assert.equal(readout.core.state, 'PAUSED_UNVERIFIED');
  assert.equal(readout.adminBridge.requestedMode, 'on');
  assert.equal(readout.adminBridge.agentReportedReady, true);
  assert.equal(readout.adminBridge.preferenceApplied, false);
  assert.equal(readout.windows.adminToken, 'unverified');
  assert.equal(readout.operation.decision, 'not-proven');
  assert.equal(readout.operation.elevatedExecutionProven, false);
  assert.equal(readout.operation.providerAuthorizationProven, false);

  // MISSING PUBLIC STATUS/ERROR CONTRACT: the existing generic
  // WINDOWS_ADMIN_TOKEN_UNVERIFIED cannot tell these three *distinct*
  // evidence failures apart. Source-only #733 can, but this public
  // endpoint currently has no separate machine-readable reasons.
  const requiredDistinctReasons = [
    'BROKER_NATIVE_PROVIDER_UNAVAILABLE',
    'INSTALLED_HIGH_BROKER_NOT_ATTESTED',
    'INDEPENDENT_CAS_DISPATCH_UNVERIFIED',
  ];
  const missing = requiredDistinctReasons.filter(
    reason => !readout.operation.reasons.includes(reason),
  );
  assert.deepEqual(missing, [],
    'PUBLIC_CORE_STATUS_CONTRACT_GAP: add independent absent-provider / ' +
    'installed-high-token / external-CAS-dispatch reasons; never imply EFFECTIVE');
});
