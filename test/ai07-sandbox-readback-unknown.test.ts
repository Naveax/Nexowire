import test from 'node:test';
import assert from 'node:assert/strict';
import {assessTaskSandboxSourceOnly} from '../src/agent/task-os-sandbox-policy.js';

// Deny-only source reports; no native launches or access to a live Agent.
const digest='a'.repeat(64);
const task={
  schema:1, platform:'linux', taskId:'readback1',
  originalRequestId:'original1', ownerId:'owner1', deviceId:'device1',
  grantId:'grant1', ownerEpoch:5, grantGeneration:4,
  executableDigest:digest, baseWorktreeSha:digest, workerPrivilege:'standard',
  args:[],envAllowlist:{},
  taskRoot:{canonicalPath:'/tmp/sandbox-selftest',volumeOrMountIdentity:'mount1',
    rootFileIdOrInode:'inode1'},
  network:{default:'deny',allowedEndpoints:[]},
  budgets:{cpuMs:1000,wallMs:2000,memoryBytes:65536,maxProcesses:2,
    outputBytes:4096,diskBytes:4096},
};

const uncertain=[
  'nativeReadbackUnknown', 'kernelReadbackUnknown', 'jobReadbackUnknown',
  'appContainerReadbackUnknown', 'pidfdReadbackUnknown',
  'cgroupReadbackUnknown', 'sandboxUnsupported',
  'descendantCleanupUnknown', 'handleLeakageUnknown',
  'environmentLeakageUnknown', 'pathIdentityUnknown',
  'permissionReadbackUnknown', 'ipcReadbackUnknown',
] as const;

test('AI-07 partial kernel/OS reports without mutationState require reconciliation',()=>{
  for(const field of uncertain){
    for(const value of [false,true,null,undefined]){
      const report=Object.defineProperty({
        descendantsContained:true,revokeDrainVerified:true,
        nativeKernelBoundaryVerified:true,dispatchAllowed:true,
      },field,{configurable:true,enumerable:false,value});
      const assessment=assessTaskSandboxSourceOnly(task,report);
      assert.equal(assessment.status,'RECONCILE_REQUIRED',field);
      assert.ok(assessment.blockers.includes(
        'MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'),field);
      assert.ok(assessment.blockers.includes(
        'TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'),field);
      assert.equal(assessment.dispatchAllowed,false,field);
      assert.equal(assessment.mayResumeSuspendedRoot,false,field);
      assert.equal(assessment.mayReplayOriginalMutation,false,field);
      assert.equal(assessment.cleanupVerified,false,field);
      assert.equal(assessment.nativeKernelBoundaryVerified,false,field);
    }
  }
});

test('AI-07 hostile unknown-readback accessors and proxy traps stay denied',()=>{
  let getterCalls=0;
  const report=Object.defineProperty({},'pidfdReadbackUnknown',{
    configurable:true,enumerable:false,
    get(){getterCalls++;throw Error('must not execute untrusted getter');},
  });
  const assessment=assessTaskSandboxSourceOnly(task,report);
  assert.equal(assessment.status,'RECONCILE_REQUIRED');
  assert.equal(assessment.mayReplayOriginalMutation,false);
  assert.equal(getterCalls,0);
  const trapped=new Proxy({},{
    getOwnPropertyDescriptor(_target,key){
      if(key==='kernelReadbackUnknown')throw Error('hostile OS report');
      return undefined;
    },
  });
  const guarded=assessTaskSandboxSourceOnly(task,trapped);
  assert.equal(guarded.status,'RECONCILE_REQUIRED');
  assert.equal(guarded.cleanupVerified,false);
  assert.equal(guarded.dispatchAllowed,false);
});

test('AI-07 ordinary diagnostics without lifecycle uncertainty stay BLOCKED',()=>{
  const assessment=assessTaskSandboxSourceOnly(task,{
    nativeVerified:true,descendantsContained:true,revokeDrainVerified:true,
  });
  assert.equal(assessment.status,'BLOCKED');
  assert.equal(assessment.dispatchAllowed,false);
  assert.equal(assessment.mayReplayOriginalMutation,false);
  assert.ok(assessment.blockers.includes('TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'));
  assert.ok(!assessment.blockers.includes('MUTATION_STATE_UNKNOWN_RECONCILE_REQUIRED'));
});
