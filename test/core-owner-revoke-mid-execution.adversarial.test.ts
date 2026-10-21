import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * Worker #25, SOURCE-ONLY adversarial acceptance against PR #633's real
 * admission function. Deliberately no elevated shell, service, Broker, UAC,
 * VM, filesystem mutation, wall-clock sleeps, or production dispatch.
 *
 * Tests re-enter the existing admission function at synthetic dispatch
 * checkpoints. They do NOT assert that an installed Broker currently
 * implements those checkpoints or can interrupt an already-dispatched task.
 */
const image = 'a'.repeat(64);
const binding = 'b'.repeat(64);
const ownerGrant = 'c'.repeat(64);
const secondBinding = 'd'.repeat(64);
const clock = '2026-10-21T13:00:00.000Z';
const requestId = 'fd126d10-d1ab-4fa9-baad-fd1925000025';

type Mode = 'CORE' | 'ROOT';
type Action = 'core.shell.exec' | 'core.process.start' | 'core.process.stop';

function request(mode: Mode = 'CORE', action: Action = 'core.shell.exec') {
  return {
    type: 'core-broker.execute' as const,
    version: 1 as const,
    requestId,
    deviceId: 'device-25',
    ownerAccountId: 'owner-25',
    ownerEpoch: 25,
    credentialBinding: binding,
    mode,
    action,
    issuedAt: '2026-10-21T12:59:30.000Z',
    expiresAt: '2026-10-21T13:00:30.000Z',
    ...(action === 'core.process.stop' ? {
      stopTarget: {
        pid: 10025,
        processCreationFiletime: '133900000000000025',
        expectedImageSha256: ownerGrant,
      },
    } : {
      shell: {
        executable: 'C:/Windows/System32/cmd.exe',
        arguments: ['/C', 'echo synthetic-only'],
      },
    }),
  };
}

function context(mode: Mode = 'CORE'): CoreBrokerContext {
  return {
    now: new Date(clock),
    deviceId: 'device-25',
    ownerAccountId: 'owner-25',
    credentialBinding: binding,
    authoritativeOwnerEpoch: 25,
    ownerRevoked: false,
    enrollment: {
      deviceId: 'device-25',
      ownerAccountId: 'owner-25',
      ownerEpoch: 25,
      credentialBinding: binding,
      enrollmentId: 'c2500000-0000-4000-8000-000000000025',
      mode,
      activatedAt: '2026-10-21T12:50:00.000Z',
      expiresAt: mode === 'ROOT' ? '2026-10-21T13:05:00.000Z' : null,
      ownerSignedGrantDigest: ownerGrant,
      brokerInstalledImageSha256: image,
    },
    localBootstrap: {
      localPhysicalUacConsentVerified: true,
      signedEnrollmentStoredInProtectedBroker: true,
      trustedInstallerRollbackBindingVerified: true,
    },
    trustedRuntime: {
      evidenceProvenance: 'independent-windows-native',
      brokerProcessHighIntegrity: true,
      administratorsTokenEnabled: true,
      brokerAuthenticatedAndVersionMatched: true,
      runningImageIdentityMatched: true,
      expectedBrokerImageSha256: image,
      imageAuthenticodePublisherPinned: true,
      signedReleaseAndRollbackManifestVerified: true,
      brokerExeAndParentAclProtected: true,
      importedModulesAclProtected: true,
      updaterPathsAclProtected: true,
      processHandleDuplicationBoundaryProtected: true,
    },
    ownerIntentSignatureVerified: true,
    enrollmentSignatureVerified: true,
    ownerEpochWitnessVerified: true,
    requestAlreadyReserved: () => false,
    pendingMutationUnknown: false,
    approvedVmIds: [],
    stopProcessIdentityVerified: true,
  };
}
function gate(c: CoreBrokerContext, r: ReturnType<typeof request> = request()) {
  return evaluateCoreBrokerExecution(r, c);
}
function candidate(c: CoreBrokerContext, r: ReturnType<typeof request> = request()) {
  const result = gate(c, r);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED, false);
  assert.equal(result.reason, 'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(result.privilegedExecutionOccurred, false);
  assert.equal(result.verifiedEffect, false);
  assert.equal(result.requiresPerCommandUac, false);
  assert.equal(result.automaticallyRetryable, false);
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release: () => release() };
}

test('P0 queued CORE task: owner revokes before admission recheck', () => {
  const c = context();
  candidate(c);
  c.ownerRevoked = true;
  const outcome = gate(c);
  assert.equal(outcome.reason, 'GRANT_REVOKED');
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.privilegedExecutionOccurred, false);
  assert.equal(outcome.automaticallyRetryable, false);
});

test('P0 running-task handoff: deterministic revoke while a synthetic read is gated', async () => {
  const c = context();
  const entered = latch(), proceed = latch();
  const effects: string[] = [];
  const operation = (async () => {
    candidate(c);
    entered.release();
    await proceed.promise; // deterministic in-flight boundary, NOT a real syscall
    const checkImmediatelyBeforeEffect = gate(c);
    if (checkImmediatelyBeforeEffect.reason !== 'ELEVATED_DISPATCH_NOT_INSTALLED') {
      return checkImmediatelyBeforeEffect.reason;
    }
    effects.push('mock-only');
    return 'MOCK_EFFECT';
  })();
  await entered.promise;
  c.ownerRevoked = true;
  proceed.release();
  assert.equal(await operation, 'GRANT_REVOKED');
  assert.deepEqual(effects, []);
});

test('P0 owner re-pair invalidates queued/running old owner and grant epoch', async () => {
  const c = context();
  const oldRequest = request();
  candidate(c, oldRequest);
  const entered = latch(), proceed = latch();
  let effects = 0;
  const operation = (async () => {
    entered.release();
    await proceed.promise;
    if (gate(c, oldRequest).reason !== 'ELEVATED_DISPATCH_NOT_INSTALLED') return;
    effects++;
  })();
  await entered.promise;
  c.authoritativeOwnerEpoch = 26;
  c.ownerAccountId = 'owner-26';
  c.credentialBinding = secondBinding;
  proceed.release();
  await operation;
  assert.equal(effects, 0);
  assert.equal(gate(c, oldRequest).reason, 'WRONG_DEVICE_OR_OWNER_EPOCH');

  // Only fresh owner-bound candidate after explicit re-enrollment could pass
  // SOURCE admission. These booleans are test fixtures, never native proof.
  const fresh = {
    ...oldRequest, ownerAccountId: 'owner-26',
    credentialBinding: secondBinding, ownerEpoch: 26,
    requestId: 'fd126d10-d1ab-4fa9-baad-fd1925000026',
  };
  c.enrollment = {
    ...c.enrollment!, ownerAccountId: 'owner-26',
    credentialBinding: secondBinding, ownerEpoch: 26,
    enrollmentId: 'c2600000-0000-4000-8000-000000000026',
  };
  candidate(c, fresh);
});

test('P0 ROOT grant: T+899999ms candidate, T+900000ms denied, no extension', () => {
  const c = context('ROOT');
  c.enrollment = {
    ...c.enrollment!,
    activatedAt: '2026-10-21T12:45:00.000Z',
    expiresAt: '2026-10-21T13:00:00.000Z',
  };
  const before = {
    ...request('ROOT'),
    issuedAt: '2026-10-21T12:59:30.000Z',
    expiresAt: '2026-10-21T13:00:00.000Z',
  };
  c.now = new Date('2026-10-21T12:59:59.999Z');
  candidate(c, before);
  c.now = new Date('2026-10-21T13:00:00.000Z');
  const crossing = {
    ...before, expiresAt: '2026-10-21T13:00:20.000Z',
  };
  assert.equal(gate(c, crossing).reason, 'ROOT_15_MINUTES_EXCEEDED');
  c.now = new Date('2026-10-21T13:00:00.001Z');
  assert.equal(gate(c, crossing).reason, 'ROOT_15_MINUTES_EXCEEDED');
  c.enrollment = {
    ...c.enrollment!, expiresAt: '2026-10-21T13:00:00.001Z',
  };
  assert.equal(gate(c, crossing).reason, 'ROOT_15_MINUTES_EXCEEDED');
});

test('P0 lost ACK/unknown remote mutation: same request cannot be auto-replayed', () => {
  const c = context();
  candidate(c);
  c.pendingMutationUnknown = true; // simulated send with lost ACK
  let result = gate(c);
  assert.equal(result.reason, 'UNKNOWN_MUTATION_NO_REPLAY');
  assert.equal(result.status, 'unknown');
  assert.equal(result.automaticallyRetryable, false);

  c.pendingMutationUnknown = false;
  c.requestAlreadyReserved = (id, epoch) => id === requestId && epoch === 25;
  result = gate(c);
  assert.equal(result.reason, 'STALE_OR_REPLAYED_REQUEST');
  assert.equal(result.status, 'unknown');
  assert.equal(result.automaticallyRetryable, false);

  // Revocation does not prove cancellation of an already-sent side effect.
  c.pendingMutationUnknown = true;
  c.ownerRevoked = true;
  result = gate(c);
  assert.equal(result.reason, 'GRANT_REVOKED');
  assert.equal(result.automaticallyRetryable, false);
  assert.equal(result.verifiedEffect, false);
});

test('P0 stopped ledger/forged epoch witness fails closed, not resumed execution', () => {
  const c = context();
  c.requestAlreadyReserved = () => { throw Error('external CAS unavailable'); };
  assert.equal(gate(c).reason, 'STALE_OR_REPLAYED_REQUEST');
  assert.equal(gate(c).automaticallyRetryable, false);
  c.requestAlreadyReserved = () => false;
  c.ownerEpochWitnessVerified = false;
  assert.equal(gate(c).reason, 'OWNER_COMMAND_SIGNATURE_REQUIRED');
  c.ownerEpochWitnessVerified = true;
  c.ownerIntentSignatureVerified = false;
  assert.equal(gate(c).reason, 'OWNER_COMMAND_SIGNATURE_REQUIRED');
});

test('P0 owner-preapproved CORE retains broad capability without per-command UAC', () => {
  const c = context();
  for (const action of ['core.shell.exec', 'core.process.start', 'core.process.stop'] as const) {
    const result = gate(c, request('CORE', action));
    assert.equal(result.reason, 'ELEVATED_DISPATCH_NOT_INSTALLED', action);
    assert.equal(result.oneTimeBootstrapAlreadyVerified, true, action);
    assert.equal(result.requiresPerCommandUac, false, action);
  }
  c.localBootstrap.signedEnrollmentStoredInProtectedBroker = false;
  const invalidated = gate(c);
  assert.equal(invalidated.reason, 'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
  assert.equal(invalidated.requiresPerCommandUac, false);
  assert.equal(invalidated.privilegedExecutionOccurred, false);
});
