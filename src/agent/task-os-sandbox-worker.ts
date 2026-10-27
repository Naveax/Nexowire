/**
 * #07 OS-sandbox worker port for future #03 dispatch integration.
 *
 * The current repository has NO accepted native low-privilege task launcher.
 * Consequently this port is deliberately non-executing. It MUST NOT fall back
 * to Node spawn, a current-user shell, a Windows Job alone, a private desktop,
 * or an untrusted native status JSON. Only #02/#03 may wire a future OS-backed
 * launcher after independent physical kernel evidence is available.
 */
import {
  assessTaskSandboxSourceOnly,
  type SandboxBackend,
  type SandboxPlatform,
  type TaskSandboxSourceAssessment,
} from './task-os-sandbox-policy.js';

export type WorkerEvidenceRequirement =
  | 'independent_signed_owner_epoch_and_external_CAS'
  | 'suspended_worker_created_under_verified_low_privilege_identity'
  | 'exact_pid_creation_identity_and_executable_digest'
  | 'no_ambient_parent_credentials_environment_or_privileged_handles'
  | 'os_enforced_filesystem_root_no_symlink_hardlink_escape'
  | 'os_enforced_network_and_local_Broker_IPC_denial'
  | 'child_grandchild_process_containment'
  | 'no_breakaway_or_unverified_nested_Job'
  | 'revoke_timeout_shutdown_and_independently_verified_drain'
  | 'lost_ACK_durable_reconciliation_no_replay';

const COMMON_REQUIREMENTS: readonly WorkerEvidenceRequirement[] = Object.freeze([
  'independent_signed_owner_epoch_and_external_CAS',
  'suspended_worker_created_under_verified_low_privilege_identity',
  'exact_pid_creation_identity_and_executable_digest',
  'no_ambient_parent_credentials_environment_or_privileged_handles',
  'os_enforced_filesystem_root_no_symlink_hardlink_escape',
  'os_enforced_network_and_local_Broker_IPC_denial',
  'child_grandchild_process_containment',
  'no_breakaway_or_unverified_nested_Job',
  'revoke_timeout_shutdown_and_independently_verified_drain',
  'lost_ACK_durable_reconciliation_no_replay',
]);

export const OS_SANDBOX_WITNESSES: Readonly<Record<SandboxPlatform, readonly string[]>> =
  Object.freeze({
    win32: Object.freeze([
      'actual_restricted_primary_token_or_AppContainer_SID',
      'kernel_integrity_restricted_SIDs_and_effective_access_checks',
      'guardian_DACL_denies_untrusted_PROCESS_DUP_HANDLE',
      'unnamed_Job_exact_PID_FILETIME_no_breakaway_nested_Job_proof',
      'independent_WFP_direct_IP_DNS_loopback_and_IPC_denials',
      'whole_Job_and_out_of_Job_descendant_death_confirmed',
    ]),
    linux: Object.freeze([
      'verified_uid_gid_maps_mount_pid_network_namespaces',
      'rootless_mount_identity_no_inherited_host_file_descriptors',
      'cgroup_v2_real_memory_process_cpu_and_drain_counters',
      'no_host_socket_SCM_RIGHTS_or_cross_namespace_egress',
    ]),
    darwin: Object.freeze([
      'attested_isolated_VM_guest_identity_and_no_guest_NIC',
      'verified_guest_shared_filesystem_and_IPC_denials',
      'host_verified_descendant_VM_termination_and_no_leaks',
    ]),
  });

export interface SandboxWorkerLaunchBlueprint {
  readonly schema: 1;
  readonly status: 'BLOCKED' | 'RECONCILE_REQUIRED';
  readonly evidenceClass: 'SOURCE_ONLY_UNTRUSTED';
  readonly selectedBackend: SandboxBackend | null;
  readonly requiresNativeKernelReadback: true;
  readonly workerOSPrivilege: 'UNVERIFIED';
  readonly workerLaunchEnabled: false;
  readonly acceptsParentEnv: false;
  readonly acceptsInheritedHandles: false;
  readonly acceptsPrivilegedBrokerIPC: false;
  readonly systemEffectsAllowed: false;
  readonly cannotBeUsedAsOSPermit: true;
  readonly commonEvidenceRequired: readonly WorkerEvidenceRequirement[];
  readonly platformEvidenceRequired: readonly string[];
  readonly assessment: TaskSandboxSourceAssessment;
}

export interface TaskSandboxStopResult {
  readonly state: 'RECONCILE_REQUIRED';
  readonly reason: 'NATIVE_DRAIN_UNAVAILABLE';
  readonly workerStoppedVerified: false;
  readonly descendantsStoppedVerified: false;
  readonly brokerHandlesClosedVerified: false;
  readonly quotaOrGrantReleaseAllowed: false;
  readonly replayAllowed: false;
  readonly cleanupVerified: false;
}

/** Deliberately NOT a kernel observer: reports and JS booleans cannot authorize. */
export function prepareTaskSandboxWorker(
  intent: unknown,
  untrustedReport?: unknown,
): SandboxWorkerLaunchBlueprint {
  const assessment = assessTaskSandboxSourceOnly(intent, untrustedReport);
  const backend = assessment.backend;
  const platformEvidenceRequired = backend === 'windows-restricted-token-appcontainer-job'
    ? OS_SANDBOX_WITNESSES.win32
    : backend === 'linux-user-mount-pid-netns-cgroup'
      ? OS_SANDBOX_WITNESSES.linux
      : backend === 'macos-isolated-vm'
        ? OS_SANDBOX_WITNESSES.darwin : Object.freeze([] as string[]);
  return Object.freeze({
    schema: 1 as const,
    status: assessment.status,
    evidenceClass: 'SOURCE_ONLY_UNTRUSTED' as const,
    selectedBackend: backend,
    requiresNativeKernelReadback: true as const,
    workerOSPrivilege: 'UNVERIFIED' as const,
    workerLaunchEnabled: false as const,
    acceptsParentEnv: false as const,
    acceptsInheritedHandles: false as const,
    acceptsPrivilegedBrokerIPC: false as const,
    systemEffectsAllowed: false as const,
    cannotBeUsedAsOSPermit: true as const,
    commonEvidenceRequired: COMMON_REQUIREMENTS,
    platformEvidenceRequired,
    assessment,
  });
}

export class OsTaskSandboxBlockedError extends Error {
  readonly code: 'OS_TASK_SANDBOX_UNAVAILABLE' | 'OS_TASK_RECONCILIATION_REQUIRED';
  readonly safeBlueprint: SandboxWorkerLaunchBlueprint;

  constructor(blueprint: SandboxWorkerLaunchBlueprint) {
    super(blueprint.status === 'RECONCILE_REQUIRED'
      ? 'OS task mutation outcome uncertain; independent reconciliation required.'
      : 'Verified low-privilege OS task worker is unavailable; execution denied.');
    this.name = 'OsTaskSandboxBlockedError';
    this.code = blueprint.status === 'RECONCILE_REQUIRED'
      ? 'OS_TASK_RECONCILIATION_REQUIRED' : 'OS_TASK_SANDBOX_UNAVAILABLE';
    // Safe metadata only. Never retain or log argv, secrets, paths or untrusted report.
    this.safeBlueprint = blueprint;
  }
}

/**
 * Future #03 shell.exec adapter entry point. Even if caller supplies a fake
 * token, success receipt, signed-looking manifest or injected callbacks, this
 * implementation never resolves to a running worker and never imports spawn.
 * API shape is stable for dispatch integration; implementation remains NO-GO.
 */
export async function executeTaskWithOsSandbox(
  intent: unknown,
  untrustedReport?: unknown,
): Promise<never> {
  throw new OsTaskSandboxBlockedError(prepareTaskSandboxWorker(intent, untrustedReport));
}

/**
 * Readbacks cannot be trusted without a native out-of-band observer. Any
 * ambiguous launch/ACK/revoke must hold resource accounting and require
 * reconciliation, even if a local source-only worker knows of no child PID.
 */
export async function revokeTaskSandboxAndDrain(
  _originalRequestId: unknown,
  _untrustedReadback?: unknown,
): Promise<TaskSandboxStopResult> {
  return Object.freeze({
    state: 'RECONCILE_REQUIRED' as const,
    reason: 'NATIVE_DRAIN_UNAVAILABLE' as const,
    workerStoppedVerified: false as const,
    descendantsStoppedVerified: false as const,
    brokerHandlesClosedVerified: false as const,
    quotaOrGrantReleaseAllowed: false as const,
    replayAllowed: false as const,
    cleanupVerified: false as const,
  });
}
