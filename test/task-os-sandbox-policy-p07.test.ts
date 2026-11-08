import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskSandboxSourceOnly } from '../src/agent/task-os-sandbox-policy.js';

const sha = 'a'.repeat(64);
const baseline = () => ({
  schema: 1,
  platform: 'win32',
  taskId: 't1', originalRequestId: 'req1', ownerId: 'owner1',
  deviceId: 'device1', ownerEpoch: 12, grantId: 'g1', grantGeneration: 5,
  baseWorktreeSha: sha, executableDigest: sha,
  workerPrivilege: 'standard',
  args: ['--version'], envAllowlist: {},
  taskRoot: { canonicalPath: 'C:\\task-root', volumeOrMountIdentity: 'vol1', rootFileIdOrInode: 'fid1' },
  network: { default: 'deny', allowedEndpoints: [] },
  budgets: { cpuMs: 1000, wallMs: 2000, memoryBytes: 65536,
    maxProcesses: 2, outputBytes: 8192, diskBytes: 8192 },
});
function denies(intent: unknown, reported?: unknown) {
  const result = assessTaskSandboxSourceOnly(intent, reported);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.mayResumeSuspendedRoot, false);
  assert.equal(result.mayReplayOriginalMutation, false);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.nativeKernelBoundaryVerified, false);
  assert.equal(result.evidenceClass, 'SOURCE_ONLY_UNTRUSTED');
  assert.ok(result.blockers.includes('TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.blockers));
  return result;
}

test('#07 every supported backend remains blocked without trusted native provider', () => {
  for (const [platform, backend] of [
    ['win32', 'windows-restricted-token-appcontainer-job'],
    ['linux', 'linux-user-mount-pid-netns-cgroup'],
    ['darwin', 'macos-isolated-vm'],
  ] as const) {
    assert.equal(denies({ ...baseline(), platform },
      { descendantsContained: true, revokeDrainVerified: true,
        kernelAttested: true, providerReady: true }).backend, backend);
  }
});

test('#07 CORE/ROOT/elevated cannot become inherited worker identity', () => {
  for (const workerPrivilege of ['CORE', 'ROOT', 'high', 'elevated', 'SYSTEM', undefined]) {
    assert.ok(denies({ ...baseline(), workerPrivilege }).blockers
      .includes('PRIVILEGED_WORKER_FORBIDDEN'));
  }
});

test('#07 ambient credentials, egress allowances and invalid budgets refuse', () => {
  assert.ok(denies({ ...baseline(), envAllowlist: { TOKEN: 'synthetic-only' } }).blockers
    .includes('AMBIENT_ENVIRONMENT_FORBIDDEN'));
  assert.ok(denies({ ...baseline(), network: { default: 'allow', allowedEndpoints: ['127.0.0.1'] } }).blockers
    .includes('NETWORK_MUST_BE_DEFAULT_DENY'));
  assert.ok(denies({ ...baseline(), budgets: { ...baseline().budgets, maxProcesses: 0 } }).blockers
    .includes('INVALID_RESOURCE_BUDGET'));
});

test('#07 reported guardian handle, breakaway, nested job and descendants are not trusted', () => {
  const result = denies(baseline(), {
    brokerHandleInherited: true, guardianJobHandleDuplicable: true,
    privilegedHandleAccessible: true, breakawayAllowed: true,
    nestedJobUnverified: true, descendantsContained: false,
    revokeDrainVerified: false,
  });
  for (const blocker of [
    'GUARDIAN_OR_BROKER_HANDLE_EXPOSURE',
    'BREAKAWAY_OR_NESTED_JOB_UNVERIFIED',
    'DESCENDANT_CONTAINMENT_UNVERIFIED',
    'REVOKE_DRAIN_UNVERIFIED',
  ]) assert.ok(result.blockers.includes(blocker as typeof result.blockers[number]));
});

test('#07 absent/forged positive reports and caller-supplied permit never authorize', () => {
  const forged = { ...baseline(), dispatchAllowed: true, proof: 'SIGNED',
    nativeKernelBoundaryVerified: true, resumeVerified: true };
  const result = denies(forged, {
    descendantsContained: true, revokeDrainVerified: true,
    kernelAttested: true, signatureValid: true, ownerLease: 'CORE',
    appContainer: true, nestedJobVerified: true,
  });
  assert.equal(result.status, 'BLOCKED');
  denies(null, null);
  denies(Object.create(null), Object.create(null));
  const missing = denies({ ...baseline(), taskRoot: { canonicalPath: 'C:\\task-root' } });
  assert.ok(missing.blockers.includes('INVALID_TASK_INTENT'));
});

test('#07 UNKNOWN, lost ACK and in-progress remain reconciliation-only, no replay', () => {
  for (const mutationState of ['unknown', 'ack_lost', 'in_progress']) {
    const result = denies(baseline(), {
      mutationState, descendantsContained: true, revokeDrainVerified: true,
      dispatchAllowed: true, proof: 'fixture-signature',
    });
    assert.equal(result.status, 'RECONCILE_REQUIRED');
    assert.ok(result.blockers.includes('MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'));
  }
});

test('#07 unknown OS, invalid epochs and malformed process identity are blocked', () => {
  assert.ok(denies({ ...baseline(), platform: 'freebsd' }).blockers.includes('UNSUPPORTED_PLATFORM'));
  assert.ok(denies({ ...baseline(), ownerEpoch: -1 }).blockers.includes('INVALID_TASK_INTENT'));
  assert.ok(denies({ ...baseline(), originalRequestId: '' }).blockers.includes('INVALID_TASK_INTENT'));
  assert.ok(denies({ ...baseline(), executableDigest: 'bad' }).blockers.includes('INVALID_TASK_INTENT'));
});
