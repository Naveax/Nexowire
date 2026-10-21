import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  assertPrivateDesktopChildLaunchProvenance,
  assertPrivateDesktopEmergencyStopFence,
  PrivateDesktopOwnerFenceError,
  type PrivateDesktopLaunchIdentity,
  type PrivateDesktopKernelWitness,
  type PrivateDesktopChildLaunchReceipt,
  type PrivateDesktopChildKernelWitness,
  type PrivateDesktopEmergencyStopObservation,
} from '../src/agent/private-desktop-owner-fence.js';
import {assertNoObviousPrivateShellBrokerInvocation}
  from '../src/agent/windows-private-shell-broker-guard.js';

const requestId='11111111-1111-4111-8111-111111111111';
const owner=():PrivateDesktopLaunchIdentity=>({
  pid:42001,creationTime100ns:'134059294000000000',
  sessionId:7,desktopGeneration:'private-20261021-session07',
  ownerEpoch:4,guardianPid:42000,
  guardianCreationTime100ns:'134059293000000000',
  jobHandleId:'guardian-kernel-job-17',cancelEpoch:3,
});
const member=(o=owner()):PrivateDesktopKernelWitness=>({
  processPid:o.pid,processCreationTime100ns:o.creationTime100ns,
  processSessionId:o.sessionId,processDesktopName:'NexowirePrivate',
  guardianPid:o.guardianPid,guardianCreationTime100ns:o.guardianCreationTime100ns,
  jobHandleId:o.jobHandleId,isMemberOfGuardianJob:true,
  guardianJobVerified:true,collectorVerified:true,
  ownerEpoch:o.ownerEpoch,desktopGeneration:o.desktopGeneration,
  cancelEpoch:o.cancelEpoch,inputDesktop:'Default',processState:'running',
});
const child=():PrivateDesktopLaunchIdentity=>({
  ...owner(),pid:42030,creationTime100ns:'134059294000000050',
});
const receipt=():PrivateDesktopChildLaunchReceipt=>({
  child:child(),claimedParentPid:owner().pid,
  claimedParentCreationTime100ns:owner().creationTime100ns,
  requestId,desktopGeneration:owner().desktopGeneration,
});
const childWitness=():PrivateDesktopChildKernelWitness=>({
  ...member(child()),actualParentPid:owner().pid,
  actualParentCreationTime100ns:owner().creationTime100ns,
  observedLaunchRequestId:requestId,
});
const negative=(expected:PrivateDesktopOwnerFenceError['code'])=>
  (error:unknown)=>error instanceof PrivateDesktopOwnerFenceError&&
    error.code===expected;

test('forged child stdout exitCode=0 and PID report cannot replace OS parent proof',()=>{
  for(const forged of [
    {actualParentPid:99999},
    {actualParentCreationTime100ns:'134059294000000002'},
    {observedLaunchRequestId:'22222222-2222-4222-8222-222222222222'},
  ]){
    assert.throws(()=>assertPrivateDesktopChildLaunchProvenance(
      owner(),member(),receipt(),{...childWitness(),...forged}),
      negative('PRIVATE_DESKTOP_PROVENANCE_STALE'));
  }
});

test('same child PID with reused creation time or new Job is always denied',()=>{
  for(const change of [
    {processCreationTime100ns:'134059294000000070'},
    {jobHandleId:'guardian-kernel-job-18'},
    {processSessionId:9},
    {processDesktopName:'Default'},
    {isMemberOfGuardianJob:false},
    {collectorVerified:false},
  ]){
    assert.throws(()=>assertPrivateDesktopChildLaunchProvenance(
      owner(),member(),receipt(),{...childWitness(),...change}));
  }
});
test('untrusted launch receipt cannot rewrite parent, child epoch or requestId',()=>{
  const original=receipt();
  const bad=[
    {...original,claimedParentPid:8888},
    {...original,claimedParentCreationTime100ns:'134059294000000001'},
    {...original,child:{...original.child,pid:owner().pid}},
    {...original,child:{...original.child,ownerEpoch:owner().ownerEpoch+1}},
    {...original,child:{...original.child,cancelEpoch:owner().cancelEpoch+1}},
    {...original,child:{...original.child,jobHandleId:'other-job-id'}},
    {...original,child:{...original.child,creationTime100ns:'134059290000000000'}},
    {...original,requestId:'not-a-request-id'},
  ];
  for(const forged of bad)assert.throws(()=>
    assertPrivateDesktopChildLaunchProvenance(owner(),member(),forged,childWitness()));
});
test('guardian reset, job cancellation or insecure input cannot attest child',()=>{
  for(const parentWitness of [
    {...member(),ownerEpoch:5},
    {...member(),cancelEpoch:4},
    {...member(),guardianCreationTime100ns:'134059293000000001'},
    {...member(),inputDesktop:'Winlogon'},
    {...member(),isMemberOfGuardianJob:false},
  ]){
    assert.throws(()=>assertPrivateDesktopChildLaunchProvenance(
      owner(),parentWitness,receipt(),childWitness()));
  }
});
test('valid synthetic child proof is inert and not elevated launcher permission',()=>{
  const proof=assertPrivateDesktopChildLaunchProvenance(
    owner(),member(),receipt(),childWitness());
  assert.deepEqual(proof,{
    childPid:42030,childCreationTime100ns:'134059294000000050',
    result:'verified-source-only',
  });
  assert.equal(Object.isFrozen(proof),true);
  assert.equal('execute'in proof,false);
  assert.equal('uacApprove'in proof,false);
  assert.equal('processHandle'in proof,false);
});

const observation=():PrivateDesktopEmergencyStopObservation=>({
  ownerEpoch:4,cancelEpoch:3,emergencyStopPending:false,
  inputDesktop:'Default',pendingEffect:'none',requestId,
});
test('emergency stop cancels NEW GUI/child dispatch, no OS callback or replay',async()=>{
  const old=observation();
  const changed=[
    {...observation(),emergencyStopPending:true},
    {...observation(),cancelEpoch:4},
    {...observation(),ownerEpoch:5},
  ];
  let dispatched=0;
  for(const after of changed){
    // Simulated adapter dispatch is reached only after the fence allows it.
    await assert.rejects(async()=>{
      assertPrivateDesktopEmergencyStopFence(old,after);
      dispatched++;
    },negative('PRIVATE_DESKTOP_OWNER_REVOKED'));
  }
  assert.equal(dispatched,0);
  // A trusted cleanup is separate from an owner GUI action.
  assert.throws(()=>assertPrivateDesktopEmergencyStopFence(
    {...old,emergencyStopPending:true},observation()),
    negative('PRIVATE_DESKTOP_OWNER_REVOKED'));
});
test('in-flight native side effect yields UNKNOWN not completed or auto replay',()=>{
  for(const progress of ['native-write-in-flight','unknown'] as const){
    assert.throws(()=>assertPrivateDesktopEmergencyStopFence(
      observation(),{...observation(),pendingEffect:progress}),
      negative('PRIVATE_DESKTOP_PROVENANCE_STALE'));
  }
});
test('Winlogon/secure-desktop transition and forged requestId cannot be clicked',()=>{
  for(const desktop of ['Winlogon','SecureDesktop','','NexowirePrivate']){
    assert.throws(()=>assertPrivateDesktopEmergencyStopFence(
      observation(),{...observation(),inputDesktop:desktop}),
      negative('PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE'));
  }
  assert.throws(()=>assertPrivateDesktopEmergencyStopFence(
    observation(),{...observation(),
      requestId:'22222222-2222-4222-8222-222222222222'}),
    negative('PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE'));
});
test('two clean source observations never authorize a native write or UAC',()=>{
  const gate=assertPrivateDesktopEmergencyStopFence(observation(),observation());
  assert.equal(gate.kind,'source-only-mutation-gate');
  assert.ok(Object.isFrozen(gate));
  assert.equal('spawn'in gate,false);
  assert.equal('stopProcess'in gate,false);
});
test('indirect COM/Explorer/WSL GUI brokers stay denied after cancellation',()=>{
  for(const [exe,args] of [
    ['powershell.exe',['-Command','New-Object -ComObject Shell.Application']],
    ['cmd.exe',['/C','call regsvr32.exe /s forged.dll']],
    ['cmd.exe',['/C','wt.exe -w 0']],
    ['cmd.exe',['/C','wsl.exe --exec explorer.exe']],
  ] as const)assert.throws(
    ()=>assertNoObviousPrivateShellBrokerInvocation(exe,args),
    e=>e instanceof Error&&'code'in e&&e.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
  );
});
test('real private desktop has no provenance stop hook (production remains NO-GO)',async()=>{
  const src=await readFile(new URL('../src/agent/windows-private-desktop.ts',
    import.meta.url),'utf8');
  const section=src.match(/async function killTree\(pid:number\)[\s\S]*?(?=async function stop\(\))/)?.[0];
  assert.ok(section);
  assert.match(section,/taskkill\.exe/);
  assert.doesNotMatch(section,/assertPrivateDesktopChildLaunchProvenance|assertPrivateDesktopEmergencyStopFence|verifyPrivateDesktopOwnerFence/);
});
