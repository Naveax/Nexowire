import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalAgentManifest, inspectAgentHubCompatibility,
  preflightAgentUpgrade, upgradeIsolatedAgent, verifyAgentRelease,
  type AgentRuntime, type SignedAgentManifest, type SignedRelease,
  type ReleaseTrust, type UpgradeAdapter, type UpgradeContext,
} from '../src/update/agent-lifecycle-manager.js';

const keys = generateKeyPairSync('ed25519');
const artifact = Buffer.from('ISOLATED_AGENT_TEST_ARTIFACT_NOT_EXECUTABLE');
const digest = createHash('sha256').update(artifact).digest('hex');
const version = '1.0.6';
function release(overrides: Partial<SignedAgentManifest> = {}): SignedRelease {
  const manifest: SignedAgentManifest = {
    schemaVersion: 1,
    version,
    sourceSha: 'a'.repeat(40),
    artifactSha256: digest,
    publisher: 'Nexowire Test Publisher',
    minAgentVersion: '1.0.4',
    maxAgentVersion: '1.0.6',
    minHubVersion: '1.0.4',
    maxHubVersion: '1.0.8',
    ...overrides,
  };
  const signature = sign(null, canonicalAgentManifest(manifest), keys.privateKey).toString('base64');
  return { manifest, artifact, manifestSignature: signature };
}
function trust(): ReleaseTrust {
  return {
    trustedManifestPublicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    trustedPublisher: 'Nexowire Test Publisher',
    inspectPublisher: async payload => ({
      signatureValid: true,
      publisher: 'Nexowire Test Publisher',
      artifactSha256: createHash('sha256').update(payload).digest('hex'),
    }),
  };
}
const base: AgentRuntime = {
  ownerAccountId: 'owner-1',
  deviceId: 'work-pc-1',
  agentVersion: '1.0.5',
  hubVersion: '1.0.5',
  brokerMode: 'auto',
  coreGrantId: 'core-approved-123',
  privilegeMode: 'core',
};
function context(partial: Partial<UpgradeContext> = {}): UpgradeContext {
  return {
    expectedOwnerAccountId: base.ownerAccountId,
    expectedDeviceId: base.deviceId,
    availableBytes: 2_000_000_000,
    minimumFreeBytes: 1_000_000_000,
    userApprovedDisruption: true,
    ...partial,
  };
}
function adapter(failPhase?: string, mutate?: (runtime: AgentRuntime) => AgentRuntime) {
  const events: string[] = [];
  let activeVersion = base.agentVersion;
  let lock = false;
  const api: UpgradeAdapter = {
    acquireDeviceLock: async id => {
      assert.equal(id, base.deviceId);
      if (lock) throw new Error('LOCK_HELD');
      lock = true;
      events.push('lock');
      return async () => { lock = false; events.push('unlock'); };
    },
    readRuntime: async id => {
      assert.equal(id, base.deviceId);
      events.push('read');
      if (failPhase === 'stale' && events.filter(e => e === 'read').length === 2) {
        return { ...base, ownerAccountId: 'other-owner' };
      }
      return { ...base };
    },
    stage: async (_bundle, id) => {
      assert.equal(id, base.deviceId);
      events.push('stage');
      if (failPhase === 'stage') throw new Error('NETWORK_INTERRUPTED');
    },
    stopOwnedAgent: async id => {
      assert.equal(id, base.deviceId);
      events.push('stop');
      if (failPhase === 'stop' && events.filter(e => e === 'stop').length === 1) throw new Error('SERVICE_STOP_FAILED');
    },
    cutover: async (id, next) => {
      assert.equal(id, base.deviceId);
      events.push('switch:' + next);
      if (failPhase === 'cutover' && next === version) throw new Error('DISK_IO_ERROR');
      activeVersion = next;
    },
    startOwnedAgent: async id => {
      assert.equal(id, base.deviceId);
      events.push('start');
      if (failPhase === 'start' && activeVersion === version) throw new Error('SERVICE_START_FAILED');
    },
    healthyRuntime: async id => {
      assert.equal(id, base.deviceId);
      events.push('health');
      if (failPhase === 'health' && activeVersion === version) return null;
      if (failPhase === 'rollback' && activeVersion === base.agentVersion) return null;
      const runtime = { ...base, agentVersion: activeVersion };
      return mutate && activeVersion === version ? mutate(runtime) : runtime;
    },
  };
  return { api, events, isLocked: () => lock };
}

test('trusted manifest is Ed25519 authenticated, bound to payload SHA-256 and publisher', async () => {
  await verifyAgentRelease(release(), trust());
  await assert.rejects(verifyAgentRelease({ ...release(), artifact: Buffer.from('tampered') }, trust()), /HASH_MISMATCH/);
  await assert.rejects(verifyAgentRelease({ ...release(), manifestSignature: 'AA==' }, trust()), /SIGNATURE_INVALID/);
  await assert.rejects(verifyAgentRelease(release(), { ...trust(), trustedPublisher: 'Other Corp' }), /PUBLISHER_MISMATCH/);
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), inspectPublisher: async () => ({ signatureValid: false,
      publisher: 'Nexowire Test Publisher', artifactSha256: digest }),
  }), /BINARY_SIGNATURE_UNTRUSTED/);
  await assert.rejects(verifyAgentRelease(release(), { ...trust(), trustedManifestPublicKeyPem: '' }), /TRUST_ANCHOR_MISSING/);
});

test('manifest schema and version ranges fail closed on corrupt input', () => {
  assert.throws(() => canonicalAgentManifest({ ...release().manifest, minHubVersion: '9.0.0' }), /MANIFEST_RANGE_INVALID/);
  assert.throws(() => canonicalAgentManifest({ ...release().manifest, version: '../../evil' }), /VERSION_INVALID/);
  assert.throws(() => canonicalAgentManifest({ ...release().manifest, extra: 'injected' } as SignedAgentManifest), /MANIFEST_FIELDS_INVALID/);
});

test('explicit older Agent/newer Hub and newer Agent/older Hub matrix', () => {
  assert.equal(inspectAgentHubCompatibility(release().manifest, base), 'compatible');
  assert.equal(inspectAgentHubCompatibility(release().manifest,
    { ...base, agentVersion: '1.0.4', hubVersion: '1.0.8' }), 'compatible');
  assert.equal(inspectAgentHubCompatibility(release().manifest,
    { ...base, agentVersion: '1.0.7' }), 'agent_unsupported');
  assert.equal(inspectAgentHubCompatibility(release().manifest,
    { ...base, hubVersion: '1.0.3' }), 'hub_unsupported');
});

test('upgrade preflight forbids wrong owner/device, low disk, no consent and replay', async () => {
  for (const [change, error] of [
    [{ expectedOwnerAccountId: 'someone-else' }, /DEVICE_OR_OWNER_MISMATCH/],
    [{ expectedDeviceId: 'naveax' }, /DEVICE_OR_OWNER_MISMATCH/],
    [{ availableBytes: 100 }, /INSUFFICIENT_DISK_SPACE/],
    [{ userApprovedDisruption: false }, /EXPLICIT_APPROVAL_REQUIRED/],
  ] as const) {
    await assert.rejects(preflightAgentUpgrade(release(), trust(), context(change), base), error);
  }
  await assert.rejects(preflightAgentUpgrade(release({ version: '1.0.5' }), trust(), context(), base), /REPLAY_OR_DOWNGRADE/);
});

test('healthy update stays device-scoped and preserves CORE and Admin Bridge state', async () => {
  const instance = adapter();
  const result = await upgradeIsolatedAgent(release(), trust(), context(), instance.api);
  assert.deepEqual(result, { status: 'succeeded', deviceId: base.deviceId,
    fromVersion: '1.0.5', toVersion: '1.0.6' });
  assert.deepEqual(instance.events, ['lock', 'read', 'stage', 'read',
    'stop', 'switch:1.0.6', 'start', 'health', 'unlock']);
  assert.equal(instance.isLocked(), false);
});

test('network failure before disruption does not stop any service', async () => {
  const instance = adapter('stage');
  await assert.rejects(upgradeIsolatedAgent(release(), trust(), context(), instance.api), /NETWORK_INTERRUPTED/);
  assert.equal(instance.events.includes('stop'), false);
  assert.equal(instance.isLocked(), false);
});

test('stale owner/device after staging fails without any process stop', async () => {
  const instance = adapter('stale');
  await assert.rejects(upgradeIsolatedAgent(release(), trust(), context(), instance.api), /PREFLIGHT_STALE/);
  assert.equal(instance.events.includes('stop'), false);
});

for (const fail of ['stop', 'cutover', 'start', 'health']) {
  test('failure at ' + fail + ' rolls back and verifies original runtime', async () => {
    const instance = adapter(fail);
    const result = await upgradeIsolatedAgent(release(), trust(), context(), instance.api);
    assert.equal(result.status, 'rolled_back');
    assert.ok(instance.events.includes('switch:1.0.5'));
    assert.ok(instance.events.includes('health'));
    assert.equal(instance.isLocked(), false);
  });
}

test('a dead rollback health probe is never reported as success', async () => {
  const instance = adapter('rollback', runtime => ({ ...runtime, ownerAccountId: 'hijacked' }));
  const result = await upgradeIsolatedAgent(release(), trust(), context(), instance.api);
  assert.equal(result.status, 'rollback_unconfirmed');
});

test('foreign owner or expanded privilege during cutover triggers rollback', async () => {
  for (const mutate of [
    (r: AgentRuntime) => ({ ...r, ownerAccountId: 'other' }),
    (r: AgentRuntime) => ({ ...r, coreGrantId: 'new-grant' }),
    (r: AgentRuntime) => ({ ...r, brokerMode: 'on' as const }),
    (r: AgentRuntime) => ({ ...r, deviceId: 'naveax' }),
  ]) {
    const instance = adapter(undefined, mutate);
    const result = await upgradeIsolatedAgent(release(), trust(), context(), instance.api);
    assert.equal(result.status, 'rolled_back');
  }
});
