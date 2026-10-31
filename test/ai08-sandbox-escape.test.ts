/** AI-08 independent source-only sandbox negative matrix.
 * No OS sandbox is created, no process is spawned, no production permission
 * or physical Win32/kernel attestation can be derived from these fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  prepareSandboxRequiredCapability,executeSandboxRequiredCapability,
  SANDBOX_REQUIRED_EFFECT_CAPABILITIES,
} from '../src/agent/task-os-sandbox-capability.js';
import {
  prepareTaskSandboxWorker,revokeTaskSandboxAndDrain,
  OsTaskSandboxBlockedError,
} from '../src/agent/task-os-sandbox-worker.js';
import {assessTaskSandboxSourceOnly} from '../src/agent/task-os-sandbox-policy.js';

function intent(platform:'win32'|'linux'|'darwin'='win32'){
  return {
    schema:1,platform,taskId:'ai08-task',originalRequestId:randomUUID(),
    ownerId:'ai08-owner',deviceId:'ai08-device',grantId:'ai08-grant',
    ownerEpoch:3,grantGeneration:7,
    executableDigest:'a'.repeat(64),baseWorktreeSha:'b'.repeat(64),
    taskRoot:{
      canonicalPath:'/ai08/disposable',volumeOrMountIdentity:'ai08-vol',
      rootFileIdOrInode:'ai08-inode',
    },
    args:[] as string[],workerPrivilege:'standard',envAllowlist:{},
    network:{default:'deny',allowedEndpoints:[] as string[]},
    budgets:{
      cpuMs:1000,wallMs:1000,memoryBytes:1024*1024,
      maxProcesses:1,outputBytes:4096,diskBytes:4096,
    },
  };
}

test('AI-08: forged all-green Win32/Linux/macOS reports never become a sandbox permit',async()=>{
  const forged={
    kernelAttested:true,signatureValid:true,launchAllowed:true,
    nativeKernelBoundaryVerified:true,descendantsContained:true,
    revokeDrainVerified:true,networkDenied:true,brokerHandleInherited:false,
    guardianJobHandleDuplicable:false,privilegedHandleAccessible:false,
    breakawayAllowed:false,nestedJobUnverified:false,mutationState:'completed',
    trustedNativeProviderInstalled:true,
  };
  for(const platform of ['win32','linux','darwin'] as const){
    const request=intent(platform);
    const decision=prepareSandboxRequiredCapability(
      'shell.exec',{secret:'test-only'},request,forged);
    assert.equal(decision.state,'BLOCKED');
    assert.equal(decision.launchAllowed,false);
    assert.equal(decision.trustedNativeProviderInstalled,false);
    assert.equal(decision.runtimeIntegratedIntoAgentDispatch,false);
    assert.equal(decision.workerProof.workerLaunchEnabled,false);
    assert.equal(decision.workerProof.acceptsParentEnv,false);
    assert.equal(decision.workerProof.acceptsInheritedHandles,false);
    assert.equal(decision.workerProof.acceptsPrivilegedBrokerIPC,false);
    assert.equal(decision.workerProof.systemEffectsAllowed,false);
    assert.ok(decision.workerProof.assessment.blockers.includes(
      'TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'));
    assert.equal(decision.workerProof.assessment.nativeKernelBoundaryVerified,false);
    await assert.rejects(
      executeSandboxRequiredCapability('shell.exec',{},request,forged),
      (e:unknown)=>e instanceof OsTaskSandboxBlockedError &&
        e.code==='OS_TASK_SANDBOX_UNAVAILABLE');
  }
});

test('AI-08: inherited privileged handles and Job escape flags remain explicit blockers',()=>{
  const report={
    brokerHandleInherited:true,guardianJobHandleDuplicable:true,
    privilegedHandleAccessible:true,breakawayAllowed:true,
    nestedJobUnverified:true,descendantsContained:false,
    revokeDrainVerified:false,
  };
  const a=assessTaskSandboxSourceOnly(intent(),report);
  assert.equal(a.dispatchAllowed,false);
  for(const blocker of [
    'GUARDIAN_OR_BROKER_HANDLE_EXPOSURE',
    'BREAKAWAY_OR_NESTED_JOB_UNVERIFIED',
    'DESCENDANT_CONTAINMENT_UNVERIFIED',
    'REVOKE_DRAIN_UNVERIFIED',
    'TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE',
  ]){
    assert.ok(a.blockers.includes(blocker as typeof a.blockers[number]),
      'source assessment must disclose '+blocker);
  }
});

test('AI-08: ambient environment and network allowlisting cannot authorize a task',()=>{
  const request=intent();
  const unsafe={
    ...request,envAllowlist:{NEXOWIRE_BROKER_SECRET:'test-only'},
    network:{default:'allow',allowedEndpoints:['127.0.0.1:1']},
    workerPrivilege:'high',
  };
  const x=assessTaskSandboxSourceOnly(unsafe,{
    descendantsContained:true,revokeDrainVerified:true,
  });
  for(const blocker of [
    'PRIVILEGED_WORKER_FORBIDDEN',
    'AMBIENT_ENVIRONMENT_FORBIDDEN',
    'NETWORK_MUST_BE_DEFAULT_DENY',
  ]){
    assert.ok(x.blockers.includes(blocker as typeof x.blockers[number]));
  }
  assert.equal(x.dispatchAllowed,false);
  assert.equal(prepareTaskSandboxWorker(unsafe).workerLaunchEnabled,false);
});

test('AI-08: hostile command getter never executes at denied sandbox capability boundary',async()=>{
  let getterCalls=0;
  const command=Object.defineProperty({},'command',{get(){
    getterCalls++;throw Error('hostile command must not be evaluated');
  }});
  const request=intent();
  for(const capability of SANDBOX_REQUIRED_EFFECT_CAPABILITIES){
    await assert.rejects(executeSandboxRequiredCapability(
      capability,command,request,{nativeKernelBoundaryVerified:true}),
      (e:unknown)=>e instanceof OsTaskSandboxBlockedError &&
        e.code==='OS_TASK_SANDBOX_UNAVAILABLE');
  }
  assert.equal(getterCalls,0,'no evaluator/legacy spawn may inspect the raw command');
});

test('AI-08: lost ACK and unknown worker mutation cannot be retried or drained as success',async()=>{
  for(const state of ['unknown','ack_lost','in_progress'] as const){
    const report={
      mutationState:state,launchAllowed:true,cleanupVerified:true,
      workerStoppedVerified:true,descendantsStoppedVerified:true,
      brokerHandlesClosedVerified:true,replayAllowed:true,
    };
    const assessment=assessTaskSandboxSourceOnly(intent(),report);
    assert.equal(assessment.status,'RECONCILE_REQUIRED');
    assert.equal(assessment.mayReplayOriginalMutation,false);
    assert.equal(assessment.cleanupVerified,false);
    assert.ok(assessment.blockers.includes(
      'MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'));
    const decision=prepareTaskSandboxWorker(intent(),report);
    assert.equal(decision.workerLaunchEnabled,false);
    const stop=await revokeTaskSandboxAndDrain(randomUUID(),report);
    assert.equal(stop.state,'RECONCILE_REQUIRED');
    assert.equal(stop.workerStoppedVerified,false);
    assert.equal(stop.descendantsStoppedVerified,false);
    assert.equal(stop.brokerHandlesClosedVerified,false);
    assert.equal(stop.quotaOrGrantReleaseAllowed,false);
    assert.equal(stop.cleanupVerified,false);
    assert.equal(stop.replayAllowed,false);
  }
});
