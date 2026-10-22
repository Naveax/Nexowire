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
