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
function release(overrides: Partial<SignedAgentManifest> = {}, payload = artifact): SignedRelease {
  const manifest: SignedAgentManifest = {
    schemaVersion: 1,
    version,
    sourceSha: 'a'.repeat(40),
    artifactSha256: createHash('sha256').update(payload).digest('hex'),
    publisher: 'Nexowire Test Publisher',
    minAgentVersion: '1.0.4',
    maxAgentVersion: '1.0.6',
    minHubVersion: '1.0.4',
    maxHubVersion: '1.0.8',
    ...overrides,
  };
  const signature = sign(null, canonicalAgentManifest(manifest), keys.privateKey).toString('base64');
  return { manifest, artifact: payload, manifestSignature: signature };
}
function rollbackRelease(): SignedRelease {
  return release({ version: '1.0.5' }, Buffer.from('SIGNED_OLD_AGENT_EXACT_ROLLBACK_BYTES_FIXTURE'));
}
const pinnedCertificate = 'c'.repeat(64);
function trust(): ReleaseTrust {
  return {
    trustedManifestPublicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    trustedPublisher: 'Nexowire Test Publisher',
    trustedCertificateSha256: pinnedCertificate,
    inspectPublisher: async payload => ({
      signatureValid: true,
      publisher: 'Nexowire Test Publisher',
      artifactSha256: createHash('sha256').update(payload).digest('hex'),
      certificateSha256: pinnedCertificate,
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
  authSessionEpoch: 'epoch-123',
  authTokenValid: true,
};
function context(partial: Partial<UpgradeContext> = {}): UpgradeContext {
  return {
    expectedOwnerAccountId: base.ownerAccountId,
    expectedDeviceId: base.deviceId,
    availableBytes: 2_000_000_000,
    minimumFreeBytes: 1_000_000_000,
    userApprovedDisruption: true,
    rollbackRelease: rollbackRelease(),
    ...partial,
  };
}
function adapter(failPhase?: string, mutate?: (runtime: AgentRuntime) => AgentRuntime) {
  const events: string[] = [];
  let activeVersion = base.agentVersion;
  let lock = false;
  const staged: Partial<Record<'target' | 'rollback', Buffer>> = {};
  const failureAt = (value: string) => failPhase === value;
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
      if (events.filter(e => e === 'read').length === 2) {
        if (failPhase === 'stale') return { ...base, ownerAccountId: 'other-owner' };
        if (failPhase === 'token-revoked') return { ...base, authTokenValid: false };
        if (failPhase === 'epoch-changed') return { ...base, authSessionEpoch: 'epoch-456' };
      }
      return { ...base };
    },
    stageRollback: async (bundle, id) => {
      assert.equal(id, base.deviceId);
      events.push('rollback-stage');
      if (failureAt('rollback-stage')) throw new Error('ROLLBACK_DOWNLOAD_FAILED');
      staged.rollback = Buffer.from(bundle.artifact);
    },
    stage: async (bundle, id) => {
      assert.equal(id, base.deviceId);
      events.push('stage');
      if (failureAt('stage')) throw new Error('NETWORK_INTERRUPTED');
      staged.target = Buffer.from(bundle.artifact);
    },
    readStagedBytes: async (id, slot) => {
      assert.equal(id, base.deviceId);
      events.push('hash:' + slot);
      if (failureAt('corrupt-rollback') && slot === 'rollback') return Buffer.from('BROKEN');
      if (failureAt('corrupt-target') && slot === 'target') return Buffer.from('BROKEN');
      if (failureAt('rollback-corrupt-after-stop') && slot === 'rollback' &&
          events.includes('stop')) return Buffer.from('BROKEN');
      return Buffer.from(staged[slot] ?? Buffer.alloc(0));
    },
    stopOwnedAgent: async id => {
      assert.equal(id, base.deviceId);
      events.push('stop');
      if (failPhase === 'stop' && events.filter(e => e === 'stop').length === 1) throw new Error('SERVICE_STOP_FAILED');
    },
    cutover: async (id, next, expectedSha256) => {
      assert.equal(id, base.deviceId);
      events.push('switch:' + next);
      const slot = next === version ? 'target' : 'rollback';
      assert.equal(createHash('sha256').update(staged[slot] ?? Buffer.alloc(0)).digest('hex'),
        expectedSha256);
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
  await assert.rejects(verifyAgentRelease({ ...release(), manifestSignature: 'AA==' }, trust()), /SIGNATURE_ENCODING_INVALID/);
  await assert.rejects(verifyAgentRelease(release(), { ...trust(), trustedPublisher: 'Other Corp' }), /PUBLISHER_MISMATCH/);
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), inspectPublisher: async () => ({ signatureValid: false,
      publisher: 'Nexowire Test Publisher', artifactSha256: digest,
      certificateSha256: pinnedCertificate }),
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
  assert.deepEqual(instance.events, ['lock', 'read', 'rollback-stage', 'hash:rollback',
    'stage', 'hash:target', 'read', 'hash:rollback', 'hash:target',
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
    (r: AgentRuntime) => ({ ...r, authTokenValid: false }),
    (r: AgentRuntime) => ({ ...r, authSessionEpoch: 'reissued' }),
  ]) {
    const instance = adapter(undefined, mutate);
    const result = await upgradeIsolatedAgent(release(), trust(), context(), instance.api);
    assert.equal(result.status, 'rolled_back');
  }
});


test('release verifier rejects wrong pinned Authenticode certificate and wrong key algorithm', async () => {
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), trustedCertificateSha256: 'f'.repeat(64),
  }), /BINARY_SIGNATURE_UNTRUSTED/);
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), inspectPublisher: async () => ({
      signatureValid: true, publisher: 'Nexowire Test Publisher',
      artifactSha256: digest, certificateSha256: 'e'.repeat(64),
    }),
  }), /BINARY_SIGNATURE_UNTRUSTED/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(),
    trustedManifestPublicKeyPem: rsa.publicKey.export({type:'spki',format:'pem'}).toString(),
  }), /MANIFEST_KEY_TYPE_INVALID/);
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), trustedCertificateSha256: 'unverified',
  }), /TRUST_ANCHOR_MISSING/);
});

test('a changed signed manifest cannot re-authorize substituted release bytes', async () => {
  const original = release();
  await assert.rejects(verifyAgentRelease({
    ...original, manifest: { ...original.manifest, publisher:'Other Publisher' },
  }, trust()), /MANIFEST_SIGNATURE_INVALID/);
  await assert.rejects(verifyAgentRelease({
    ...original, manifest: { ...original.manifest, minHubVersion:'1.0.5' },
  }, trust()), /MANIFEST_SIGNATURE_INVALID/);
  await assert.rejects(verifyAgentRelease({
    ...original, manifestSignature: Buffer.alloc(64).toString('base64'),
  }, trust()), /MANIFEST_SIGNATURE_INVALID/);
});

test('signed rollback artifact mandatory; no old signed package means no service stop', async () => {
  for (const changed of [
    { rollbackRelease: undefined as unknown as SignedRelease },
    { rollbackRelease: release({version:'1.0.4'}) },
    { rollbackRelease: release({version:'1.0.5'}) },
    { rollbackRelease: release({version:'1.0.5', minHubVersion:'1.0.6'},
      Buffer.from('OLD_HUB_INCOMPATIBLE')) },
    { rollbackRelease: {...rollbackRelease(), artifact:Buffer.from('BROKEN')} },
  ]) {
    const fixture=adapter();
    await assert.rejects(
      upgradeIsolatedAgent(release(),trust(),context(changed),fixture.api),
      /SIGNED_ROLLBACK_ARTIFACT_REQUIRED|ROLLBACK_IDENTICAL_TO_TARGET|ROLLBACK_VERSION_INCOMPATIBLE|ARTIFACT_HASH_MISMATCH/,
    );
    assert.equal(fixture.events.some(e => e === 'stop'),false);
    assert.equal(fixture.isLocked(),false);
  }
});

test('truncated rollback and target staging are denied before touching live process', async () => {
  for (const phase of ['rollback-stage','corrupt-rollback','corrupt-target']) {
    const fixture=adapter(phase);
    await assert.rejects(
      upgradeIsolatedAgent(release(),trust(),context(),fixture.api),
      /ROLLBACK_DOWNLOAD_FAILED|STAGED_ROLLBACK_HASH_MISMATCH|STAGED_TARGET_HASH_MISMATCH/,
    );
    assert.equal(fixture.events.some(e=>e==='stop'),false);
    assert.equal(fixture.isLocked(),false);
  }
});

test('rollback binary altered after service disruption never runs without valid hash', async () => {
  const fixture=adapter('rollback-corrupt-after-stop',
    runtime=>({...runtime, ownerAccountId:'wrong-owner'}));
  const result=await upgradeIsolatedAgent(release(),trust(),context(),fixture.api);
  assert.equal(result.status,'rollback_unconfirmed');
  assert.ok(fixture.events.includes('switch:1.0.6'));
  assert.ok(!fixture.events.includes('switch:1.0.5'));
  assert.equal(fixture.isLocked(),false);
});

test('token revoke and changed authentication epoch during staging fail before service stop', async () => {
  for(const phase of ['token-revoked','epoch-changed']){
    const fixture=adapter(phase);
    await assert.rejects(
      upgradeIsolatedAgent(release(),trust(),context(),fixture.api),
      /PREFLIGHT_STALE/,
    );
    assert.ok(!fixture.events.includes('stop'));
  }
  await assert.rejects(
    preflightAgentUpgrade(release(),trust(),context(),{
      ...base, authTokenValid:false,
    }),/TOKEN_REVOKED/,
  );
});

test('old Hub outside target signed contract rejects release even if Agent version is valid', async () => {
  const fixture=adapter();
  await assert.rejects(
    upgradeIsolatedAgent(release({minHubVersion:'1.0.6'}),trust(),context(),fixture.api),
    /VERSION_INCOMPATIBLE/,
  );
  assert.ok(!fixture.events.includes('stop'));
});

test('interrupted stage, broken health and failed rollback are distinct in controlled fixture', async () => {
  for(const [phase,expected] of [
    ['stage',null],['health','rolled_back'],['rollback','rollback_unconfirmed'],
  ] as const){
    const fixture=adapter(phase,phase==='rollback'?r=>({...r,deviceId:'attacker'}):undefined);
    if(phase==='stage'){
      await assert.rejects(upgradeIsolatedAgent(release(),trust(),context(),fixture.api),
        /NETWORK_INTERRUPTED/);
    }else{
      const result=await upgradeIsolatedAgent(release(),trust(),context(),fixture.api);
      assert.equal(result.status,expected);
    }
  }
});


test('oversized semver components and publisher inspection outage fail closed', async () => {
  assert.throws(() => canonicalAgentManifest({
    ...release().manifest, version: '9007199254740992.0.0',
  }), /VERSION_INVALID/);
  assert.throws(() => canonicalAgentManifest({
    ...release().manifest, maxHubVersion: '999999999999999999999999999999.0.0',
  }), /VERSION_INVALID/);
  await assert.rejects(verifyAgentRelease(release(), {
    ...trust(), inspectPublisher: async () => {
      throw new Error('PRIVATE_SIGNER_BACKEND_SECRET_DO_NOT_ECHO');
    },
  }), /BINARY_SIGNATURE_UNTRUSTED/);
});
