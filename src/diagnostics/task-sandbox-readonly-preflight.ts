/**
 * #10 / #780: read-only task-sandbox feature and resource inventory.
 *
 * This is NOT a process sandbox, path enforcer, allocator, native witness,
 * remote worker scheduler, or Windows elevation permission.
 * Every snapshot is supplied by an untrusted provider and is advisory.
 */
import {
  inspectReadonlyNativeAvailability,
  type NativeAvailabilityDiagnostic,
} from './core-native-provider-availability.js';
import type {
  BrokerExpectation,
  ReadonlyEvidenceProviders,
} from './core-broker-filetime-cas-evidence.js';

export type Evidence = 'verified' | 'unverified' | 'unavailable' | 'unsupported';
export type Platform = 'win32' | 'linux' | 'darwin' | 'unknown';
export type Mode = 'SAFE' | 'FULL' | 'ROOT' | 'CORE';
export type Boundary =
  | 'none' | 'path-filter' | 'windows-job'
  | 'windows-appcontainer' | 'linux-namespace'
  | 'container' | 'macos-sandbox' | 'vm';
export type Capability =
  | 'shell.exec' | 'file.read' | 'file.write'
  | 'process.start' | 'git.status' | 'browser.cdp'
  | 'windows.ui' | 'windows.service.control';
export interface TaskRequest {
  readonly taskId: string;
  readonly requestedMode: Mode;
  readonly capability: Capability;
  readonly requiredPrivilege: 'standard' | 'elevated' | 'unknown';
  readonly remoteWorkerRequested: boolean;
}
export interface TaskRootReadback {
  readonly taskSpecificRoot: Evidence;
  readonly canonicalRootIdentity: Evidence;
  readonly rootRelativePolicy: Evidence;
  readonly reparseAndAncestorBoundary: Evidence;
  readonly externalPathGrant: 'none' | 'independently_scoped' | 'unverified';
  readonly pathFilterOnly: boolean;
}
export interface DiskReadback {
  /** Bytes reported by a read-only observer; not a disk reservation. */
  readonly freeBytes: number | null;
  readonly requestedBudgetBytes: number | null;
  readonly requiredFreeFloorBytes: number | null;
  readonly taskRootVolumeMatched: Evidence;
  readonly atomicBudgetReservation: Evidence;
}
export interface PlatformReadback {
  readonly platform: Platform;
  readonly shell: Evidence;
  readonly file: Evidence;
  readonly git: Evidence;
  readonly process: Evidence;
  readonly browserCdp: Evidence;
  readonly windowsUi: Evidence;
  readonly windowsJob: Evidence;
  readonly windowsAppContainer: Evidence;
  readonly linuxNamespace: Evidence;
  readonly macosSandbox: Evidence;
  readonly virtualMachine: Evidence;
}
export interface ProcessBoundaryReadback {
  readonly kind: Boundary;
  readonly osBoundaryVerified: Evidence;
  readonly descendantsContained: Evidence;
  readonly filesystemIsolated: Evidence;
  readonly networkIsolated: Evidence;
  readonly environmentSecretsIsolated: Evidence;
  readonly gitHooksConstrained: Evidence;
}
/** Advisory only: even positive injected claims do NOT attest safe Git execution. */
export interface GitReadback {
  readonly discoveredRootWithinScopedGrant: Evidence;
  readonly linkedWorktreeGitdirAndCommonDirScoped: Evidence;
  readonly fsmonitorAndHookExecutionDisabled: Evidence;
  readonly gitConfigAndEnvironmentSanitized: Evidence;
  readonly gitSubprocessesContained: Evidence;
}
export interface RemoteWorkerReadback {
  readonly workerIdentityEnrolled: Evidence;
  readonly ownerDeviceSessionAuthenticated: Evidence;
  readonly capabilityScoped: Evidence;
  readonly workerOnlineReadback: Evidence;
  readonly independentRevocationAndCas: Evidence;
  readonly quotaOrBudgetReserved: Evidence;
  readonly remoteEndpointAuthenticated: Evidence;
}
export interface ReadonlyTaskPreflightInput {
  readonly request: TaskRequest;
  readonly root?: TaskRootReadback;
  readonly disk?: DiskReadback;
  readonly platform?: PlatformReadback;
  readonly process?: ProcessBoundaryReadback;
  readonly remote?: RemoteWorkerReadback;
  readonly git?: GitReadback;
  /** The existing #733 OS-high evidence comparer, not another signature verifier. */
  readonly broker?: ReadonlyEvidenceProviders;
  readonly expectedBroker: BrokerExpectation;
}
export type PreflightReason =
  | 'TASK_REQUEST_INVALID'
  | 'TASK_ROOT_PROVIDER_UNAVAILABLE'
  | 'TASK_ROOT_NOT_VERIFIED'
  | 'EXTERNAL_PATH_GRANT_NOT_VERIFIED'
  | 'DISK_PROVIDER_UNAVAILABLE'
  | 'DISK_BUDGET_INVALID_OR_UNAVAILABLE'
  | 'DISK_BUDGET_INSUFFICIENT'
  | 'DISK_RESERVATION_NOT_VERIFIED'
  | 'PLATFORM_PROVIDER_UNAVAILABLE'
  | 'PLATFORM_CAPABILITY_NOT_VERIFIED'
  | 'PLATFORM_ISOLATION_UNSUPPORTED'
  | 'PROCESS_BOUNDARY_PROVIDER_UNAVAILABLE'
  | 'PATH_FILTER_NOT_PROCESS_ISOLATION'
  | 'WINDOWS_JOB_NOT_FULL_SANDBOX'
  | 'PROCESS_ISOLATION_NOT_VERIFIED'
  | 'GIT_DISCOVERED_ROOT_NOT_VERIFIED'
  | 'GIT_SUBPROCESS_SANITIZATION_NOT_VERIFIED'
  | 'REMOTE_WORKER_PROVIDER_UNAVAILABLE'
  | 'REMOTE_WORKER_ELIGIBILITY_NOT_VERIFIED'
  | 'INSTALLED_HIGH_BROKER_NOT_PROVEN'
  | 'OWNER_GRANT_NOT_PHYSICALLY_VERIFIED'
  | 'EXTERNAL_CAS_DISPATCH_NOT_PROVEN'
  | 'SOURCE_OBSERVATIONS_NOT_EXECUTION_AUTHORITY';
export interface ReadonlyTaskPreflight {
  readonly schema: 1;
  readonly source: 'untrusted_readonly_inventory';
  readonly requestedMode: Mode;
  readonly requestedCapability: Capability;
  readonly requiredPrivilege: TaskRequest['requiredPrivilege'];
  readonly status: 'BLOCKED' | 'REVIEW_ONLY';
  readonly taskRoot: 'NOT_VERIFIED' | 'REPORTED_UNATTESTED';
  /** A reported in-scope path is not OS-backed filesystem confinement. */
  readonly filesystemContainment: 'NOT_PROVEN';
  /** Free bytes or an injected reservation flag never proves a durable lease. */
  readonly diskReservation: 'NOT_PROVEN';
  readonly diskBudget: 'UNAVAILABLE' | 'INSUFFICIENT' | 'REPORTED_UNATTESTED';
  readonly platformCapabilities: 'NOT_VERIFIED' | 'REPORTED_UNATTESTED';
  /** In-scope cwd cannot attest Git-discovered root, linked gitdir or commondir. */
  readonly gitRootScope: 'NOT_PROVEN';
  /** Git status may execute fsmonitor/config subprocesses without sanitization. */
  readonly safeGitExecution: 'NOT_PROVEN';
  readonly processIsolation: 'NOT_PROVEN';
  readonly remoteWorkerEligibility: 'NOT_PROVEN';
  readonly installedHighBroker: 'NOT_PROVEN';
  readonly effectiveCore: false;
  readonly dispatchAllowed: false;
  readonly requestedIsNotEffective: true;
  readonly broker: NativeAvailabilityDiagnostic;
  readonly reasons: readonly PreflightReason[];
}
function validBytes(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function verified(v: Evidence | undefined): boolean {
  return v === 'verified';
}
function recordId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 &&
    /^[a-z0-9][a-z0-9_.:-]*$/i.test(id);
}
function platformFlag(p: PlatformReadback, cap: Capability): Evidence {
  switch (cap) {
    case 'shell.exec': return p.shell;
    case 'file.read':
    case 'file.write': return p.file;
    case 'process.start': return p.process;
    case 'git.status': return p.git;
    case 'browser.cdp': return p.browserCdp;
    case 'windows.ui': return p.platform === 'win32' ? p.windowsUi : 'unsupported';
    case 'windows.service.control': return p.platform === 'win32' ? p.process : 'unsupported';
  }
}
function boundaryCompatible(platform: Platform, kind: Boundary): boolean {
  switch(kind) {
    case 'vm': return platform !== 'unknown';
    case 'windows-appcontainer': return platform === 'win32';
    case 'linux-namespace':
    case 'container': return platform === 'linux';
    case 'macos-sandbox': return platform === 'darwin';
    default: return false;
  }
}
export async function inspectReadonlyTaskSandboxPreflight(
  input: ReadonlyTaskPreflightInput,
): Promise<ReadonlyTaskPreflight> {
  // The #733 comparator throws on invalid requested Broker scope; do not turn
  // a malformed caller object into evidence or an elevated fallback.
  const broker = await inspectReadonlyNativeAvailability(input.broker, input.expectedBroker);
  const reasons = new Set<PreflightReason>();
  const add = (r: PreflightReason): void => { reasons.add(r); };
  const req = input.request;
  if (!recordId(req.taskId) ||
      !['SAFE','FULL','ROOT','CORE'].includes(req.requestedMode) ||
      !['standard','elevated','unknown'].includes(req.requiredPrivilege) ||
      typeof req.remoteWorkerRequested !== 'boolean' ||
      !['shell.exec','file.read','file.write','process.start','git.status',
        'browser.cdp','windows.ui','windows.service.control'].includes(req.capability)) {
    add('TASK_REQUEST_INVALID');
  }

  const r = input.root;
  if (!r) add('TASK_ROOT_PROVIDER_UNAVAILABLE');
  else {
    if (!verified(r.taskSpecificRoot) || !verified(r.canonicalRootIdentity) ||
        !verified(r.rootRelativePolicy) || !verified(r.reparseAndAncestorBoundary)) {
      add('TASK_ROOT_NOT_VERIFIED');
    }
    if (r.externalPathGrant === 'unverified') add('EXTERNAL_PATH_GRANT_NOT_VERIFIED');
    // A path filter is *never* a process/network/environment sandbox.
    if (r.pathFilterOnly === true) add('PATH_FILTER_NOT_PROCESS_ISOLATION');
  }
  const d = input.disk;
  let diskBudget: ReadonlyTaskPreflight['diskBudget'] = 'UNAVAILABLE';
  if (!d) add('DISK_PROVIDER_UNAVAILABLE');
  else if (!validBytes(d.freeBytes) ||
           !validBytes(d.requestedBudgetBytes) || d.requestedBudgetBytes === 0 ||
           !validBytes(d.requiredFreeFloorBytes)) {
    add('DISK_BUDGET_INVALID_OR_UNAVAILABLE');
  } else {
    if (d.freeBytes < d.requiredFreeFloorBytes ||
        d.freeBytes - d.requiredFreeFloorBytes < d.requestedBudgetBytes) {
      diskBudget = 'INSUFFICIENT';
      add('DISK_BUDGET_INSUFFICIENT');
    } else {
      diskBudget = 'REPORTED_UNATTESTED';
    }
    if (!verified(d.atomicBudgetReservation) || !verified(d.taskRootVolumeMatched)) {
      add('DISK_RESERVATION_NOT_VERIFIED');
    }
  }

  const p = input.platform;
  if (!p) add('PLATFORM_PROVIDER_UNAVAILABLE');
  else if (p.platform === 'unknown' || !verified(platformFlag(p, req.capability))) {
    add('PLATFORM_CAPABILITY_NOT_VERIFIED');
  }

  // The existing workspace.snapshot executor currently expands scope via
  // git --show-toplevel and can run repository-controlled core.fsmonitor.
  // Neither PathPolicy nor a platform "git" flag proves these side effects safe.
  // workspace.snapshot is deliberately NOT an approved capability here.
  const gitRelevant = req.capability === 'git.status' ||
    String(req.capability) === 'workspace.snapshot';
  if (gitRelevant) {
    const git = input.git;
    if (!git || !verified(git.discoveredRootWithinScopedGrant) ||
        !verified(git.linkedWorktreeGitdirAndCommonDirScoped)) {
      add('GIT_DISCOVERED_ROOT_NOT_VERIFIED');
    }
    if (!git || !verified(git.fsmonitorAndHookExecutionDisabled) ||
        !verified(git.gitConfigAndEnvironmentSanitized) ||
        !verified(git.gitSubprocessesContained)) {
      add('GIT_SUBPROCESS_SANITIZATION_NOT_VERIFIED');
    }
  }

  const proc = input.process;
  if (!proc) add('PROCESS_BOUNDARY_PROVIDER_UNAVAILABLE');
  else {
    if (proc.kind === 'none' || proc.kind === 'path-filter') {
      add('PATH_FILTER_NOT_PROCESS_ISOLATION');
    } else if (proc.kind === 'windows-job') {
      // Job containment/kill-on-close is not filesystem/network/secret isolation.
      add('WINDOWS_JOB_NOT_FULL_SANDBOX');
    } else if (!p || !boundaryCompatible(p.platform, proc.kind)) {
      add('PLATFORM_ISOLATION_UNSUPPORTED');
    }
    if (!verified(proc.osBoundaryVerified) || !verified(proc.descendantsContained) ||
        !verified(proc.filesystemIsolated) || !verified(proc.networkIsolated) ||
        !verified(proc.environmentSecretsIsolated) || !verified(proc.gitHooksConstrained)) {
      add('PROCESS_ISOLATION_NOT_VERIFIED');
    }
    if (p && (
      proc.kind === 'windows-appcontainer' && !verified(p.windowsAppContainer) ||
      proc.kind === 'linux-namespace' && !verified(p.linuxNamespace) ||
      proc.kind === 'macos-sandbox' && !verified(p.macosSandbox) ||
      proc.kind === 'vm' && !verified(p.virtualMachine)
    )) add('PLATFORM_ISOLATION_UNSUPPORTED');
  }

  if (req.remoteWorkerRequested) {
    const w = input.remote;
    if (!w) add('REMOTE_WORKER_PROVIDER_UNAVAILABLE');
    else if (!verified(w.workerIdentityEnrolled) ||
             !verified(w.ownerDeviceSessionAuthenticated) ||
             !verified(w.capabilityScoped) ||
             !verified(w.workerOnlineReadback) ||
             !verified(w.independentRevocationAndCas) ||
             !verified(w.quotaOrBudgetReserved) ||
             !verified(w.remoteEndpointAuthenticated)) {
      add('REMOTE_WORKER_ELIGIBILITY_NOT_VERIFIED');
    }
  }
  if (req.requiredPrivilege !== 'standard' || req.requestedMode === 'CORE' ||
      req.requestedMode === 'ROOT') {
    add('INSTALLED_HIGH_BROKER_NOT_PROVEN');
    add('OWNER_GRANT_NOT_PHYSICALLY_VERIFIED');
    add('EXTERNAL_CAS_DISPATCH_NOT_PROVEN');
  }
  add('SOURCE_OBSERVATIONS_NOT_EXECUTION_AUTHORITY');
  const taskRoot = r && verified(r.taskSpecificRoot) &&
    verified(r.canonicalRootIdentity) &&
    verified(r.rootRelativePolicy) &&
    verified(r.reparseAndAncestorBoundary)
      ? 'REPORTED_UNATTESTED' as const : 'NOT_VERIFIED' as const;
  return {
    schema: 1,
    source: 'untrusted_readonly_inventory',
    requestedMode: req.requestedMode,
    requestedCapability: req.capability,
    requiredPrivilege: req.requiredPrivilege,
    status: reasons.size === 1 ? 'REVIEW_ONLY' : 'BLOCKED',
    taskRoot,
    filesystemContainment: 'NOT_PROVEN',
    diskReservation: 'NOT_PROVEN',
    diskBudget,
    platformCapabilities: p && p.platform !== 'unknown' &&
      verified(platformFlag(p, req.capability))
        ? 'REPORTED_UNATTESTED' : 'NOT_VERIFIED',
    gitRootScope: 'NOT_PROVEN',
    safeGitExecution: 'NOT_PROVEN',
    processIsolation: 'NOT_PROVEN',
    remoteWorkerEligibility: 'NOT_PROVEN',
    installedHighBroker: 'NOT_PROVEN',
    effectiveCore: false,
    dispatchAllowed: false,
    requestedIsNotEffective: true,
    broker,
    reasons: [...reasons],
  };
}
