import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectReadonlyTaskSandboxPreflight,
  type ReadonlyTaskPreflightInput,
  type ProcessBoundaryReadback,
} from '../src/diagnostics/task-sandbox-readonly-preflight.js';

const verified = 'verified' as const;
const evidence = {
  pid: 1423,
  creationFiletime: '134058540000000000',
  volumeSerialHex: 'a1b2c3d4',
  fileIdHex: '0011223344556677',
  imageSha256: 'a'.repeat(64),
};
function fixture(overrides: Partial<ReadonlyTaskPreflightInput> = {}): ReadonlyTaskPreflightInput {
  return {
    request: {
      taskId: 'test-task-1', requestedMode: 'SAFE',
      capability: 'file.read', requiredPrivilege: 'standard',
      remoteWorkerRequested: false,
    },
    expectedBroker: {
      identity: evidence, publisherThumbprint: 'b'.repeat(40),
      ownerId: 'test-owner', deviceId: 'test-device',
      minGeneration: 1, statusRequestId: 'request-1',
      nowMs: 1792670400000, maxAgeMs: 5000,
    },
    root: {
      taskSpecificRoot: verified, canonicalRootIdentity: verified,
      rootRelativePolicy: verified, reparseAndAncestorBoundary: verified,
      externalPathGrant: 'none', pathFilterOnly: false,
    },
    disk: {
      freeBytes: 4_000_000, requestedBudgetBytes: 1_000_000,
      requiredFreeFloorBytes: 2_000_000,
      taskRootVolumeMatched: verified, atomicBudgetReservation: verified,
    },
    platform: {
      platform: 'win32',
      shell: verified, file: verified, git: verified, process: verified,
      browserCdp: 'unavailable', windowsUi: 'unavailable',
      windowsJob: verified, windowsAppContainer: verified,
      linuxNamespace: 'unsupported', macosSandbox: 'unsupported',
      virtualMachine: 'unavailable',
    },
    process: {
      kind: 'windows-appcontainer', osBoundaryVerified: verified,
      descendantsContained: verified, filesystemIsolated: verified,
      networkIsolated: verified, environmentSecretsIsolated: verified,
      gitHooksConstrained: verified,
    },
    ...overrides,
  };
}
const inspect = (v: Partial<ReadonlyTaskPreflightInput> = {}) =>
  inspectReadonlyTaskSandboxPreflight(fixture(v));
function neverEffective(r: Awaited<ReturnType<typeof inspect>>) {
  assert.equal(r.source, 'untrusted_readonly_inventory');
  assert.equal(r.effectiveCore, false);
  assert.equal(r.dispatchAllowed, false);
  assert.equal(r.processIsolation, 'NOT_PROVEN');
  assert.equal(r.installedHighBroker, 'NOT_PROVEN');
  assert.equal(r.remoteWorkerEligibility, 'NOT_PROVEN');
}
test('even all-green source observations are only REVIEW_ONLY, never execution authorization', async () => {
  const r = await inspect();
  assert.equal(r.status, 'REVIEW_ONLY');
  assert.equal(r.taskRoot, 'REPORTED_UNATTESTED');
  assert.equal(r.diskBudget, 'REPORTED_UNATTESTED');
  assert.equal(r.platformCapabilities, 'REPORTED_UNATTESTED');
  assert.equal(r.broker.provider, 'UNAVAILABLE');
  neverEffective(r);
});
test('no native sandbox providers or resource telemetry is BLOCKED', async () => {
  const r = await inspect({root:undefined,disk:undefined,platform:undefined,process:undefined});
  assert.equal(r.status,'BLOCKED');
  for (const code of [
    'TASK_ROOT_PROVIDER_UNAVAILABLE','DISK_PROVIDER_UNAVAILABLE',
    'PLATFORM_PROVIDER_UNAVAILABLE','PROCESS_BOUNDARY_PROVIDER_UNAVAILABLE',
  ]) assert.ok(r.reasons.includes(code as never));
  neverEffective(r);
});
test('task root path policy does not create process isolation', async () => {
  const r = await inspect({
    root:{...fixture().root!,pathFilterOnly:true},
    process:{...fixture().process!,kind:'path-filter'},
  });
  assert.ok(r.reasons.includes('PATH_FILTER_NOT_PROCESS_ISOLATION'));
  assert.equal(r.status,'BLOCKED');
  neverEffective(r);
});
test('Windows Job cannot be mislabeled a complete filesystem/network/secret sandbox', async () => {
  const r = await inspect({process:{...fixture().process!,kind:'windows-job'}});
  assert.ok(r.reasons.includes('WINDOWS_JOB_NOT_FULL_SANDBOX'));
  neverEffective(r);
});
test('unverified reparse ancestor or relative path boundary is BLOCKED', async () => {
  const r = await inspect({root:{...fixture().root!,reparseAndAncestorBoundary:'unavailable'}});
  assert.ok(r.reasons.includes('TASK_ROOT_NOT_VERIFIED'));
  assert.equal(r.taskRoot,'NOT_VERIFIED');
});
test('path outside task root needs separately scoped grant; unknown cannot proceed', async () => {
  const r = await inspect({root:{...fixture().root!,externalPathGrant:'unverified'}});
  assert.ok(r.reasons.includes('EXTERNAL_PATH_GRANT_NOT_VERIFIED'));
});
test('disk budget rejects low free space after required minimum reserve', async () => {
  const r = await inspect({disk:{
    ...fixture().disk!,freeBytes:2_100_000,requestedBudgetBytes:1_000_000,
  }});
  assert.ok(r.reasons.includes('DISK_BUDGET_INSUFFICIENT'));
  assert.equal(r.diskBudget,'INSUFFICIENT');
  neverEffective(r);
});
test('missing disk metrics never imply zero-size or reserved capacity', async () => {
  const r = await inspect({disk:{...fixture().disk!,freeBytes:null}});
  assert.ok(r.reasons.includes('DISK_BUDGET_INVALID_OR_UNAVAILABLE'));
  assert.equal(r.diskBudget,'UNAVAILABLE');
});
test('invalid unsafe/fractional/negative disk byte readings fail closed', async () => {
  for(const bytes of [-1,NaN,Number.MAX_SAFE_INTEGER+1,1.5]){
    const r = await inspect({disk:{...fixture().disk!,freeBytes:bytes}});
    assert.ok(r.reasons.includes('DISK_BUDGET_INVALID_OR_UNAVAILABLE'));
    neverEffective(r);
  }
});
test('disk free-byte snapshot is not an atomic task reservation', async () => {
  const r = await inspect({disk:{...fixture().disk!,atomicBudgetReservation:'unavailable'}});
  assert.ok(r.reasons.includes('DISK_RESERVATION_NOT_VERIFIED'));
  assert.equal(r.diskBudget,'REPORTED_UNATTESTED');
});
test('Windows UI capability cannot be borrowed from a Linux worker', async () => {
  const p=fixture().platform!;
  const r = await inspect({
    request:{...fixture().request,capability:'windows.ui'},
    platform:{...p,platform:'linux',linuxNamespace:verified,windowsUi:verified},
    process:{...fixture().process!,kind:'linux-namespace'},
  });
  assert.ok(r.reasons.includes('PLATFORM_CAPABILITY_NOT_VERIFIED'));
  assert.equal(r.platformCapabilities,'NOT_VERIFIED');
});
test('Windows AppContainer cannot be selected as Linux namespace', async () => {
  const p=fixture().platform!;
  const r=await inspect({
    platform:{...p,platform:'linux',linuxNamespace:verified},
    process:{...fixture().process!,kind:'windows-appcontainer'},
  });
  assert.ok(r.reasons.includes('PLATFORM_ISOLATION_UNSUPPORTED'));
});
test('unknown network and environment isolation cannot become a verified sandbox', async () => {
  const r=await inspect({process:{
    ...fixture().process!,networkIsolated:'unavailable',environmentSecretsIsolated:'unverified',
  }});
  assert.ok(r.reasons.includes('PROCESS_ISOLATION_NOT_VERIFIED'));
});
test('remote worker requested without remote provider is BLOCKED, not cloud-ready', async () => {
  const r=await inspect({
    request:{...fixture().request,remoteWorkerRequested:true},
  });
  assert.ok(r.reasons.includes('REMOTE_WORKER_PROVIDER_UNAVAILABLE'));
  assert.equal(r.remoteWorkerEligibility,'NOT_PROVEN');
});
test('remote worker needs separately attested enrollment, owner scope and CAS', async () => {
  const r=await inspect({
    request:{...fixture().request,remoteWorkerRequested:true},
    remote:{
      workerIdentityEnrolled:verified,ownerDeviceSessionAuthenticated:verified,
      capabilityScoped:verified,workerOnlineReadback:verified,
      independentRevocationAndCas:'unavailable',quotaOrBudgetReserved:verified,
      remoteEndpointAuthenticated:verified,
    },
  });
  assert.ok(r.reasons.includes('REMOTE_WORKER_ELIGIBILITY_NOT_VERIFIED'));
  neverEffective(r);
});
test('even all-green injected remote worker claims cannot authenticate paid/cloud execution', async () => {
  const r=await inspect({
    request:{...fixture().request,remoteWorkerRequested:true},
    remote:{
      workerIdentityEnrolled:verified,ownerDeviceSessionAuthenticated:verified,
      capabilityScoped:verified,workerOnlineReadback:verified,
      independentRevocationAndCas:verified,quotaOrBudgetReserved:verified,
      remoteEndpointAuthenticated:verified,
    },
  });
  assert.equal(r.status,'REVIEW_ONLY');
  assert.equal(r.remoteWorkerEligibility,'NOT_PROVEN');
  neverEffective(r);
});
test('requested CORE cannot mean EFFECTIVE even if platform/budget/isolation reported valid', async () => {
  const r=await inspect({
    request:{...fixture().request,requestedMode:'CORE',requiredPrivilege:'elevated',capability:'windows.service.control'},
  });
  assert.equal(r.requestedMode,'CORE');
  for(const code of ['INSTALLED_HIGH_BROKER_NOT_PROVEN',
    'OWNER_GRANT_NOT_PHYSICALLY_VERIFIED','EXTERNAL_CAS_DISPATCH_NOT_PROVEN']) {
    assert.ok(r.reasons.includes(code as never));
  }
  assert.equal(r.broker.provider,'UNAVAILABLE');
  assert.equal(r.status,'BLOCKED');
  neverEffective(r);
});
test('requested capability is retained independently from requested mode', async () => {
  const r=await inspect({
    request:{...fixture().request,requestedMode:'FULL',capability:'git.status'},
  });
  assert.equal(r.requestedMode,'FULL');
  assert.equal(r.requestedCapability,'git.status');
  assert.equal(r.effectiveCore,false);
});
test('unsupported Linux/macOS Windows privilege capabilities never inherit Windows Job flags', async () => {
  for(const platform of ['linux','darwin'] as const){
    const r=await inspect({
      request:{...fixture().request,capability:'windows.service.control',requiredPrivilege:'elevated'},
      platform:{...fixture().platform!,platform},
    });
    assert.ok(r.reasons.includes('PLATFORM_CAPABILITY_NOT_VERIFIED'));
    neverEffective(r);
  }
});


/**
 * #786 independent owner QA finds that workspace.snapshot can discover a Git
 * root outside the allowed task directory. Do NOT duplicate the real Git
 * worktree fixture here: this is the #10 read-only public/inventory boundary.
 * "Accessible" is not "confined", Job is not a sandbox, free disk is not
 * reserved capacity, and an untrusted remote claim is not enrollment.
 */
test('accessible workspace and Windows Job with unreserved disk and claimed remote worker never imply sandbox availability', async () => {
  const base = fixture();
  const report = await inspect({
    request: {
      ...base.request,
      // Existing executor capability is intentionally NOT integrated into the
      // #10 approved capability set. Unsupported inputs must fail closed.
      capability: 'workspace.snapshot' as ReadonlyTaskPreflightInput['request']['capability'],
      remoteWorkerRequested: true,
    },
    root: {
      ...base.root!,
      taskSpecificRoot: verified,
      canonicalRootIdentity: verified,
      rootRelativePolicy: verified,
      reparseAndAncestorBoundary: verified,
      pathFilterOnly: true,
    },
    process: {
      ...base.process!,
      kind: 'windows-job',
      osBoundaryVerified: verified,
      descendantsContained: verified,
      filesystemIsolated: 'unavailable',
      networkIsolated: 'unavailable',
      environmentSecretsIsolated: 'unavailable',
      gitHooksConstrained: 'unavailable',
    },
    disk: {
      ...base.disk!,
      freeBytes: 4_000_000,
      atomicBudgetReservation: 'unavailable',
    },
    remote: {
      workerIdentityEnrolled: verified,
      ownerDeviceSessionAuthenticated: verified,
      capabilityScoped: verified,
      workerOnlineReadback: verified,
      independentRevocationAndCas: verified,
      quotaOrBudgetReserved: verified,
      remoteEndpointAuthenticated: verified,
    },
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.requestedCapability, 'workspace.snapshot');
  assert.equal(report.taskRoot, 'REPORTED_UNATTESTED');
  assert.equal(report.filesystemContainment, 'NOT_PROVEN');
  assert.equal(report.diskBudget, 'REPORTED_UNATTESTED');
  assert.equal(report.diskReservation, 'NOT_PROVEN');
  assert.equal(report.processIsolation, 'NOT_PROVEN');
  assert.equal(report.remoteWorkerEligibility, 'NOT_PROVEN');
  assert.equal(report.dispatchAllowed, false);
  assert.equal(report.effectiveCore, false);
  for (const reason of [
    'TASK_REQUEST_INVALID',
    'PLATFORM_CAPABILITY_NOT_VERIFIED',
    'PATH_FILTER_NOT_PROCESS_ISOLATION',
    'WINDOWS_JOB_NOT_FULL_SANDBOX',
    'DISK_RESERVATION_NOT_VERIFIED',
    'PROCESS_ISOLATION_NOT_VERIFIED',
  ] as const) {
    assert.ok(report.reasons.includes(reason), reason);
  }
});


/** #786 + #800 are separate real executor defects, not synthetic Git fixtures here. */
test('reported Git availability without root/fsmonitor verification is BLOCKED despite positive path, disk and Windows Job', async () => {
  const base = fixture();
  const input: Partial<ReadonlyTaskPreflightInput> = {
    request: { ...base.request, capability: 'git.status' },
    // All path and disk measurements are optimistic, but still untrusted.
    root: { ...base.root!, pathFilterOnly: false },
    disk: { ...base.disk!, atomicBudgetReservation: verified },
    platform: { ...base.platform!, git: verified, windowsJob: verified },
    process: {
      ...base.process!, kind: 'windows-job',
      osBoundaryVerified: verified, descendantsContained: verified,
      gitHooksConstrained: verified,
    },
    // A git executable being present gives no root or fsmonitor protection.
    git: {
      discoveredRootWithinScopedGrant: 'unavailable',
      linkedWorktreeGitdirAndCommonDirScoped: 'unverified',
      fsmonitorAndHookExecutionDisabled: 'unavailable',
      gitConfigAndEnvironmentSanitized: 'unverified',
      gitSubprocessesContained: 'unavailable',
    },
  };
  const report = await inspect(input);
  assert.equal(report.requestedCapability, 'git.status');
  assert.equal(report.taskRoot, 'REPORTED_UNATTESTED');
  assert.equal(report.diskBudget, 'REPORTED_UNATTESTED');
  assert.equal(report.platformCapabilities, 'REPORTED_UNATTESTED');
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.reasons.includes('GIT_DISCOVERED_ROOT_NOT_VERIFIED'));
  assert.ok(report.reasons.includes('GIT_SUBPROCESS_SANITIZATION_NOT_VERIFIED'));
  assert.ok(report.reasons.includes('WINDOWS_JOB_NOT_FULL_SANDBOX'));
  assert.equal(report.gitRootScope, 'NOT_PROVEN');
  assert.equal(report.safeGitExecution, 'NOT_PROVEN');
  assert.equal(report.filesystemContainment, 'NOT_PROVEN');
  assert.equal(report.diskReservation, 'NOT_PROVEN');
  assert.equal(report.processIsolation, 'NOT_PROVEN');
  assert.equal(report.remoteWorkerEligibility, 'NOT_PROVEN');
  assert.equal(report.dispatchAllowed, false);
  // Reported "verified" booleans are not a source of execution authority.
  const forgedGreen = await inspect({
    ...input,
    git: {
      discoveredRootWithinScopedGrant: verified,
      linkedWorktreeGitdirAndCommonDirScoped: verified,
      fsmonitorAndHookExecutionDisabled: verified,
      gitConfigAndEnvironmentSanitized: verified,
      gitSubprocessesContained: verified,
    },
  });
  assert.equal(forgedGreen.gitRootScope, 'NOT_PROVEN');
  assert.equal(forgedGreen.safeGitExecution, 'NOT_PROVEN');
  assert.equal(forgedGreen.dispatchAllowed, false);
  assert.equal(forgedGreen.effectiveCore, false);
});


/**
 * #821 proves repository filter.clean can run with an authorized Git root;
 * #814 proves nested refs/heads and loose-object symlink escape with the
 * #811 repaired executor. This is a #10 READOUT test only, not another
 * real workspace.snapshot fixture or an OS sandbox acceptance.
 */
test('filter.clean and nested Git metadata remain BLOCKED despite green parent Git/path/disk reports', async () => {
  const base = fixture();
  const previousProof = {
    discoveredRootWithinScopedGrant: verified,
    linkedWorktreeGitdirAndCommonDirScoped: verified,
    fsmonitorAndHookExecutionDisabled: verified,
    gitConfigAndEnvironmentSanitized: verified,
    gitSubprocessesContained: verified,
  } as const;
  const injected = {
    request: {...base.request, capability: 'git.status' as const},
    root: {...base.root!, pathFilterOnly: false},
    disk: {...base.disk!, atomicBudgetReservation: verified},
    platform: {...base.platform!, git: verified},
    process: {...base.process!, gitHooksConstrained: verified},
  };
  for (const [missingField, code] of [
    ['repositoryFilterCommandsBlocked', 'GIT_REPOSITORY_FILTER_EXECUTION_NOT_VERIFIED'],
    ['nestedRefsAndObjectsScoped', 'GIT_NESTED_REFS_OBJECTS_SCOPE_NOT_VERIFIED'],
  ] as const) {
    const git = {
      ...previousProof,
      repositoryFilterCommandsBlocked: verified,
      nestedRefsAndObjectsScoped: verified,
      [missingField]: 'unavailable' as const,
    };
    const result = await inspect({...injected, git});
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.reasons.includes(code), code);
    // Original reported signals remain separate from physical authorization.
    assert.equal(result.taskRoot, 'REPORTED_UNATTESTED');
    assert.equal(result.diskBudget, 'REPORTED_UNATTESTED');
    assert.equal(result.platformCapabilities, 'REPORTED_UNATTESTED');
    assert.equal(result.gitRootScope, 'NOT_PROVEN');
    assert.equal(result.safeGitExecution, 'NOT_PROVEN');
    assert.equal(result.filesystemContainment, 'NOT_PROVEN');
    assert.equal(result.processIsolation, 'NOT_PROVEN');
    assert.equal(result.diskReservation, 'NOT_PROVEN');
    assert.equal(result.remoteWorkerEligibility, 'NOT_PROVEN');
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.effectiveCore, false);
  }

  const allClaimedGreen = await inspect({
    ...injected,
    git: {
      ...previousProof,
      repositoryFilterCommandsBlocked: verified,
      nestedRefsAndObjectsScoped: verified,
    },
  });
  // Even optimistic injected assertions never authorize or physically attest.
  assert.equal(allClaimedGreen.gitRootScope, 'NOT_PROVEN');
  assert.equal(allClaimedGreen.safeGitExecution, 'NOT_PROVEN');
  assert.equal(allClaimedGreen.filesystemContainment, 'NOT_PROVEN');
  assert.equal(allClaimedGreen.processIsolation, 'NOT_PROVEN');
  assert.equal(allClaimedGreen.dispatchAllowed, false);
  assert.equal(allClaimedGreen.effectiveCore, false);
});


/**
 * #845 old-#811 Linux: healthy Git passes, nested commit-graph symlink is
 * accepted. Windows observed a separate healthy-root/null-config precondition
 * issue; its hosted browser-live failure was unrelated PowerShell timeout.
 * No Git command, file/ACL mutation, OS or native provider is used here.
 */
test('Git commit-graph unknown and Windows null-config positive are independent read-only evidence', async () => {
  const base = fixture();
  const priorGitReported = {
    discoveredRootWithinScopedGrant: verified,
    linkedWorktreeGitdirAndCommonDirScoped: verified,
    fsmonitorAndHookExecutionDisabled: verified,
    gitConfigAndEnvironmentSanitized: verified,
    gitSubprocessesContained: verified,
    repositoryFilterCommandsBlocked: verified,
    nestedRefsAndObjectsScoped: verified,
  } as const;
  const common = {
    request: {...base.request, capability: 'git.status' as const},
    root: {...base.root!, pathFilterOnly: false},
    disk: {...base.disk!, atomicBudgetReservation: verified},
    platform: {...base.platform!, git: verified},
    process: {...base.process!, gitHooksConstrained: verified},
  };

  // Linux positive fixture for ordinary repository does not prove the
  // separately accessed commit-graph metadata FILE's no-follow boundary.
  const linux = await inspect({
    ...common,
    platform: {...common.platform, platform:'linux' as const, linuxNamespace: verified},
    process: {...common.process, kind: 'linux-namespace' as const},
    git: {...priorGitReported},
  });
  assert.equal(linux.status, 'BLOCKED');
  assert.ok(linux.reasons.includes('GIT_COMMIT_GRAPH_FILE_SCOPE_NOT_VERIFIED'));
  assert.equal(linux.reasons.includes('GIT_WINDOWS_NULL_CONFIG_BASELINE_NOT_VERIFIED'), false);
  assert.equal(linux.gitCommitGraphScope, 'NOT_PROVEN');
  assert.equal(linux.windowsGitNullConfigBaseline, 'NOT_APPLICABLE');
  assert.equal(linux.safeGitExecution, 'NOT_PROVEN');
  assert.equal(linux.dispatchAllowed, false);

  // A Windows null-config positive is independent of the commit-graph
  // negative: even if the nested FILE is *reported* checked, an absent
  // healthy-run baseline must not be promoted to a security PASS.
  const windows = await inspect({
    ...common,
    git: {...priorGitReported, nestedCommitGraphFileScoped: verified},
  });
  assert.equal(windows.status, 'BLOCKED');
  assert.equal(windows.reasons.includes('GIT_COMMIT_GRAPH_FILE_SCOPE_NOT_VERIFIED'), false);
  assert.ok(windows.reasons.includes('GIT_WINDOWS_NULL_CONFIG_BASELINE_NOT_VERIFIED'));
  assert.equal(windows.windowsGitNullConfigBaseline, 'NOT_OBSERVED');
  assert.equal(windows.gitCommitGraphScope, 'NOT_PROVEN');
  assert.equal(windows.safeGitExecution, 'NOT_PROVEN');
  assert.equal(windows.installedHighBroker, 'NOT_PROVEN');
  assert.equal(windows.dispatchAllowed, false);
  assert.equal(windows.effectiveCore, false);

  // Even a forged optimistic Windows healthy-Git observation is recorded
  // only as REPORTED_UNATTESTED, never as native, OS or CAS authority.
  const positiveReported = await inspect({
    ...common,
    git: {
      ...priorGitReported,
      nestedCommitGraphFileScoped: verified,
      windowsNullConfigHealthyBaseline: verified,
    },
  });
  assert.equal(positiveReported.windowsGitNullConfigBaseline, 'REPORTED_UNATTESTED');
  assert.equal(positiveReported.gitCommitGraphScope, 'NOT_PROVEN');
  assert.equal(positiveReported.safeGitExecution, 'NOT_PROVEN');
  assert.equal(positiveReported.filesystemContainment, 'NOT_PROVEN');
  assert.equal(positiveReported.processIsolation, 'NOT_PROVEN');
  assert.equal(positiveReported.remoteWorkerEligibility, 'NOT_PROVEN');
  assert.equal(positiveReported.dispatchAllowed, false);
  assert.equal(positiveReported.effectiveCore, false);
});
