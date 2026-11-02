/**
 * #07: OS task sandbox policy boundary. SOURCE-ONLY / NOT AN EXECUTOR.
 *
 * This module cannot issue a launch permit. Its reports are untrusted, and its
 * only runtime decision is fail-closed until an independently attested native
 * suspended launcher, grant/CAS gate, and verified drain are integrated by
 * their respective owners. In particular, CORE is not a worker OS identity.
 */
export type SandboxPlatform = 'win32' | 'linux' | 'darwin';
export type SandboxBackend =
  | 'windows-restricted-token-appcontainer-job'
  | 'linux-user-mount-pid-netns-cgroup'
  | 'macos-isolated-vm';

export type SandboxBlocker =
  | 'INVALID_TASK_INTENT'
  | 'UNSUPPORTED_PLATFORM'
  | 'PRIVILEGED_WORKER_FORBIDDEN'
  | 'AMBIENT_ENVIRONMENT_FORBIDDEN'
  | 'NETWORK_MUST_BE_DEFAULT_DENY'
  | 'INVALID_RESOURCE_BUDGET'
  | 'GUARDIAN_OR_BROKER_HANDLE_EXPOSURE'
  | 'BREAKAWAY_OR_NESTED_JOB_UNVERIFIED'
  | 'DESCENDANT_CONTAINMENT_UNVERIFIED'
  | 'REVOKE_DRAIN_UNVERIFIED'
  | 'MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'
  | 'TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE';

export interface TaskSandboxSourceAssessment {
  readonly schema: 1;
  readonly evidenceClass: 'SOURCE_ONLY_UNTRUSTED';
  readonly status: 'BLOCKED' | 'RECONCILE_REQUIRED';
  readonly dispatchAllowed: false;
  readonly mayResumeSuspendedRoot: false;
  readonly mayReplayOriginalMutation: false;
  readonly cleanupVerified: false;
  readonly nativeKernelBoundaryVerified: false;
  readonly backend: SandboxBackend | null;
  readonly blockers: readonly SandboxBlocker[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[a-z0-9][a-z0-9_.:-]*$/i.test(value);
}
function nonnegativeEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}
function positiveBudget(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0 &&
    (value as number) <= maximum;
}
function unique(values: readonly SandboxBlocker[]): readonly SandboxBlocker[] {
  return Object.freeze([...new Set(values)]);
}

/**
 * Intentionally does not accept signatures, injected verified booleans,
 * path strings as proof of file identity, or a callable launch provider.
 * reported is advisory and hostile until a separate native OS readback.
 */
export function assessTaskSandboxSourceOnly(
  intent: unknown,
  reported?: unknown,
): TaskSandboxSourceAssessment {
  const blockers: SandboxBlocker[] = [];
  const task = record(intent) ? intent : null;
  const platform = task?.platform;
  const backend: SandboxBackend | null = platform === 'win32'
    ? 'windows-restricted-token-appcontainer-job'
    : platform === 'linux' ? 'linux-user-mount-pid-netns-cgroup'
      : platform === 'darwin' ? 'macos-isolated-vm' : null;
  if (!backend) blockers.push('UNSUPPORTED_PLATFORM');

  const root = task && record(task.taskRoot) ? task.taskRoot : null;
  const network = task && record(task.network) ? task.network : null;
  const budgets = task && record(task.budgets) ? task.budgets : null;
  if (!task || task.schema !== 1 || !boundedId(task.taskId) ||
    !boundedId(task.originalRequestId) || !boundedId(task.ownerId) ||
    !boundedId(task.deviceId) || !boundedId(task.grantId) ||
    !nonnegativeEpoch(task.ownerEpoch) || !nonnegativeEpoch(task.grantGeneration) ||
    !digest(task.executableDigest) || !digest(task.baseWorktreeSha) ||
    !root || typeof root.canonicalPath !== 'string' || !root.canonicalPath ||
    !boundedId(root.volumeOrMountIdentity) || !boundedId(root.rootFileIdOrInode) ||
    !Array.isArray(task.args) || task.args.length > 256 ||
    !task.args.every(v => typeof v === 'string' && v.length <= 32768)) {
    blockers.push('INVALID_TASK_INTENT');
  }
  if (task?.workerPrivilege !== 'standard') {
    blockers.push('PRIVILEGED_WORKER_FORBIDDEN');
  }
  // Until a real provider can build a clean environment, caller-supplied
  // environment is never accepted, including a synthetic sanitized flag.
  if (!task || !record(task.envAllowlist) ||
      Object.keys(task.envAllowlist).length !== 0) {
    blockers.push('AMBIENT_ENVIRONMENT_FORBIDDEN');
  }
  if (!network || network.default !== 'deny' ||
      !Array.isArray(network.allowedEndpoints) ||
      network.allowedEndpoints.length !== 0) {
    blockers.push('NETWORK_MUST_BE_DEFAULT_DENY');
  }
  if (!budgets ||
    !positiveBudget(budgets.cpuMs, 86_400_000) ||
    !positiveBudget(budgets.wallMs, 86_400_000) ||
    !positiveBudget(budgets.memoryBytes, Number.MAX_SAFE_INTEGER) ||
    !positiveBudget(budgets.maxProcesses, 1024) ||
    !positiveBudget(budgets.outputBytes, 1_073_741_824) ||
    !positiveBudget(budgets.diskBytes, Number.MAX_SAFE_INTEGER)) {
    blockers.push('INVALID_RESOURCE_BUDGET');
  }

  const observation = record(reported) ? reported : null;
  // Flagged risks are useful to report, but an attacker setting them to false
  // is NOT positive evidence. The trusted-native-provider blocker remains.
  if (observation?.brokerHandleInherited === true ||
      observation?.guardianJobHandleDuplicable === true ||
      observation?.privilegedHandleAccessible === true) {
    blockers.push('GUARDIAN_OR_BROKER_HANDLE_EXPOSURE');
  }
  if (observation?.breakawayAllowed === true ||
      observation?.nestedJobUnverified === true) {
    blockers.push('BREAKAWAY_OR_NESTED_JOB_UNVERIFIED');
  }
  if (observation?.descendantsContained !== true) {
    blockers.push('DESCENDANT_CONTAINMENT_UNVERIFIED');
  }
  if (observation?.revokeDrainVerified !== true) {
    blockers.push('REVOKE_DRAIN_UNVERIFIED');
  }
  const mayHaveMutated = observation?.mutationState === 'unknown' ||
    observation?.mutationState === 'in_progress' ||
    observation?.mutationState === 'ack_lost';
  if (mayHaveMutated) blockers.push('MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED');
  blockers.push('TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE');
  return Object.freeze({
    schema: 1 as const,
    evidenceClass: 'SOURCE_ONLY_UNTRUSTED' as const,
    status: mayHaveMutated ? 'RECONCILE_REQUIRED' as const : 'BLOCKED' as const,
    dispatchAllowed: false as const,
    mayResumeSuspendedRoot: false as const,
    mayReplayOriginalMutation: false as const,
    cleanupVerified: false as const,
    nativeKernelBoundaryVerified: false as const,
    backend,
    blockers: unique(blockers),
  });
}
