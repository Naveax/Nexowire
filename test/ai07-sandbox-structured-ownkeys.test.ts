import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskSandboxSourceOnly } from '../src/agent/task-os-sandbox-policy.js';
import { executeTaskWithOsSandbox, OsTaskSandboxBlockedError } from '../src/agent/task-os-sandbox-worker.js';

const digest='a'.repeat(64);
function valid() {
  return {
    schema:1, platform:'linux', taskId:'t', originalRequestId:'r',
    ownerId:'owner', deviceId:'device', grantId:'grant', ownerEpoch:1,
    grantGeneration:1, executableDigest:digest, baseWorktreeSha:digest,
    workerPrivilege:'standard', args:['--version'], envAllowlist:{},
    taskRoot:{canonicalPath:'/tmp/task-root',volumeOrMountIdentity:'vol1',
      rootFileIdOrInode:'inode1'},
    network:{default:'deny',allowedEndpoints:[]},
    budgets:{cpuMs:1000,wallMs:2000,memoryBytes:65536,
      maxProcesses:2,outputBytes:4096,diskBytes:4096},
  };
}

test('AI-07 ordinary exact-schema intent stays well-formed but never receives execution', async () => {
  const decision=assessTaskSandboxSourceOnly(valid());
  assert.equal(decision.status,'BLOCKED');
  assert.equal(decision.dispatchAllowed,false);
  assert.equal(decision.nativeKernelBoundaryVerified,false);
  for(const key of ['INVALID_TASK_INTENT','NETWORK_MUST_BE_DEFAULT_DENY',
    'INVALID_RESOURCE_BUDGET','AMBIENT_ENVIRONMENT_FORBIDDEN'] as const) {
    assert.ok(!decision.blockers.includes(key),'valid source shape must not claim '+key);
  }
  assert.ok(decision.blockers.includes('TRUSTED_NATIVE_SANDBOX_PROVIDER_UNAVAILABLE'));
  await assert.rejects(executeTaskWithOsSandbox(valid()),
    (error:unknown)=>error instanceof OsTaskSandboxBlockedError);
});

test('AI-07 hidden, symbolic and unknown structured keys are invalid without evaluating getters', async () => {
  let getters=0;
  const hidden=(obj:object,key:string)=>{
    Object.defineProperty(obj,key,{enumerable:false,configurable:true,
      get(){getters++;throw Error('hidden getter must not execute');}});
  };
  const top=valid();
  hidden(top,'privilegedResumeToken');
  const root=valid();
  Object.defineProperty(root.taskRoot,Symbol('root-volume'),{
    enumerable:false,value:'external',configurable:true,
  });
  const net=valid();
  hidden(net.network,'defaultAllow');
  const budget=valid();
  hidden(budget.budgets,'infiniteQuota');
  const endpoints=valid();
  Object.defineProperty(endpoints.network.allowedEndpoints,Symbol('hidden-network-allow'),{
    enumerable:false,value:'127.0.0.1',configurable:true,
  });
  const ownKeysTrapped=valid();
  ownKeysTrapped.network=new Proxy(ownKeysTrapped.network,{
    ownKeys(){throw Error('untrusted ownKeys trap');},
  });
  const forged=Object.assign(valid(),{dispatchAllowed:true,proof:'synthetic'});
  const cases=[
    {name:'top-level hidden',intent:top,blocker:'INVALID_TASK_INTENT'},
    {name:'root symbol',intent:root,blocker:'INVALID_TASK_INTENT'},
    {name:'network hidden',intent:net,blocker:'NETWORK_MUST_BE_DEFAULT_DENY'},
    {name:'budgets hidden',intent:budget,blocker:'INVALID_RESOURCE_BUDGET'},
    {name:'endpoints symbol',intent:endpoints,blocker:'NETWORK_MUST_BE_DEFAULT_DENY'},
    {name:'network ownKeys trap',intent:ownKeysTrapped,blocker:'NETWORK_MUST_BE_DEFAULT_DENY'},
    {name:'forged top-level permit',intent:forged,blocker:'INVALID_TASK_INTENT'},
  ] as const;
  for(const c of cases){
    const assessment=assessTaskSandboxSourceOnly(c.intent);
    assert.equal(assessment.status,'BLOCKED',c.name);
    assert.equal(assessment.dispatchAllowed,false,c.name);
    assert.equal(assessment.mayReplayOriginalMutation,false,c.name);
    assert.ok(assessment.blockers.includes(c.blocker),c.name+' must be explicitly invalid');
    await assert.rejects(executeTaskWithOsSandbox(c.intent),
      (error:unknown)=>error instanceof OsTaskSandboxBlockedError &&
        error.safeBlueprint.assessment.blockers.includes(c.blocker));
  }
  assert.equal(getters,0,'never evaluate hidden adversarial getters');
});
