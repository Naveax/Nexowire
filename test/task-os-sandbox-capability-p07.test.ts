import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  SANDBOX_REQUIRED_EFFECT_CAPABILITIES,
  prepareSandboxRequiredCapability,
  executeSandboxRequiredCapability,
} from '../src/agent/task-os-sandbox-capability.js';
import {OsTaskSandboxBlockedError} from '../src/agent/task-os-sandbox-worker.js';

const hash='a'.repeat(64);
const intent={
  schema:1,platform:'win32',taskId:'task1',originalRequestId:'req1',
  ownerId:'owner1',ownerEpoch:1,deviceId:'dev1',grantId:'grant1',
  grantGeneration:1,executableDigest:hash,baseWorktreeSha:hash,
  workerPrivilege:'standard',args:[],envAllowlist:{},
  taskRoot:{canonicalPath:'C:\\tasks',volumeOrMountIdentity:'disk1',rootFileIdOrInode:'file1'},
  network:{default:'deny',allowedEndpoints:[]},
  budgets:{cpuMs:1000,wallMs:2000,memoryBytes:65536,
    maxProcesses:2,outputBytes:1024,diskBytes:4096},
};

test('#07 maps all process effect routes to a deny-only worker boundary',async()=>{
  const expected=['shell.exec','wsl.exec','process.start','task.graph.run',
    'runbook.run','workspace.checks','workspace.snapshot'];
  assert.deepEqual([...SANDBOX_REQUIRED_EFFECT_CAPABILITIES],expected);
  for(const cap of expected){
    const decision=prepareSandboxRequiredCapability(cap,{command:'whoami'},intent);
    assert.equal(decision.capability,cap);
    assert.equal(decision.launchAllowed,false);
    assert.equal(decision.mayFallbackToLegacySpawn,false);
    assert.equal(decision.runtimeIntegratedIntoAgentDispatch,false);
    assert.equal(decision.trustedNativeProviderInstalled,false);
    assert.ok(Object.isFrozen(decision));
    await assert.rejects(executeSandboxRequiredCapability(cap,{command:'whoami'},intent),
      (e:unknown)=>e instanceof OsTaskSandboxBlockedError &&
        e.code==='OS_TASK_SANDBOX_UNAVAILABLE');
  }
});

test('#07 hostile command getters and fake source receipts never run',async()=>{
  let effects=0;
  const input=Object.create(null);
  Object.defineProperty(input,'command',{get(){effects++;throw new Error('getter called');}});
  const forged={dispatchAllowed:true,signatureValid:true,nativeVerified:true,
    descendantsContained:true,revokeDrainVerified:true,
    spawn(){effects++;},execute(){effects++;},resume(){effects++;}};
  assert.equal(prepareSandboxRequiredCapability('shell.exec',input,intent,forged).launchAllowed,false);
  await assert.rejects(executeSandboxRequiredCapability('shell.exec',input,intent,forged),
    (e:unknown)=>e instanceof OsTaskSandboxBlockedError);
  assert.equal(effects,0);
});

test('#07 unknown capability and malformed task scope never get a permit',async()=>{
  for(const cap of ['shell.execute','',null,undefined,{name:'shell.exec'}]){
    const d=prepareSandboxRequiredCapability(cap,{},null,{nativeVerified:true});
    assert.equal(d.capability,'unknown-effect');
    assert.equal(d.launchAllowed,false);
    assert.equal(d.workerProof.assessment.nativeKernelBoundaryVerified,false);
    await assert.rejects(executeSandboxRequiredCapability(cap,{},null),
      (e:unknown)=>e instanceof OsTaskSandboxBlockedError);
  }
});

test('#07 UNKNOWN/lost ACK never auto-replays nested task or runbook execution',async()=>{
  for(const state of ['unknown','ack_lost','in_progress']){
    for(const cap of ['task.graph.run','runbook.run','shell.exec']){
      const d=prepareSandboxRequiredCapability(cap,{},intent,
        {mutationState:state,replayAllowed:true,signatureValid:true});
      assert.equal(d.state,'RECONCILE_REQUIRED');
      assert.equal(d.canRetryAfterUnknown,false);
      assert.equal(d.workerProof.assessment.mayReplayOriginalMutation,false);
      await assert.rejects(executeSandboxRequiredCapability(cap,{},intent,{mutationState:state}),
        (e:unknown)=>e instanceof OsTaskSandboxBlockedError &&
          e.code==='OS_TASK_RECONCILIATION_REQUIRED');
    }
  }
});

test('#07 adapter has no spawn, native I/O, callback injection or shell fallback',()=>{
  const src=readFileSync(new URL('../src/agent/task-os-sandbox-capability.ts',import.meta.url),'utf8');
  assert.doesNotMatch(src,/from\s*['"]node:(?:child_process|net|fs|dgram|worker_threads)['"]/);
  assert.doesNotMatch(src,/\b(?:spawn|spawnSync|execFile|execSync|fork|system)\s*\(/);
  assert.match(src,/throw new OsTaskSandboxBlockedError\(/);
});

test('#07 records real effect capability cases without treating unsafe spawn as proof',()=>{
  const src=readFileSync(new URL('../src/agent/executors.ts',import.meta.url),'utf8');
  for(const cap of ['shell.exec','wsl.exec','process.start','task.graph.run',
    'runbook.run','workspace.checks','workspace.snapshot']){
    assert.ok(src.includes("case '"+cap+"':"),cap);
    assert.equal(prepareSandboxRequiredCapability(cap,{},intent).launchAllowed,false);
  }
});

// TODO is intentionally visible in CI but never described as a passing
// physical negative. #03 owns actual dispatch integration and must bring a
// real native provider readback and cross-platform adversarial acceptance.
test.todo('#03: guard every real shell/process/task effect before legacy spawn');
test.todo('#02/#07: independent native low-privilege, file/network/IPC, descendant and revoke proof');
