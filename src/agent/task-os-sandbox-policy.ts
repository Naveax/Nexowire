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
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
  } catch { return false; }
}

/**
 * Values from intent/readbacks are adversarial JS objects. Only read own data
 * descriptors: plain getters must never execute during a deny-only assessment.
 * A Proxy can still intercept reflection; a throwing trap always fails closed.
 */
function own(value: Record<string, unknown> | null, field: string): unknown {
  if (!value) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function ownFieldExists(value: Record<string, unknown> | null, field: string): boolean {
  if (!value) return false;
  try { return Object.getOwnPropertyDescriptor(value, field) !== undefined; }
  catch { return true; } // Unknown report layout must be reconciled, not replayed.
}
/** Reject even non-enumerable/symbolic or accessor extra request fields.
 * This is a source-only shape check, NOT an authenticated snapshot: a hostile
 * Proxy can mutate values between descriptor reads, so the native admission
 * owner must still sign and compare exact immutable serialized bytes. */
function exactOwnDataKeys(value: unknown, expected: readonly string[]): boolean {
  if (!record(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== expected.length) return false;
    if (!actual.every(key => typeof key === 'string' && expected.includes(key))) {
      return false;
    }
    return expected.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    });
  } catch { return false; }
}
const TASK_KEYS = Object.freeze([
  'schema','platform','taskId','originalRequestId','ownerId','deviceId',
  'grantId','ownerEpoch','grantGeneration','executableDigest',
  'baseWorktreeSha','workerPrivilege','args','envAllowlist','taskRoot',
  'network','budgets',
] as const);
const ROOT_KEYS = Object.freeze([
  'canonicalPath','volumeOrMountIdentity','rootFileIdOrInode',
] as const);
const NETWORK_KEYS = Object.freeze(['default','allowedEndpoints'] as const);
const BUDGET_KEYS = Object.freeze([
  'cpuMs','wallMs','memoryBytes','maxProcesses','outputBytes','diskBytes',
] as const);
function plainEmptyObject(value: unknown): boolean {
  if (!record(value)) return false;
  try { return Reflect.ownKeys(value).length === 0; }
  catch { return false; }
}
function emptyList(value: unknown): boolean {
  try {
    return Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      Object.getOwnPropertyDescriptor(value, 'length')?.value === 0 &&
      Reflect.ownKeys(value).length === 1;
  } catch { return false; }
}
function boundedArgs(value: unknown): boolean {
  try {
    if (!Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || (length as number) > 256) return false;
    // Only the exact indexed argv slots and intrinsic length are admitted.
    // Hidden own properties, symbols and accessor-backed metadata could make
    // a later serializer sign bytes other than the fields we inspected.
    // Malicious Proxy ownKeys traps are caught and remain deny-only.
    if (Reflect.ownKeys(value).length !== (length as number) + 1) return false;
    // Individual limits are insufficient: 256 x 32K strings would let
    // untrusted callers force a huge serialized payload before OS admission.
    // Keep the combined argument envelope conservatively under the Windows
    // 32767 UTF-16 command-line ceiling. Native quoting/argv rules must still
    // be verified independently and this check never grants execution.
    let totalUnits = 0;
    for (let i = 0; i < (length as number); i++) {
      const item = Object.getOwnPropertyDescriptor(value, String(i));
      if (!item || !('value' in item) || typeof item.value !== 'string' ||
          item.value.length > 32767 || item.value.includes('\0')) return false;
      totalUnits += item.value.length + 1;
      if (totalUnits > 32767) return false;
    }
    return true;
  } catch { return false; }
}
/** Source-only shape restriction; NOT native canonical file identity proof. */
function boundedTaskRootPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 32767 && !value.includes('\0');
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
  const platform = own(task, 'platform');
  const backend: SandboxBackend | null = platform === 'win32'
    ? 'windows-restricted-token-appcontainer-job'
    : platform === 'linux' ? 'linux-user-mount-pid-netns-cgroup'
      : platform === 'darwin' ? 'macos-isolated-vm' : null;
  if (!backend) blockers.push('UNSUPPORTED_PLATFORM');

  const maybeRoot = own(task, 'taskRoot');
  const maybeNetwork = own(task, 'network');
  const maybeBudgets = own(task, 'budgets');
  const root = record(maybeRoot) ? maybeRoot : null;
  const network = record(maybeNetwork) ? maybeNetwork : null;
  const budgets = record(maybeBudgets) ? maybeBudgets : null;
  if (!exactOwnDataKeys(task, TASK_KEYS) ||
    !exactOwnDataKeys(root, ROOT_KEYS) ||
    own(task, 'schema') !== 1 || !boundedId(own(task, 'taskId')) ||
    !boundedId(own(task, 'originalRequestId')) || !boundedId(own(task, 'ownerId')) ||
    !boundedId(own(task, 'deviceId')) || !boundedId(own(task, 'grantId')) ||
    !nonnegativeEpoch(own(task, 'ownerEpoch')) || !nonnegativeEpoch(own(task, 'grantGeneration')) ||
    !digest(own(task, 'executableDigest')) || !digest(own(task, 'baseWorktreeSha')) ||
    !root || !boundedTaskRootPath(own(root, 'canonicalPath')) ||
    !boundedId(own(root, 'volumeOrMountIdentity')) ||
    !boundedId(own(root, 'rootFileIdOrInode')) ||
    !boundedArgs(own(task, 'args'))) {
    blockers.push('INVALID_TASK_INTENT');
  }
  if (own(task, 'workerPrivilege') !== 'standard') {
    blockers.push('PRIVILEGED_WORKER_FORBIDDEN');
  }
  // Until a real provider can build a clean environment, caller-supplied
  // environment is never accepted, including a synthetic sanitized flag.
  if (!task || !plainEmptyObject(own(task, 'envAllowlist'))) {
    blockers.push('AMBIENT_ENVIRONMENT_FORBIDDEN');
  }
  if (!exactOwnDataKeys(network, NETWORK_KEYS) ||
      own(network, 'default') !== 'deny' ||
      !emptyList(own(network, 'allowedEndpoints'))) {
    blockers.push('NETWORK_MUST_BE_DEFAULT_DENY');
  }
  if (!exactOwnDataKeys(budgets, BUDGET_KEYS) ||
    !positiveBudget(own(budgets, 'cpuMs'), 86_400_000) ||
    !positiveBudget(own(budgets, 'wallMs'), 86_400_000) ||
    !positiveBudget(own(budgets, 'memoryBytes'), Number.MAX_SAFE_INTEGER) ||
    !positiveBudget(own(budgets, 'maxProcesses'), 1024) ||
    !positiveBudget(own(budgets, 'outputBytes'), 1_073_741_824) ||
    !positiveBudget(own(budgets, 'diskBytes'), Number.MAX_SAFE_INTEGER)) {
    blockers.push('INVALID_RESOURCE_BUDGET');
  }

  const observation = record(reported) ? reported : null;
  // Flagged risks are useful to report, but an attacker setting them to false
  // is NOT positive evidence. The trusted-native-provider blocker remains.
  if (own(observation, 'brokerHandleInherited') === true ||
      own(observation, 'guardianJobHandleDuplicable') === true ||
      own(observation, 'privilegedHandleAccessible') === true) {
    blockers.push('GUARDIAN_OR_BROKER_HANDLE_EXPOSURE');
  }
  if (own(observation, 'breakawayAllowed') === true ||
      own(observation, 'nestedJobUnverified') === true) {
    blockers.push('BREAKAWAY_OR_NESTED_JOB_UNVERIFIED');
  }
  if (own(observation, 'descendantsContained') !== true) {
    blockers.push('DESCENDANT_CONTAINMENT_UNVERIFIED');
  }
  if (own(observation, 'revokeDrainVerified') !== true) {
    blockers.push('REVOKE_DRAIN_UNVERIFIED');
  }
  // No caller-supplied mutation state, including "not_started" or "done",
  // is proof that a durable request did not already cause effects. A reported
  // state field is enough to quarantine for external reconciliation. Inspect
  // the descriptor, not the property value: do not execute an accessor getter.
  // The presence of any untrusted mutation report, even `completed` or
  // `not_started`, does not establish that an effect never happened.
  const mayHaveMutated = reported != null &&
    (observation === null || ownFieldExists(observation, 'mutationState'));
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
