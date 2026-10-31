import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskSandboxSourceOnly } from '../src/agent/task-os-sandbox-policy.js';
const hash = 'a'.repeat(64);
const intent = {
  schema: 1, platform: 'win32', taskId: 'task1', originalRequestId: 'request1',
  ownerId: 'owner1', deviceId: 'device1', grantId: 'grant1',
  ownerEpoch: 1, grantGeneration: 1, executableDigest: hash,
  baseWorktreeSha: hash, workerPrivilege: 'standard', args: [], envAllowlist: {},
  taskRoot: {canonicalPath: 'C:\\task', volumeOrMountIdentity: 'vol1', rootFileIdOrInode: 'fid1'},
  network: {default: 'deny', allowedEndpoints: []},
  budgets: {cpuMs: 1000, wallMs: 2000, memoryBytes: 65536,
    maxProcesses: 2, outputBytes: 4096, diskBytes: 4096},
};
test('AI-07 unknown or terminal-looking mutation reports always reconcile', () => {
  for (const mutationState of [
    'unknown', 'ack_lost', 'in_progress', 'completed', 'failed',
    'cancelled', 'timed_out', 'not_started', 'NEW_UNRECOGNIZED_STATE', null, 0, undefined,
  ]) {
    const decision = assessTaskSandboxSourceOnly(intent, {
      mutationState, dispatchAllowed: true, nativeKernelBoundaryVerified: true,
      descendantsContained: true, revokeDrainVerified: true,
    });
    assert.equal(decision.status, 'RECONCILE_REQUIRED', String(mutationState));
    assert.equal(decision.mayReplayOriginalMutation, false);
    assert.equal(decision.dispatchAllowed, false);
    assert.equal(decision.cleanupVerified, false);
    assert.ok(decision.blockers.includes('MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'));
  }
});
test('AI-07 mutation accessor cannot be called to authorize replay', () => {
  let getterCalls = 0;
  const report = {
    get mutationState() { getterCalls++; throw new Error('hostile mutation getter'); },
  };
  const decision = assessTaskSandboxSourceOnly(intent, report);
  assert.equal(getterCalls, 0);
  assert.equal(decision.status, 'RECONCILE_REQUIRED');
  assert.equal(decision.mayReplayOriginalMutation, false);
});
test('AI-07 missing mutation report remains blocked without native admission', () => {
  const decision = assessTaskSandboxSourceOnly(intent, {
    kernelAttested: true, descendantsContained: true, revokeDrainVerified: true,
  });
  assert.equal(decision.status, 'BLOCKED');
  assert.equal(decision.dispatchAllowed, false);
});


test('AI-07 missing mutationState cannot hide lost ACK or uncertain native lifecycle markers', () => {
  const markerNames = [
    'ackLost', 'ack_lost', 'lostAck', 'outcomeUnknown',
    'launchUnknown', 'revokeUnknown', 'drainUnknown', 'operationAttempted',
  ] as const;
  for (const marker of markerNames) {
    for (const value of [false, true, undefined, null]) {
      const report = Object.defineProperty({}, marker, {
        value, configurable: true, enumerable: false,
      });
      const decision = assessTaskSandboxSourceOnly(intent, report);
      assert.equal(decision.status, 'RECONCILE_REQUIRED', marker);
      assert.equal(decision.dispatchAllowed, false);
      assert.equal(decision.mayReplayOriginalMutation, false);
      assert.equal(decision.cleanupVerified, false);
      assert.ok(decision.blockers.includes('MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'));
    }
  }
});

test('AI-07 ambiguous readback getters and throwing field reflection never permit replay', () => {
  let getterCalls=0;
  const report = Object.defineProperty({}, 'ackLost', {
    get(){getterCalls++;throw Error('malicious readback');},
  });
  const assessment=assessTaskSandboxSourceOnly(intent, report);
  assert.equal(assessment.status,'RECONCILE_REQUIRED');
  assert.equal(assessment.mayReplayOriginalMutation,false);
  assert.equal(assessment.nativeKernelBoundaryVerified,false);
  assert.equal(getterCalls,0);

  const proxy=new Proxy({},{
    getOwnPropertyDescriptor(_target,key){
      if(key==='ackLost')throw Error('hostile reflection');
      return undefined;
    },
  });
  const guarded=assessTaskSandboxSourceOnly(intent,proxy);
  assert.equal(guarded.status,'RECONCILE_REQUIRED');
  assert.equal(guarded.dispatchAllowed,false);
  assert.equal(guarded.mayReplayOriginalMutation,false);
});

test('AI-07 ordinary diagnostic readback without lifecycle signals remains unavailable', () => {
  const assessment=assessTaskSandboxSourceOnly(intent, {
    nativeVerified:true, descendantsContained:true, revokeDrainVerified:true,
  });
  assert.equal(assessment.status,'BLOCKED');
  assert.equal(assessment.dispatchAllowed,false);
  assert.equal(assessment.mayReplayOriginalMutation,false);
  assert.ok(assessment.blockers.includes('TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'));
});
