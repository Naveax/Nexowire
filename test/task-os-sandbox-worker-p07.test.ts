import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  prepareTaskSandboxWorker,
  executeTaskWithOsSandbox,
  revokeTaskSandboxAndDrain,
  OsTaskSandboxBlockedError,
  OS_SANDBOX_WITNESSES,
} from '../src/agent/task-os-sandbox-worker.js';

const sha = 'a'.repeat(64);
function intent(platform: 'win32' | 'linux' | 'darwin' = 'win32') {
  return {
    schema: 1, platform, taskId: 'task1', originalRequestId: 'request1',
    ownerId: 'owner1', ownerEpoch: 1, deviceId: 'device1', grantId: 'grant1',
    grantGeneration: 1, executableDigest: sha, baseWorktreeSha: sha,
    workerPrivilege: 'standard', taskRoot: {
      canonicalPath: platform === 'win32' ? 'C:\\isolated' : '/isolated',
      volumeOrMountIdentity: 'vol1', rootFileIdOrInode: 'id1',
    },
    args: ['--version'], envAllowlist: {},
    network: { default: 'deny', allowedEndpoints: [] },
    budgets: { cpuMs: 1000, wallMs: 3000, memoryBytes: 64 * 1024 * 1024,
      maxProcesses: 2, outputBytes: 1024, diskBytes: 1024 * 1024 },
  };
}

test('#07 source provider selects each OS witness set but cannot launch', () => {
  for (const platform of ['win32','linux','darwin'] as const) {
    const p = prepareTaskSandboxWorker(intent(platform), {nativeVerified:true});
    assert.equal(p.status,'BLOCKED');
    assert.equal(p.requiresNativeKernelReadback,true);
    assert.equal(p.workerLaunchEnabled,false);
    assert.equal(p.systemEffectsAllowed,false);
    assert.equal(p.acceptsParentEnv,false);
    assert.equal(p.acceptsInheritedHandles,false);
    assert.equal(p.acceptsPrivilegedBrokerIPC,false);
    assert.equal(p.cannotBeUsedAsOSPermit,true);
    assert.ok(p.platformEvidenceRequired.length >= 3);
    assert.equal(p.platformEvidenceRequired,OS_SANDBOX_WITNESSES[platform]);
    assert.equal(p.assessment.dispatchAllowed,false);
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.platformEvidenceRequired));
  }
});

test('#07 execution path always rejects and never accepts invented native witness', async () => {
  let sideEffectCalls = 0;
  const hostile = Object.freeze({
    nativeVerified:true, dispatchAllowed:true, effectiveCore:true,
    ownerEpochVerified:true, kernelAttested:true, signedReceipt:'fake',
    workerAlive:true, descendantsContained:true, revokeDrainVerified:true,
    spawn(){ sideEffectCalls++; }, resume(){ sideEffectCalls++; },
  });
  for (const platform of ['win32','linux','darwin'] as const) {
    await assert.rejects(executeTaskWithOsSandbox(intent(platform), hostile), e => {
      assert.ok(e instanceof OsTaskSandboxBlockedError);
      assert.equal(e.code,'OS_TASK_SANDBOX_UNAVAILABLE');
      assert.equal(e.safeBlueprint.workerLaunchEnabled,false);
      return true;
    });
  }
  assert.equal(sideEffectCalls,0);
});

test('#07 no inheritance of CORE, Broker, guardian Job or host environment claims', async () => {
  const hostile = {workerPrivilege:'CORE', envAllowlist: {TOKEN:'synthetic'},
    network:{default:'allow',allowedEndpoints:['127.0.0.1']}};
  const launch = prepareTaskSandboxWorker({...intent(),...hostile}, {
    privilegedHandleAccessible:true,brokerHandleInherited:true,
    guardianJobHandleDuplicable:true,breakawayAllowed:true,nestedJobUnverified:true,
  });
  assert.ok(launch.assessment.blockers.includes('PRIVILEGED_WORKER_FORBIDDEN'));
  assert.ok(launch.assessment.blockers.includes('AMBIENT_ENVIRONMENT_FORBIDDEN'));
  assert.ok(launch.assessment.blockers.includes('NETWORK_MUST_BE_DEFAULT_DENY'));
  assert.ok(launch.assessment.blockers.includes('GUARDIAN_OR_BROKER_HANDLE_EXPOSURE'));
  assert.ok(launch.assessment.blockers.includes('BREAKAWAY_OR_NESTED_JOB_UNVERIFIED'));
  await assert.rejects(executeTaskWithOsSandbox({...intent(),...hostile}),
    (e:unknown)=>e instanceof OsTaskSandboxBlockedError);
});

test('#07 unknown/lost ACK supersedes forged success and remains unreplayable', async () => {
  for(const mutationState of ['unknown','ack_lost','in_progress']){
    const report = {mutationState,nativeVerified:true,descendantsContained:true,
      revokeDrainVerified:true,dispatchAllowed:true,replayAllowed:true};
    const p = prepareTaskSandboxWorker(intent(),report);
    assert.equal(p.status,'RECONCILE_REQUIRED');
    await assert.rejects(executeTaskWithOsSandbox(intent(), report), e => {
      assert.ok(e instanceof OsTaskSandboxBlockedError);
      assert.equal(e.code,'OS_TASK_RECONCILIATION_REQUIRED');
      assert.equal(e.safeBlueprint.assessment.mayReplayOriginalMutation,false);
      return true;
    });
  }
});

test('#07 revoke never claims process-tree cleanup or releases escrow without OS proof', async () => {
  for(const report of [undefined,{}, {stopped:true,descendantsGone:true,
    kernelVerified:true,brokerHandlesClosed:true,releaseQuota:true}]){
    const r = await revokeTaskSandboxAndDrain('request1',report);
    assert.equal(r.state,'RECONCILE_REQUIRED');
    assert.equal(r.workerStoppedVerified,false);
    assert.equal(r.descendantsStoppedVerified,false);
    assert.equal(r.brokerHandlesClosedVerified,false);
    assert.equal(r.cleanupVerified,false);
    assert.equal(r.replayAllowed,false);
    assert.equal(r.quotaOrGrantReleaseAllowed,false);
    assert.ok(Object.isFrozen(r));
  }
});

test('#07 no spawn, shell invocation, privileged process APIs or fallback in worker port', () => {
  const file = readFileSync(new URL('../src/agent/task-os-sandbox-worker.ts',import.meta.url),'utf8');
  assert.doesNotMatch(file,/from\s*['"]node:child_process['"]|require\s*\(\s*['"]node:child_process/);
  assert.doesNotMatch(file,/\b(?:execFile|execSync|spawnSync|fork)\s*\(/);
  // No file, network, desktop or native helper I/O is performed by the port.
  assert.doesNotMatch(file,/from\s*['"]node:(?:fs|net|dgram|http|tls)['"]/);
  assert.match(file,/throw new OsTaskSandboxBlockedError\(/);
});
